import { randomUUID } from "node:crypto"
import {
  KIRO_CONTENT_TYPE,
  KIRO_ENDPOINT,
  KIRO_GET_PROFILE_TARGET,
  KIRO_INVOKE_MCP_TARGET,
  KIRO_LIST_PROFILES_TARGET,
  KIRO_MANAGEMENT_ENDPOINT,
  KIRO_MANAGEMENT_ENDPOINTS,
  KIRO_MCP_ENDPOINT,
  KIRO_MGMT_USER_AGENT,
  KIRO_ORIGIN,
  KIRO_TARGET,
  KIRO_USER_AGENT,
  KIRO_X_AMZ_USER_AGENT,
} from "./constants"
import { kiroDebug, kiroDebugError, type KiroDebugContext } from "./debug"
import type { KiroSession } from "./session"

export type KiroClientDependencies = {
  fetch?: typeof globalThis.fetch
}

type OperationDescriptor = {
  endpoints: readonly string[]
  target: string
  uaPair: "streaming" | "mgmt"
  optout: boolean
  sdkIds: null | { invocationId: "provided" | "random"; maxAttempts: number }
  arnPlacement: "none" | "bodyIfPresent" | "bodyAndHeader"
  query?: string
  retryNotOk?: boolean
}

const OPERATIONS = {
  // Chat uses its debug trace as the SDK invocation id, max=3, streaming UAs, optout,
  // and conditionally places the OAuth profile ARN in the body only.
  generateAssistantResponse: {
    endpoints: [KIRO_ENDPOINT],
    target: KIRO_TARGET,
    uaPair: "streaming",
    optout: true,
    sdkIds: { invocationId: "provided", maxAttempts: 3 },
    arnPlacement: "bodyIfPresent",
  },
  // InvokeMCP uses a fresh SDK invocation id, max=1, streaming UAs, optout, and sends
  // the profile ARN in both its JSON-RPC body and x-amzn-kiro-profile-arn header.
  invokeMcp: {
    endpoints: [KIRO_MCP_ENDPOINT],
    target: KIRO_INVOKE_MCP_TARGET,
    uaPair: "streaming",
    optout: true,
    sdkIds: { invocationId: "random", maxAttempts: 1 },
    arnPlacement: "bodyAndHeader",
  },
  // ListAvailableProfiles has no SDK id headers, uses the management UA for both UA
  // headers, includes optout, and carries the literal KIRO_CLI origin query.
  listAvailableProfiles: {
    endpoints: [KIRO_MANAGEMENT_ENDPOINT],
    target: KIRO_LIST_PROFILES_TARGET,
    uaPair: "mgmt",
    optout: true,
    sdkIds: null,
    arnPlacement: "none",
    query: `origin=${KIRO_ORIGIN}`,
  },
  // GetProfile has no SDK ids, uses the management UA twice, retries regions after
  // network/non-ok results, and deliberately omits the optout header (existing drift).
  getProfile: {
    endpoints: KIRO_MANAGEMENT_ENDPOINTS,
    target: KIRO_GET_PROFILE_TARGET,
    uaPair: "mgmt",
    optout: false,
    sdkIds: null,
    arnPlacement: "none",
    retryNotOk: true,
  },
} as const satisfies Record<string, OperationDescriptor>

type KiroOperation = keyof typeof OPERATIONS

type WireOptions = {
  dependencies?: KiroClientDependencies
  profileArn?: string
  invocationId?: string
  debug?: KiroDebugContext
}

