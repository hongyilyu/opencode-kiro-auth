import { randomUUID } from "node:crypto"
import {
  KIRO_CONTENT_TYPE,
  KIRO_ENDPOINT,
  KIRO_GET_PROFILE_TARGET,
  KIRO_INVOKE_MCP_TARGET,
  KIRO_LIST_PROFILES_TARGET,
  KIRO_MANAGEMENT_ENDPOINT,
  KIRO_MCP_ENDPOINT,
  KIRO_MGMT_USER_AGENT,
  KIRO_ORIGIN,
  KIRO_TARGET,
  KIRO_USER_AGENT,
  KIRO_X_AMZ_USER_AGENT,
} from "./constants"
import { kiroDebug, kiroDebugError, type KiroDebugContext } from "./debug"
import type { KiroSession } from "./session"

/** Injectable transport for offline tests; defaults to globalThis.fetch. */
export type KiroClientDependencies = {
  fetch?: typeof globalThis.fetch
}

/** UA pair for the streaming service (chat, InvokeMCP). */
const STREAMING_UA_HEADERS = {
  "user-agent": KIRO_USER_AGENT,
  "x-amz-user-agent": KIRO_X_AMZ_USER_AGENT,
}

/** Management-service operations send the management UA for both UA headers. */
const MGMT_UA_HEADERS = {
  "user-agent": KIRO_MGMT_USER_AGENT,
  "x-amz-user-agent": KIRO_MGMT_USER_AGENT,
}

type WireRequest = {
  url: string
  target: string
  /** Credential headers; spread first to preserve the historical header order. */
  auth: Record<string, string>
  /** Operation-specific tail: UA pair, optout, SDK id headers. */
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** The shared wire core: one awsJson1.0 POST, no policy. Every quirk lives with its operation. */
async function postKiro(
  request: WireRequest,
  options: KiroClientDependencies & { debug?: KiroDebugContext } = {},
): Promise<Response> {
  const fetcher = options.fetch ?? globalThis.fetch
  if (options.debug) kiroDebug(options.debug, "request.fetch_start", { url: request.url })
  try {
    return await fetcher(request.url, {
      method: "POST",
      headers: {
        ...request.auth,
        "content-type": KIRO_CONTENT_TYPE,
        "x-amz-target": request.target,
        ...request.headers,
      },
      body: JSON.stringify(request.body),
    })
  } catch (error) {
    if (options.debug) kiroDebug(options.debug, "request.fetch_error", kiroDebugError(error))
    throw error
  }
}

export type GenerateAssistantResponseOptions = KiroClientDependencies & {
  debug: KiroDebugContext
}

/**
 * Chat (GenerateAssistantResponse). Streaming UA pair, optout header, the debug trace
 * id as amz-sdk-invocation-id (max=3), and the profile ARN in the body only — and only
 * when the session resolves one (OAuth); API-key sessions omit the field entirely.
 */
export async function generateAssistantResponse(
  payload: Record<string, unknown>,
  session: KiroSession,
  options: GenerateAssistantResponseOptions,
): Promise<Response> {
  const [auth, profileArn] = await Promise.all([session.authHeaders(), session.chatProfileArn()])
  kiroDebug(options.debug, "profile.resolved", {
    hasProfile: Boolean(profileArn),
    omittedInBody: profileArn === undefined,
  })
  return postKiro(
    {
      url: KIRO_ENDPOINT,
      target: KIRO_TARGET,
      auth,
      headers: {
        ...STREAMING_UA_HEADERS,
        "x-amzn-codewhisperer-optout": "false",
        "amz-sdk-invocation-id": options.debug.id,
        "amz-sdk-request": "attempt=1; max=3",
      },
      body: profileArn ? { profileArn, ...payload } : payload,
    },
    options,
  )
}

/**
 * InvokeMCP. Streaming UA pair, optout, a fresh SDK invocation id per call (max=1),
 * and the profile ARN in BOTH the JSON-RPC body and the x-amzn-kiro-profile-arn
 * header — both auth modes resolve one.
 */
export async function invokeMcpRequest(
  rpcBody: Record<string, unknown>,
  session: KiroSession,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  const [auth, profileArn] = await Promise.all([session.authHeaders(), session.mcpProfileArn()])
  return postKiro(
    {
      url: KIRO_MCP_ENDPOINT,
      target: KIRO_INVOKE_MCP_TARGET,
      auth: { ...auth, "x-amzn-kiro-profile-arn": profileArn },
      headers: {
        ...STREAMING_UA_HEADERS,
        "x-amzn-codewhisperer-optout": "false",
        "amz-sdk-invocation-id": randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
      },
      body: { profileArn, ...rpcBody },
    },
    dependencies,
  )
}

/**
 * ListAvailableProfiles. Management UA for both UA headers, optout, no SDK id
 * headers, and the literal KIRO_CLI origin query.
 */
export function listAvailableProfiles(
  accessToken: string,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  return postKiro(
    {
      url: `${KIRO_MANAGEMENT_ENDPOINT}?origin=${KIRO_ORIGIN}`,
      target: KIRO_LIST_PROFILES_TARGET,
      auth: { authorization: `Bearer ${accessToken}` },
      headers: { ...MGMT_UA_HEADERS, "x-amzn-codewhisperer-optout": "false" },
      body: {},
    },
    dependencies,
  )
}

/**
 * GetProfile against one management-region endpoint. Management UA twice, no SDK id
 * headers, and deliberately NO optout header (existing drift, preserved). Region
 * sequencing belongs to the caller (apikey.ts): whether to try the next region
 * depends on the response body, which the transport does not interpret.
 */
export function getProfile(
  apiKey: string,
  endpoint: string,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  return postKiro(
    {
      url: endpoint,
      target: KIRO_GET_PROFILE_TARGET,
      auth: { authorization: `Bearer ${apiKey}`, tokentype: "API_KEY" },
      headers: MGMT_UA_HEADERS,
      body: {},
    },
    dependencies,
  )
}
