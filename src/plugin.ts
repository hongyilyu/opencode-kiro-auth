import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import { API_PROVIDER_ID, PROVIDER_ID, DEFAULT_MODEL } from "./constants"
import { readApiKeyFromEnv } from "./apikey"
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  KiroAuthError,
  KiroCredentialManager,
  normalizeRegion,
  normalizeStartUrl,
  type AuthDependencies,
  type DeviceLogin,
  type OAuthCredential,
  type PendingDeviceAuthorization,
} from "./auth"
import { generateAssistantResponse, type KiroClientDependencies } from "./client"
import { createSession, type KiroSession } from "./session"
import { toKiroPayload } from "./request"
import { anthropicErrorResponse, kiroResponseToAnthropic } from "./response"
import { resolveContextLimit, sdkData, sdkFailed } from "./limits"
import { createTools, type KiroToolContext } from "./tools"
import { createKiroDebugContext, kiroDebug } from "./debug"

/** Internal header carrying a validated opencode variant to the fetch interceptor as Kiro effort. */
const EFFORT_HEADER = "x-kiro-effort"

type AuthMode = "oauth" | "api"

/** Everything the plugin touches outside itself: transport and clock. Tests inject; production defaults. */
export type KiroPluginDependencies = KiroClientDependencies & AuthDependencies

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
  const info = (sdkData(response) as any)?.info
  const providerId = info?.providerID ?? info?.model?.providerID
  if (providerId !== PROVIDER_ID && providerId !== API_PROVIDER_ID) {
    throw new KiroAuthError("Kiro web_search could not determine the active Kiro provider.")
  }
  return providerId
}

export function createKiroPlugin(providerId: string, mode: AuthMode, dependencies: KiroPluginDependencies = {}) {
  return async function plugin(input: PluginInput): Promise<Hooks> {
    if (mode === "api") {
      sessionReaders(input).set(providerId, apiSessionReader(async () => undefined, dependencies))
    }

    const persistCredential = async (credential: OAuthCredential) => {
      const response = await input.client.auth.set({
        path: { id: providerId },
        body: credential,
      })
      if (sdkFailed(response)) {
        throw new KiroAuthError("Kiro token refreshed, but OpenCode could not persist the new credential.")
      }
    }

    return {
      tool:
        mode === "api"
          ? createTools(async (context) => readSession(input, await providerForToolCall(input, context)))
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
                  authorize: async () => deviceAuthorization({ authMethod: "builder-id" }, dependencies),
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
                    deviceAuthorization(
                      { authMethod: "idc", startUrl: values.startUrl ?? "", region: values.region ?? "" },
                      dependencies,
                    ),
                },
              ],
        loader: async (readCredential) => {
          sessionReaders(input).set(
            providerId,
            mode === "api"
              ? apiSessionReader(readCredential, dependencies)
              : oauthSessionReader(readCredential, persistCredential, dependencies),
          )
          return {
            apiKey: "",
            fetch: createKiroFetch(providerId, input, () => readSession(input, providerId), dependencies),
          }
        },
      },
    }
  }
}

/** The environment fallback is read here, per request, so session.ts stays pure over its inputs. */
function apiSessionReader(readCredential: () => Promise<unknown>, dependencies: KiroPluginDependencies): SessionReader {
  return async () =>
    createSession({ mode: "api", credential: await readCredential(), envKey: readApiKeyFromEnv() }, dependencies)
}

/** One credential manager per loader, so its held credential survives across requests. */
function oauthSessionReader(
  readCredential: () => Promise<unknown>,
  persistCredential: (credential: OAuthCredential) => Promise<void>,
  dependencies: KiroPluginDependencies,
): SessionReader {
  const credentials = new KiroCredentialManager(readCredential, persistCredential, dependencies)
  return async () => createSession({ mode: "oauth", credentials }, dependencies)
}

function installApiKeyEnvTransport(
  config: Config,
  providerId: string,
  input: PluginInput,
  dependencies: KiroPluginDependencies,
): void {
  const provider = config.provider?.[providerId] as Record<string, any> | undefined
  if (!provider) return
  const options = { ...(provider.options ?? {}) }
  if (options.apiKey === undefined) options.apiKey = ""
  if (!options.fetch) {
    options.fetch = createKiroFetch(providerId, input, () => readSession(input, providerId), dependencies)
  }
  provider.options = options
}

/**
 * The intercepting fetch opencode's Anthropic provider calls. Maps the Anthropic request to Kiro,
 * sends it, and hands every upstream Response to the single response seam.
 */
export function createKiroFetch(
  providerId: string,
  input: PluginInput,
  getSession: SessionReader,
  dependencies: KiroClientDependencies = {},
) {
  return async function kiroFetch(_input: Parameters<typeof fetch>[0], init?: RequestInit) {
    init?.signal?.throwIfAborted()
    const debug = createKiroDebugContext()
    let body: Record<string, any> = {}
    if (typeof init?.body === "string" && init.body.length > 0) {
      const parsed = parseRequestObject(init.body)
      if (!parsed) {
        return anthropicErrorResponse(
          400,
          "invalid_request_error",
          "Invalid JSON request body: the Anthropic request must be a JSON object.",
        )
      }
      body = parsed
    }
    const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL

    const effort = new Headers(init?.headers).get(EFFORT_HEADER) ?? undefined
    kiroDebug(debug, "request.received", {
      provider: providerId,
      authMode: providerId === API_PROVIDER_ID ? "api" : "oauth",
      model,
      effort: effort ?? null,
      anthropicRequestBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    })

    const signal = init?.signal ?? undefined
    const payload = toKiroPayload(body, { effort, debug })
    const active = await getSession()
    const response = await generateAssistantResponse(payload, active, { debug, signal, ...dependencies })
    kiroDebug(debug, "response.received", {
      status: response.status,
      statusText: response.statusText,
      headers: responseDebugHeaders(response.headers),
    })

    // Resolution never throws and is memoized per client and provider. Doing it eagerly costs
    // one cached lookup on error paths and keeps every response behind one call (D6).
    const contextLimit = await resolveContextLimit(input.client, providerId, model)
    return kiroResponseToAnthropic(response, { model, contextLimit, debug, signal })
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

/** Parse an Anthropic request body, accepting only a JSON object; anything else is undefined. */
function parseRequestObject(text: string): Record<string, any> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : undefined
  } catch {
    return undefined
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

async function deviceAuthorization(login: DeviceLogin, dependencies: AuthDependencies) {
  const pending = await beginDeviceAuthorization(login, dependencies)
  return deviceAuthorizationResult(pending, dependencies)
}

function deviceAuthorizationResult(pending: PendingDeviceAuthorization, dependencies: AuthDependencies) {
  const expiresInMinutes = Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 60_000))
  return {
    url: pending.verificationUriComplete ?? pending.verificationUri,
    instructions: `Enter code ${pending.userCode} and approve access. The code expires in ${expiresInMinutes} minutes.`,
    method: "auto" as const,
    callback: async () => {
      const credential = await completeDeviceAuthorization(pending, dependencies)
      return {
        type: "success" as const,
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
      }
    },
  }
}