async function kiroWireFetch(
  operation: KiroOperation,
  body: Record<string, unknown>,
  authHeaders: Record<string, string>,
  options: WireOptions = {},
): Promise<Response> {
  const descriptor: OperationDescriptor = OPERATIONS[operation]
  const fetcher = options.dependencies?.fetch ?? globalThis.fetch
  const userAgent = descriptor.uaPair === "streaming" ? KIRO_USER_AGENT : KIRO_MGMT_USER_AGENT
  const xAmzUserAgent =
    descriptor.uaPair === "streaming" ? KIRO_X_AMZ_USER_AGENT : KIRO_MGMT_USER_AGENT
  const invocationId =
    descriptor.sdkIds?.invocationId === "random" ? randomUUID() : options.invocationId

  if (descriptor.sdkIds && !invocationId) {
    throw new Error(`Kiro ${operation} requires an SDK invocation id.`)
  }
  if (descriptor.arnPlacement === "bodyAndHeader" && options.profileArn === undefined) {
    throw new Error(`Kiro ${operation} requires a profile ARN.`)
  }

  const headers: Record<string, string> = {
    ...authHeaders,
    ...(descriptor.arnPlacement === "bodyAndHeader"
      ? { "x-amzn-kiro-profile-arn": options.profileArn! }
      : {}),
    "content-type": KIRO_CONTENT_TYPE,
    "x-amz-target": descriptor.target,
    "user-agent": userAgent,
    "x-amz-user-agent": xAmzUserAgent,
    ...(descriptor.optout ? { "x-amzn-codewhisperer-optout": "false" } : {}),
    ...(descriptor.sdkIds
      ? {
          "amz-sdk-invocation-id": invocationId!,
          "amz-sdk-request": `attempt=1; max=${descriptor.sdkIds.maxAttempts}`,
        }
      : {}),
  }
  const serializedBody = JSON.stringify(
    descriptor.arnPlacement === "bodyAndHeader" ||
      (descriptor.arnPlacement === "bodyIfPresent" && options.profileArn)
      ? { profileArn: options.profileArn, ...body }
      : body,
  )
  const query = descriptor.query ? `?${descriptor.query}` : ""
  let lastResponse: Response | undefined
  let lastError: unknown

  for (const endpoint of descriptor.endpoints) {
    const url = `${endpoint}${query}`
    if (options.debug) kiroDebug(options.debug, "request.fetch_start", { url })
    try {
      const response = await fetcher(url, { method: "POST", headers, body: serializedBody })
      if (!descriptor.retryNotOk || response.ok) return response
      lastResponse = response
    } catch (error) {
      if (options.debug) kiroDebug(options.debug, "request.fetch_error", kiroDebugError(error))
      if (!descriptor.retryNotOk) throw error
      lastError = error
    }
  }

  if (lastResponse) return lastResponse
  throw lastError ?? new Error(`Kiro ${operation} failed without a response.`)
}

export type GenerateAssistantResponseOptions = KiroClientDependencies & {
  debug: KiroDebugContext
}

export async function generateAssistantResponse(
  payload: Record<string, unknown>,
  session: KiroSession,
  options: GenerateAssistantResponseOptions,
): Promise<Response> {
  const [authHeaders, profileArn] = await Promise.all([
    session.authHeaders(),
    session.chatProfileArn(),
  ])
  kiroDebug(options.debug, "profile.resolved", {
    hasProfile: Boolean(profileArn),
    omittedInBody: profileArn === undefined,
  })
  return kiroWireFetch("generateAssistantResponse", payload, authHeaders, {
    dependencies: options,
    profileArn,
    invocationId: options.debug.id,
    debug: options.debug,
  })
}

export async function invokeMcpRequest(
  rpcBody: Record<string, unknown>,
  session: KiroSession,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  const [authHeaders, profileArn] = await Promise.all([
    session.authHeaders(),
    session.mcpProfileArn(),
  ])
  return kiroWireFetch("invokeMcp", rpcBody, authHeaders, { dependencies, profileArn })
}

export function listAvailableProfiles(
  accessToken: string,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  return kiroWireFetch(
    "listAvailableProfiles",
    {},
    { authorization: `Bearer ${accessToken}` },
    { dependencies },
  )
}

export function getProfile(
  apiKey: string,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  return kiroWireFetch(
    "getProfile",
    {},
    { authorization: `Bearer ${apiKey}`, tokentype: "API_KEY" },
    { dependencies },
  )
}
