import { randomUUID } from "node:crypto"
import {
  KIRO_MCP_ENDPOINT,
  KIRO_INVOKE_MCP_TARGET,
  KIRO_CONTENT_TYPE,
  KIRO_USER_AGENT,
  KIRO_X_AMZ_USER_AGENT,
} from "./constants"
import { getProfileArn } from "./profile"

/**
 * Client for Kiro's built-in MCP server, reached through the CodeWhisperer
 * `InvokeMCP` operation. This is exactly how kiro-cli executes its `web_search`
 * tool: the model emits a tool use, the CLI forwards it to the backend over
 * InvokeMCP (authenticated with the same bearer token), and the backend runs the
 * search server-side. No third-party API key is required.
 *
 * Verified wire shape (awsJson1.0), matching kiro-cli byte-for-byte:
 *   POST https://q.us-east-1.amazonaws.com/
 *   x-amz-target: AmazonCodeWhispererStreamingService.InvokeMCP
 *   x-amzn-kiro-profile-arn: <profileArn>
 *   body: { profileArn, jsonrpc: "2.0", id, method: "tools/call",
 *           params: { name, arguments } }
 *   ok:  { id, jsonrpc, result: { content: [{ type: "text", text: <json> }] } }
 *   err: { id, jsonrpc, error: { code, message } }
 */

type JsonRpcResult = {
  content?: Array<{ type?: string; text?: string }>
}

type JsonRpcResponse = {
  jsonrpc?: string
  id?: string
  result?: JsonRpcResult
  error?: { code?: number; message?: string }
}

export type WebSearchResult = {
  title?: string
  url?: string
  snippet?: string
  publishedDate?: number | null
  id?: string
  domain?: string
}

export class KiroMcpError extends Error {}

export type AccessTokenProvider = () => Promise<string>

/** Low-level JSON-RPC call against Kiro's built-in MCP server. */
export async function invokeMcp(
  getAccessToken: AccessTokenProvider,
  method: string,
  params?: unknown,
): Promise<JsonRpcResult> {
  const accessToken = await getAccessToken()
  const profileArn = await getProfileArn(accessToken)

  const body: Record<string, unknown> = { profileArn, jsonrpc: "2.0", id: "1", method }
  if (params !== undefined) body.params = params

  const res = await fetch(KIRO_MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "x-amzn-kiro-profile-arn": profileArn,
      "content-type": KIRO_CONTENT_TYPE,
      "x-amz-target": KIRO_INVOKE_MCP_TARGET,
      "user-agent": KIRO_USER_AGENT,
      "x-amz-user-agent": KIRO_X_AMZ_USER_AGENT,
      "x-amzn-codewhisperer-optout": "false",
      authorization: `Bearer ${accessToken}`,
      "amz-sdk-invocation-id": randomUUID(),
      "amz-sdk-request": "attempt=1; max=1",
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new KiroMcpError(`Kiro InvokeMCP failed (${res.status}): ${text.slice(0, 500)}`)
  }

  let parsed: JsonRpcResponse
  try {
    parsed = JSON.parse(text) as JsonRpcResponse
  } catch {
    throw new KiroMcpError(`Kiro InvokeMCP returned non-JSON response: ${text.slice(0, 500)}`)
  }

  if (parsed.error) {
    throw new KiroMcpError(`Kiro MCP error ${parsed.error.code ?? ""}: ${parsed.error.message ?? "unknown"}`)
  }
  return parsed.result ?? {}
}

/** Extract the first text payload from an MCP tool result. */
function firstText(result: JsonRpcResult): string {
  return result.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text ?? ""
}

/** Run a web search via Kiro's built-in MCP `web_search` tool. */
export async function webSearch(
  getAccessToken: AccessTokenProvider,
  query: string,
): Promise<WebSearchResult[]> {
  // The backend rejects queries longer than 200 characters.
  const trimmed = query.length > 200 ? query.slice(0, 200) : query
  const result = await invokeMcp(getAccessToken, "tools/call", {
    name: "web_search",
    arguments: { query: trimmed },
  })
  const text = firstText(result)
  if (!text) return []
  try {
    const payload = JSON.parse(text) as { results?: WebSearchResult[] }
    return payload.results ?? []
  } catch {
    return []
  }
}
