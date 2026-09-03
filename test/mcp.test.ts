import { describe, expect, it } from "bun:test"
import { WEB_SEARCH_QUERY_MAX } from "../src/constants"
import { KiroMcpError, invokeMcp, webSearch } from "../src/mcp"
import { createTools } from "../src/tools"
import { jsonResponse, rejectionOf, scriptedFetch } from "./support/http-fixtures"
import { FAKE_PROFILE_ARN as PROFILE_ARN, fakeSession } from "./support/plugin-fixtures"

const session = fakeSession({ token: "mcp-token" })

describe("invokeMcp", () => {
  it("throws KiroMcpError with a redacted body slice on a non-2xx response", async () => {
    const body = `forbidden for Bearer sekrit-bearer-value and key ksk_leakyapikey ${"x".repeat(600)}TAIL_MARKER`
    const { fetch } = scriptedFetch(new Response(body, { status: 403 }))

    const error = await rejectionOf(invokeMcp(session, "tools/list", undefined, { fetch }))

    expect(error).toBeInstanceOf(KiroMcpError)
    const message = (error as Error).message
    expect(message).toContain("Kiro InvokeMCP failed (403)")
    expect(message).toContain("Bearer <redacted>")
    expect(message).toContain("ksk_<redacted>")
    expect(message).not.toContain("sekrit-bearer-value")
    expect(message).not.toContain("leakyapikey")
    // Only a bounded slice of the upstream body rides along in the error.
    expect(message).not.toContain("TAIL_MARKER")
  })

  it("throws KiroMcpError on a 200 whose body is not JSON", async () => {
    const { fetch } = scriptedFetch(new Response("<html>gateway says Bearer sekrit-bearer-value</html>"))

    const error = await rejectionOf(invokeMcp(session, "tools/list", undefined, { fetch }))

    expect(error).toBeInstanceOf(KiroMcpError)
    const message = (error as Error).message
    expect(message).toContain("non-JSON response")
    expect(message).toContain("Bearer <redacted>")
    expect(message).not.toContain("sekrit-bearer-value")
  })

  it("throws KiroMcpError carrying the code and redacted message of a JSON-RPC error", async () => {
    const { fetch } = scriptedFetch(
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        error: { code: -32601, message: "method not found; rejected Bearer sekrit-bearer-value" },
      }),
    )

    const error = await rejectionOf(invokeMcp(session, "tools/call", { name: "nope" }, { fetch }))

    expect(error).toBeInstanceOf(KiroMcpError)
    const message = (error as Error).message
    expect(message).toContain("Kiro MCP error -32601")
    expect(message).toContain("method not found")
    expect(message).toContain("Bearer <redacted>")
    expect(message).not.toContain("sekrit-bearer-value")
  })

  it("reports a JSON-RPC error that has neither code nor message", async () => {
    const { fetch } = scriptedFetch(jsonResponse({ jsonrpc: "2.0", id: "1", error: {} }))

    const error = await rejectionOf(invokeMcp(session, "tools/list", undefined, { fetch }))

    expect(error).toBeInstanceOf(KiroMcpError)
    expect((error as Error).message).toContain("Kiro MCP error")
    expect((error as Error).message).toContain("unknown")
  })

  it("resolves an empty result when the response carries no result", async () => {
    const { fetch } = scriptedFetch(jsonResponse({ jsonrpc: "2.0", id: "1" }))

    expect(await invokeMcp(session, "tools/list", undefined, { fetch })).toEqual({})
  })

  it("resolves the result object as-is when present", async () => {
    const result = { content: [{ type: "text", text: "hello" }] }
    const { fetch } = scriptedFetch(jsonResponse({ jsonrpc: "2.0", id: "1", result }))

    expect(await invokeMcp(session, "tools/call", { name: "echo" }, { fetch })).toEqual(result)
  })

  it("omits params from the JSON-RPC body when none are given", async () => {
    const { fetch, calls } = scriptedFetch(
      jsonResponse({ jsonrpc: "2.0", id: "1", result: {} }),
      jsonResponse({ jsonrpc: "2.0", id: "1", result: {} }),
    )

    await invokeMcp(session, "tools/list", undefined, { fetch })
    await invokeMcp(session, "tools/call", { name: "web_search" }, { fetch })

    expect(calls[0]?.body).toMatchObject({ jsonrpc: "2.0", method: "tools/list", profileArn: PROFILE_ARN })
    expect(calls[0]?.body).not.toHaveProperty("params")
    expect(calls[1]?.body).toHaveProperty("params", { name: "web_search" })
  })
})

