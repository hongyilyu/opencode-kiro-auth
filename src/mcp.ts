import { invokeMcpRequest, type JsonRpcRequest, type KiroClientDependencies } from "./client"
import { WEB_SEARCH_QUERY_MAX } from "./constants"
import type { KiroSession } from "./session"
import { redactKiroSecrets } from "./debug"

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

/** Low-level JSON-RPC call against Kiro's built-in MCP server. */
export async function invokeMcp(
  session: KiroSession,
  method: string,
  params?: unknown,
  dependencies: KiroClientDependencies = {},
): Promise<JsonRpcResult> {
  const body: JsonRpcRequest = { jsonrpc: "2.0", id: "1", method }
  if (params !== undefined) body.params = params

  const res = await invokeMcpRequest(body, session, dependencies)

  const text = await res.text()
  if (!res.ok) {
    throw new KiroMcpError(`Kiro InvokeMCP failed (${res.status}): ${redactKiroSecrets(text.slice(0, 500))}`)
  }

  let parsed: JsonRpcResponse
  try {
    parsed = JSON.parse(text) as JsonRpcResponse
  } catch {
    throw new KiroMcpError(
      `Kiro InvokeMCP returned non-JSON response: ${redactKiroSecrets(text.slice(0, 500))}`,
    )
  }

  if (parsed.error) {
    throw new KiroMcpError(
      `Kiro MCP error ${parsed.error.code ?? ""}: ${redactKiroSecrets(parsed.error.message ?? "unknown")}`,
    )
  }
  return parsed.result ?? {}
}

/** Extract the first text payload from an MCP tool result. */
function firstText(result: JsonRpcResult): string {
  return result.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text ?? ""
}

/** Run a web search via Kiro's built-in MCP `web_search` tool. */
export async function webSearch(
  session: KiroSession,
  query: string,
  dependencies: KiroClientDependencies = {},
): Promise<WebSearchResult[]> {
  // Belt-and-braces: the tool schema (tools.ts) rejects over-long queries on hosts
  // that validate zod args; this truncation covers older hosts that don't.
  const trimmed = query.length > WEB_SEARCH_QUERY_MAX ? query.slice(0, WEB_SEARCH_QUERY_MAX) : query
  const result = await invokeMcp(
    session,
    "tools/call",
    { name: "web_search", arguments: { query: trimmed } },
    dependencies,
  )
  const text = firstText(result)
  if (!text) return []
  try {
    const payload = JSON.parse(text) as { results?: WebSearchResult[] }
    return payload.results ?? []
  } catch {
    return []
  }
}
