import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { KiroClientDependencies } from "./client"
import { WEB_SEARCH_QUERY_MAX } from "./constants"
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
  dependencies: KiroClientDependencies = {},
): Record<string, ToolDefinition> {
  const web_search = tool({
    description:
      "Search the web for current, up-to-date information using Kiro's built-in web search " +
      "service. Returns titles, URLs, and snippets. Use for recent events, " +
      "latest versions, pricing, or anything that may have changed since training. " +
      "Always cite sources inline as [n](url).",
    args: {
      query: tool.schema
        .string()
        .max(WEB_SEARCH_QUERY_MAX)
        .describe(`The search query to execute. Must be ${WEB_SEARCH_QUERY_MAX} characters or fewer.`),
    },
    async execute(args, context) {
      const query = args.query
      const results = await webSearch(await getSession(context), query, dependencies)
      return {
        title: query,
        output: formatResults(query, results),
        metadata: { count: results.length, results },
      }
    },
  })

  return { web_search }
}
