import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { webSearch, type WebSearchResult } from "./mcp"
import type { KiroSession } from "./session"

function formatResults(query: string, results: WebSearchResult[]): string {
  if (!results.length) {
    return `No web search results found for "${query}".`
  }
  const lines = results.map((r, i) => {
    const n = i + 1
    const title = r.title?.trim() || r.url || `Result ${n}`
    const parts = [`[${n}] ${title}`]
    if (r.url) parts.push(`    ${r.url}`)
    if (r.snippet) parts.push(`    ${r.snippet.replace(/\s+/g, " ").trim()}`)
    return parts.join("\n")
  })
  return [
    `Web search results for "${query}" (via Kiro):`,
    "",
    ...lines,
    "",
    "Cite sources inline as [n](url) when using this information.",
  ].join("\n")
}

export type KiroToolContext = Pick<ToolContext, "sessionID" | "messageID" | "directory">

export function createTools(
  getSession: (context: KiroToolContext) => Promise<KiroSession>,
): Record<string, ToolDefinition> {
  const web_search = {
    description:
      "Search the web for current, up-to-date information using Kiro's built-in web search " +
      "(no API key required). Returns titles, URLs, and snippets. Use for recent events, " +
      "latest versions, pricing, or anything that may have changed since training. " +
      "Always cite sources inline as [n](url).",
    args: {
      query: {
        type: "string",
        description: "The search query to execute. Must be 200 characters or fewer.",
        maxLength: 200,
      },
    },
    async execute(args: { query: string }, context: KiroToolContext) {
      const query = String(args?.query ?? "")
      const results = await webSearch(await getSession(context), query)
      return {
        title: query,
        output: formatResults(query, results),
        metadata: { count: results.length, results },
      }
    },
  } as unknown as ToolDefinition

  return { web_search }
}
