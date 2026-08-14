import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { PROVIDER_ID, DEFAULT_MODEL } from "./constants"
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
import { toKiroRequest, kiroToAnthropicStream, mapKiroError } from "./transform"
import { getProfileArn } from "./profile"
import { resolveContextLimit } from "./limits"
import { createTools } from "./tools"

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
            const accessToken = await getAccessToken()
            const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {}
            const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL

            const effort = new Headers(init?.headers).get(EFFORT_HEADER) ?? undefined

            const profileArn = await getProfileArn(accessToken)
            const request = toKiroRequest(body, accessToken, profileArn, effort)
            const response = await fetch(request.url, request.init)

            if (!response.ok) {
              // Reshape known Kiro errors (e.g. content-length overflow) into an actionable
              // message; opencode persists the raw body in its session store for anything else.
              const detail = await response.text().catch(() => "")
              const mapped = mapKiroError(detail, response.status)
              return new Response(mapped.body, {
                status: mapped.status,
                headers: { "content-type": "application/json" },
              })
            }

            // Context window is read from the live opencode config so the synthesized usage
            // percentage matches what opencode shows.
            const contextLimit = await resolveContextLimit(input.client, PROVIDER_ID, model)
            return kiroToAnthropicStream(response, model, contextLimit)
          },
        }
      },
    },
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