describe("webSearch", () => {
  const resultsPayload = {
    results: [{ title: "Bun 1.3", url: "https://bun.sh/blog/bun-v1.3", snippet: "release notes" }],
  }

  function mcpResult(content: unknown[]): Response {
    return jsonResponse({ jsonrpc: "2.0", id: "1", result: { content } })
  }

  it("returns the parsed results from the first text content block", async () => {
    const { fetch } = scriptedFetch(
      mcpResult([{ type: "image", data: "..." }, { type: "text", text: JSON.stringify(resultsPayload) }]),
    )

    expect(await webSearch(session, "bun release", { fetch })).toEqual(resultsPayload.results)
  })

  it("returns no results when the result has no text content", async () => {
    const { fetch } = scriptedFetch(
      mcpResult([]),
      mcpResult([{ type: "image", data: "..." }]),
      mcpResult([{ type: "text" }]),
      jsonResponse({ jsonrpc: "2.0", id: "1", result: {} }),
      jsonResponse({ jsonrpc: "2.0", id: "1" }),
    )

    for (let i = 0; i < 5; i++) {
      expect(await webSearch(session, "anything", { fetch })).toEqual([])
    }
  })

  it("returns no results when the text content is not JSON", async () => {
    const { fetch } = scriptedFetch(mcpResult([{ type: "text", text: "not json at all" }]))

    expect(await webSearch(session, "anything", { fetch })).toEqual([])
  })

  it("returns no results when the JSON text lacks a results list", async () => {
    const { fetch } = scriptedFetch(mcpResult([{ type: "text", text: JSON.stringify({ answer: "42" }) }]))

    expect(await webSearch(session, "anything", { fetch })).toEqual([])
  })

  it("truncates the query to the backend limit and leaves shorter queries alone", async () => {
    const { fetch, calls } = scriptedFetch(mcpResult([]), mcpResult([]))
    const exact = "e".repeat(WEB_SEARCH_QUERY_MAX)

    await webSearch(session, exact, { fetch })
    await webSearch(session, `${exact}overflow`, { fetch })

    expect(calls[0]?.body).toMatchObject({ method: "tools/call" })
    expect(calls[0]?.body).toHaveProperty("params", { name: "web_search", arguments: { query: exact } })
    expect(calls[1]?.body).toHaveProperty("params.arguments.query", exact)
  })

  it("propagates a KiroMcpError from the transport instead of swallowing it", async () => {
    const { fetch } = scriptedFetch(new Response("upstream down", { status: 503 }))

    const error = await rejectionOf(webSearch(session, "anything", { fetch }))

    expect(error).toBeInstanceOf(KiroMcpError)
    expect((error as Error).message).toContain("Kiro InvokeMCP failed (503)")
  })
})

describe("web_search tool", () => {
  const toolContext = { sessionID: "session", messageID: "message", directory: "/tmp" } as never

  it("reports that no results were found for an empty list", async () => {
    const { fetch } = scriptedFetch(jsonResponse({ jsonrpc: "2.0", id: "1", result: { content: [] } }))
    const tools = createTools(async () => session, { fetch })

    const result = (await tools.web_search.execute({ query: "nothing here" }, toolContext)) as any

    expect(result.title).toBe("nothing here")
    expect(result.output).toContain("No web search results found")
    expect(result.output).toContain('"nothing here"')
    expect(result.metadata).toEqual({ count: 0, results: [] })
  })

  it("surfaces the MCP failure to the tool caller", async () => {
    const { fetch } = scriptedFetch(new Response("nope", { status: 500 }))
    const tools = createTools(async () => session, { fetch })

    const error = await rejectionOf(tools.web_search.execute({ query: "boom" }, toolContext))

    expect(error).toBeInstanceOf(KiroMcpError)
  })
})
