import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import { API_PROVIDER_ID, PROVIDER_ID, DEFAULT_MODEL, resolveRateLimitRetryAfter } from "./constants"
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
import { generateAssistantResponse, type KiroClientDependencies } from "./client"
import { createSession, type KiroSession } from "./session"
import { toKiroPayload, kiroToAnthropicStream, mapKiroError, preflightKiroResponse } from "./transform"
import { resolveContextLimit } from "./limits"
import { createTools, type KiroToolContext } from "./tools"
import { createKiroDebugContext, kiroDebug, redactKiroSecrets } from "./debug"

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

type SessionReader = () => Promise<KiroSession>

const sessionReadersByPlugin = new WeakMap<PluginInput, Map<string, SessionReader>>()

function sessionReaders(input: PluginInput): Map<string, SessionReader> {
  let readers = sessionReadersByPlugin.get(input)
  if (!readers) {
    readers = new Map()
    sessionReadersByPlugin.set(input, readers)
  }
  return readers
}

function readSession(input: PluginInput, providerId: string): Promise<KiroSession> {
  const read = sessionReaders(input).get(providerId)
  if (!read) {
    throw new KiroAuthError(
      `Kiro credentials are not loaded for ${providerId}. ` +
        `Run \`opencode auth login --provider ${providerId}\` and use a ${providerId} model first.`,
    )
  }
  return read()
}

async function providerForToolCall(input: PluginInput, context: KiroToolContext): Promise<string> {
  const response = await input.client.session.message({
    path: { id: context.sessionID, messageID: context.messageID },
    query: { directory: context.directory },
  })
  const body = (response as any)?.data ?? response
  const info = body?.info
  const providerId = info?.providerID ?? info?.model?.providerID
  if (providerId !== PROVIDER_ID && providerId !== API_PROVIDER_ID) {
    throw new KiroAuthError("Kiro web_search could not determine the active Kiro provider.")
  }
  return providerId
}

function createKiroPlugin(
  providerId: string,
  mode: "oauth" | "api",
  dependencies: KiroClientDependencies = {},
) {
  return async function plugin(input: PluginInput): Promise<Hooks> {
    if (mode === "api") {
      sessionReaders(input).set(providerId, async () =>
        createSession(undefined, undefined, { mode: "api", fetch: dependencies.fetch }),
      )
    }

    const persistCredential = async (credential: OAuthCredential) => {
      const response = await input.client.auth.set({
        path: { id: providerId },
        body: credential,
      })
      if ((response as any)?.error) {
        throw new KiroAuthError("Kiro token refreshed, but OpenCode could not persist the new credential.")
      }
    }

    return {
      tool:
        mode === "api"
          ? createTools(
              async (context) => readSession(input, await providerForToolCall(input, context)),
              dependencies,
            )
          : undefined,
      config: async (config) => {
        if (mode === "api") {
          mirrorProviderConfig(config, PROVIDER_ID, providerId)
          installApiKeyEnvTransport(config, providerId, input, dependencies)
        }
      },
      "chat.headers": async (ctx, output) => {
        const model = ctx.model as RuntimeModel
        const selected = (ctx.message as unknown as RuntimeMessage).model
        if (model.providerID !== providerId) return
        if (selected.providerID !== model.providerID || selected.modelID !== model.id) return

        const effort = selected.variant
        if (typeof effort !== "string" || !Object.prototype.hasOwnProperty.call(model.variants ?? {}, effort)) return
        output.headers[EFFORT_HEADER] = effort
      },
      auth: {
        provider: providerId,
        methods:
          mode === "api"
            ? [
                {
                  type: "api" as const,
                  label: "Kiro API key",
                },
              ]
            : [
                {
                  type: "oauth" as const,
                  label: "AWS Builder ID (device flow)",
                  authorize: async () => deviceAuthorization({ authMethod: "builder-id" }),
                },
                {
                  type: "oauth" as const,
                  label: "IAM Identity Center (device flow)",
                  prompts: [
                    {
                      type: "text" as const,
                      key: "startUrl",
                      message: "IAM Identity Center start URL",
                      placeholder: "https://mycompany.awsapps.com/start",
                      validate: validationMessage(normalizeStartUrl),
                    },
                    {
                      type: "text" as const,
                      key: "region",
                      message: "IAM Identity Center region",
                      placeholder: "us-east-1",
                      validate: validationMessage(normalizeRegion),
                    },
                  ],
                  authorize: async (values: Record<string, string> = {}) =>
                    deviceAuthorization({
                      authMethod: "idc",
                      startUrl: values.startUrl ?? "",
                      region: values.region ?? "",
                    }),
                },
              ],
        loader: async (readCredential) => {
          const credentials = new KiroCredentialManager(readCredential, persistCredential)
          sessionReaders(input).set(providerId, async () =>
            createSession(await readCredential(), credentials, { mode, fetch: dependencies.fetch }),
          )
          return {
            apiKey: "",
            fetch: createKiroFetch(
              providerId,
              mode,
              input,
              () => readSession(input, providerId),
              dependencies,
            ),
          }
        },
      },
    }
  }
}

