import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { PROVIDER_ID, DEFAULT_MODEL, resolveRateLimitRetryAfter } from "./constants"
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  KiroAuthError,
  KiroCredentialManager,
  normalizeRegion,
  normalizeStartUrl,
  type DeviceLogin,
  type OAuthCredential,
  type PendingDeviceAuthorization,
} from "./auth"
import { toKiroRequest, kiroToAnthropicStream, mapKiroError, preflightKiroResponse } from "./transform"
import { getProfileArn } from "./profile"
import { resolveContextLimit } from "./limits"
import { createTools } from "./tools"
import { createKiroDebugContext, kiroDebug, kiroDebugError } from "./debug"

/** Internal header carrying a validated opencode variant to the fetch interceptor as Kiro effort. */
const EFFORT_HEADER = "x-kiro-effort"

type RuntimeModel = {
  id: string
  providerID: string
  variants?: Record<string, unknown>
}

type RuntimeMessage = {
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
}

/**
 * opencode plugin that authenticates directly with AWS Builder ID or IAM Identity
 * Center. OpenCode owns the resulting credential; no kiro-cli installation or
 * credential store is involved.
 */
export async function KiroAuthPlugin(input: PluginInput): Promise<Hooks> {
  let credentials: KiroCredentialManager | undefined
  const getAccessToken = () => {
    if (!credentials) {
      throw new KiroAuthError(
        "Kiro credentials are not loaded. Run `opencode auth login --provider kiro` and use a Kiro model first.",
      )
    }
    return credentials.getAccessToken()
  }

  const persistCredential = async (credential: OAuthCredential) => {
    const response = await input.client.auth.set({
      path: { id: PROVIDER_ID },
      body: credential,
    })
    if ((response as any)?.error) {
      throw new KiroAuthError("Kiro token refreshed, but OpenCode could not persist the new credential.")
    }
  }

  return {
    tool: createTools(getAccessToken),
    "chat.headers": async (ctx, output) => {
      const model = ctx.model as RuntimeModel
      const selected = (ctx.message as unknown as RuntimeMessage).model
      if (model.providerID !== PROVIDER_ID) return
      if (selected.providerID !== model.providerID || selected.modelID !== model.id) return

      const effort = selected.variant
      if (typeof effort !== "string" || !Object.prototype.hasOwnProperty.call(model.variants ?? {}, effort)) return
      output.headers[EFFORT_HEADER] = effort
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "AWS Builder ID (device flow)",
          authorize: async () => deviceAuthorization({ authMethod: "builder-id" }),
        },
        {
          type: "oauth",
          label: "IAM Identity Center (device flow)",
          prompts: [
            {
              type: "text",
              key: "startUrl",
              message: "IAM Identity Center start URL",
              placeholder: "https://mycompany.awsapps.com/start",
              validate: validationMessage(normalizeStartUrl),
            },
            {
              type: "text",
              key: "region",
              message: "IAM Identity Center region",
              placeholder: "us-east-1",
              validate: validationMessage(normalizeRegion),
            },
          ],
          authorize: async (values = {}) =>
            deviceAuthorization({
              authMethod: "idc",
              startUrl: values.startUrl ?? "",
              region: values.region ?? "",
            }),
        },
      ],
      loader: async (readCredential) => {
        credentials = new KiroCredentialManager(readCredential, persistCredential)
        return {
          apiKey: "",
          async fetch(_input: Parameters<typeof fetch>[0], init?: RequestInit) {
            const debug = createKiroDebugContext()
            const accessToken = await getAccessToken()
            const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {}
            const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL

            const effort = new Headers(init?.headers).get(EFFORT_HEADER) ?? undefined
            kiroDebug(debug, "request.received", {
              model,
              effort: effort ?? null,
              anthropicRequestBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0,
              messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
              toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
            })

            const profileArn = await getProfileArn(accessToken)
            kiroDebug(debug, "profile.resolved", { hasProfile: Boolean(profileArn) })
            const request = toKiroRequest(body, accessToken, profileArn, effort, debug)
            kiroDebug(debug, "request.fetch_start", { url: request.url })
            let response: Response
            try {
              response = await fetch(request.url, request.init)
            } catch (error) {
              kiroDebug(debug, "request.fetch_error", kiroDebugError(error))
              throw error
            }
            kiroDebug(debug, "response.received", {
              status: response.status,
              statusText: response.statusText,
              headers: responseDebugHeaders(response.headers),
            })

            if (!response.ok) {
              // Reshape known Kiro errors (e.g. content-length overflow) into an actionable
              // message; opencode persists the raw body in its session store for anything else.
              const detail = await response.text().catch(() => "")
              const mapped = mapKiroError(detail, response.status)
              kiroDebug(debug, "response.http_error", {
                upstreamStatus: response.status,
                mappedStatus: mapped.status,
                bodyBytes: Buffer.byteLength(detail),
                error: responseErrorShape(detail),
              })
              const headers = new Headers({ "content-type": "application/json" })
              const retryAfter =
                mapped.status === 429
                  ? resolveRateLimitRetryAfter(response.headers.get("retry-after"))
                  : response.headers.get("retry-after")
              if (retryAfter) headers.set("retry-after", retryAfter)
              return new Response(mapped.body, {
                status: mapped.status,
                headers,
              })
            }

            const streamResponse = await preflightKiroResponse(response, debug)
            if (!streamResponse.ok) {
              kiroDebug(debug, "response.preflight_error", { status: streamResponse.status })
              return streamResponse
            }

            // Context window is read from the live opencode config so the synthesized usage
            // percentage matches what opencode shows.
            const contextLimit = await resolveContextLimit(input.client, PROVIDER_ID, model)
            kiroDebug(debug, "response.preflight_ok", { contextLimit })
            return kiroToAnthropicStream(streamResponse, model, contextLimit, debug)
          },
        }
      },
    },
  }
}

function responseDebugHeaders(headers: Headers): Record<string, string> {
  const selected = [
    "content-type",
    "content-length",
    "x-amzn-requestid",
    "x-amzn-request-id",
    "x-amz-request-id",
    "x-amzn-trace-id",
  ]
  return Object.fromEntries(selected.flatMap((name) => (headers.has(name) ? [[name, headers.get(name) ?? ""]] : [])))
}

function responseErrorShape(detail: string): Record<string, unknown> {
  try {
    const value = JSON.parse(detail) as Record<string, unknown>
    return {
      keys: Object.keys(value).sort(),
      reason: typeof value.reason === "string" ? value.reason : undefined,
      type: typeof value.type === "string" ? value.type : undefined,
      message: typeof value.message === "string" ? value.message.slice(0, 500) : undefined,
    }
  } catch {
    return { parseable: false }
  }
}

function validationMessage(normalize: (value: string) => string): (value: string) => string | undefined {
  return (value) => {
    try {
      normalize(value)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

async function deviceAuthorization(login: DeviceLogin) {
  const pending = await beginDeviceAuthorization(login)
  return deviceAuthorizationResult(pending)
}

function deviceAuthorizationResult(pending: PendingDeviceAuthorization) {
  const expiresInMinutes = Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 60_000))
  return {
    url: pending.verificationUriComplete ?? pending.verificationUri,
    instructions: `Enter code ${pending.userCode} and approve access. The code expires in ${expiresInMinutes} minutes.`,
    method: "auto" as const,
    callback: async () => {
      const credential = await completeDeviceAuthorization(pending)
      return {
        type: "success" as const,
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
      }
    },
  }
}