function installApiKeyEnvTransport(
  config: Config,
  providerId: string,
  input: PluginInput,
  dependencies: KiroClientDependencies,
): void {
  const provider = config.provider?.[providerId] as Record<string, any> | undefined
  if (!provider) return
  const options = { ...(provider.options ?? {}) }
  if (options.apiKey === undefined) options.apiKey = ""
  if (!options.fetch) {
    options.fetch = createKiroFetch(
      providerId,
      "api",
      input,
      () => readSession(input, providerId),
      dependencies,
    )
  }
  provider.options = options
}

export function createKiroFetch(
  providerId: string,
  mode: "oauth" | "api",
  input: PluginInput,
  getSession: SessionReader,
  dependencies: KiroClientDependencies = {},
) {
  return async function kiroFetch(_input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const debug = createKiroDebugContext()
    const active = await getSession()
    const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {}
    const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL

    const effort = new Headers(init?.headers).get(EFFORT_HEADER) ?? undefined
    kiroDebug(debug, "request.received", {
      provider: providerId,
      authMode: mode,
      model,
      effort: effort ?? null,
      anthropicRequestBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    })

    const payload = toKiroPayload(body, effort, debug)
    const response = await generateAssistantResponse(payload, active, { debug, ...dependencies })
    kiroDebug(debug, "response.received", {
      status: response.status,
      statusText: response.statusText,
      headers: responseDebugHeaders(response.headers),
    })

    if (!response.ok) {
      const detail = redactKiroSecrets(await response.text().catch(() => ""))
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
      return new Response(mapped.body, { status: mapped.status, headers })
    }

    const streamResponse = await preflightKiroResponse(response, debug)
    if (!streamResponse.ok) {
      kiroDebug(debug, "response.preflight_error", { status: streamResponse.status })
      return streamResponse
    }

    const contextLimit = await resolveContextLimit(input.client, providerId, model)
    kiroDebug(debug, "response.preflight_ok", { contextLimit })
    return kiroToAnthropicStream(streamResponse, model, contextLimit, debug)
  }
}

export const KiroAuthPlugin = createKiroPlugin(PROVIDER_ID, "oauth")

export const KiroApiKeyPlugin = createKiroPlugin(API_PROVIDER_ID, "api")

function mirrorProviderConfig(config: Config, sourceId: string, targetId: string): void {
  const providers = (config.provider ?? {}) as Record<string, Record<string, unknown>>
  const source = providers[sourceId]
  if (!source) return

  const existing = providers[targetId]
  const mirrored: Record<string, unknown> = {
    ...source,
    name: `${source.name ?? "Kiro"} (API key)`,
    ...existing,
  }
  mirrored.options = {
    ...((source.options as Record<string, unknown> | undefined) ?? {}),
    ...((existing?.options as Record<string, unknown> | undefined) ?? {}),
  }

  config.provider = { ...providers, [targetId]: mirrored } as Config["provider"]
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
      message:
        typeof value.message === "string" ? redactKiroSecrets(value.message.slice(0, 500)) : undefined,
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
