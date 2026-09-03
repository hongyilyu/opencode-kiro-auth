import { describe, expect, it } from "bun:test"
import { fetchApiKeyProfileArn } from "../src/apikey"
import { KIRO_PROFILE_ARN_PLACEHOLDER, WEB_SEARCH_QUERY_MAX } from "../src/constants"
import { createKiroFetch } from "../src/plugin"
import { getProfileArn } from "../src/profile"
import { webSearch } from "../src/mcp"
import { createTools } from "../src/tools"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { scriptedFetch } from "./support/http-fixtures"
import { isolateEnv } from "./support/isolation"
import { FAKE_PROFILE_ARN as PROFILE_ARN, fakePluginInput, fakeSession } from "./support/plugin-fixtures"

const session = fakeSession({ token: "seam-token" })

describe("injected Kiro client seams", () => {
  it("returns a redacted Anthropic 400 for a non-object request body", async () => {
    let fetchCalls = 0
    const fetcher = (async () => {
      fetchCalls++
      throw new Error("upstream must not be called")
    }) as unknown as typeof globalThis.fetch
    const kiroFetch = createKiroFetch("kiro", fakePluginInput(), async () => session, { fetch: fetcher })

    // Truncated JSON, and valid JSON whose top level is not an object.
    for (const body of ['{"secret":"ksk_must_not_leak"', "null", "[1,2]", '"text"']) {
      const response = await kiroFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body,
      })
      const error = await response.json()

      expect(response.status).toBe(400)
      expect(response.headers.get("content-type")).toBe("application/json")
      expect(error).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON request body: the Anthropic request must be a JSON object.",
        },
      })
      expect(JSON.stringify(error)).not.toContain("ksk_must_not_leak")
    }
    expect(fetchCalls).toBe(0)
  })

  it("runs the chat pipeline end to end without network access", async () => {
    let fetchCalls = 0
    const fetcher = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      fetchCalls++
      const headers = new Headers(init?.headers)
      expect(headers.get("x-amz-target")).toBe(
        "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      )
      expect(JSON.parse(String(init?.body)).profileArn).toBe(PROFILE_ARN)
      return chunkedResponse(encodeKiroEvent("assistantResponseEvent", { content: "offline reply" }))
    }) as unknown as typeof globalThis.fetch
    const input = fakePluginInput({ models: { "claude-sonnet-4.6": 200_000 } })
    const kiroFetch = createKiroFetch("kiro", input, async () => session, { fetch: fetcher })

    const response = await kiroFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "reply offline" }],
      }),
    })
    const sse = await response.text()

    expect(response.status).toBe(200)
    expect(fetchCalls).toBe(1)
    expect(sse).toContain('"type":"text_delta","text":"offline reply"')
    expect(sse).toContain('"type":"message_stop"')
  })

  it("rejects an already-aborted request before touching the session or upstream", async () => {
    let sessionReads = 0
    const upstream = scriptedFetch(() =>
      chunkedResponse(encodeKiroEvent("assistantResponseEvent", { content: "never" })),
    )
    const kiroFetch = createKiroFetch(
      "kiro",
      fakePluginInput(),
      async () => {
        sessionReads++
        return session
      },
      { fetch: upstream.fetch },
    )
    const reason = new Error("client went away")
    const controller = new AbortController()
    controller.abort(reason)

    const outcome = await kiroFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "cancelled before send" }],
      }),
      signal: controller.signal,
    }).then(
      () => "resolved",
      (error: unknown) => error,
    )

    expect(outcome).toBe(reason)
    expect(sessionReads).toBe(0)
    expect(upstream.calls).toHaveLength(0)
  })

  it("runs web_search end to end without network access", async () => {
    let rpcBody: Record<string, any> | undefined
    const fetcher = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      rpcBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [
                    {
                      title: "Bun 1.3",
                      url: "https://bun.sh/blog/bun-v1.3",
                      snippet: "Bun 1.3 release notes",
                    },
                  ],
                }),
              },
            ],
          },
        }),
      )
    }) as unknown as typeof globalThis.fetch
    const tools = createTools(async () => session, { fetch: fetcher })

    const result = (await tools.web_search.execute(
      { query: "latest Bun release" },
      { sessionID: "session", messageID: "message", directory: "/tmp" } as never,
    )) as any

    expect(rpcBody?.profileArn).toBe(PROFILE_ARN)
    expect(rpcBody?.method).toBe("tools/call")
    expect(rpcBody?.params?.arguments?.query).toBe("latest Bun release")
    expect(result.metadata.count).toBe(1)
    expect(result.output).toContain("[1] Bun 1.3")
    expect(result.output).toContain("https://bun.sh/blog/bun-v1.3")
  })

  it("truncates over-long web_search queries to the backend limit", async () => {
    let rpcBody: Record<string, any> | undefined
    const fetcher = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      rpcBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [] } }),
      )
    }) as unknown as typeof globalThis.fetch

    const longQuery = "q".repeat(WEB_SEARCH_QUERY_MAX + 50)
    const results = await webSearch(session, longQuery, { fetch: fetcher })

    expect(results).toEqual([])
    expect(rpcBody?.params?.arguments?.query).toBe("q".repeat(WEB_SEARCH_QUERY_MAX))
  })
})

describe("HTTP errors through createKiroFetch", () => {
  isolateEnv("KIRO_RATE_LIMIT_RETRY_SECONDS")

  const CHAT_BODY = JSON.stringify({
    model: "claude-sonnet-4.6",
    messages: [{ role: "user", content: "trigger an upstream error" }],
  })

  /** A chat call whose upstream answers with one fixed HTTP error; counts upstream calls. */
  async function chatAgainst(upstream: Response): Promise<{ response: Response; fetchCalls: number }> {
    const { fetch, calls } = scriptedFetch(upstream)
    const kiroFetch = createKiroFetch("kiro", fakePluginInput(), async () => session, { fetch })
    const response = await kiroFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: CHAT_BODY })
    return { response, fetchCalls: calls.length }
  }

  it("forwards the upstream retry-after on a 429", async () => {
    delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: { "retry-after": "17" },
      }),
    )

    expect(fetchCalls).toBe(1)
    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("retry-after")).toBe("17")
    expect(await response.json()).toEqual({ message: "Too many requests" })
  })

  it("lets KIRO_RATE_LIMIT_RETRY_SECONDS override the upstream retry-after on a 429", async () => {
    process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = "45"
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: { "retry-after": "17" },
      }),
    )

    expect(fetchCalls).toBe(1)
    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("retry-after")).toBe("45")
  })

  it("forwards a 503 retry-after verbatim even when KIRO_RATE_LIMIT_RETRY_SECONDS is set", async () => {
    process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = "45"
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "Service unavailable" }), {
        status: 503,
        headers: { "retry-after": "9" },
      }),
    )

    expect(fetchCalls).toBe(1)
    expect(response.status).toBe(503)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("retry-after")).toBe("9")
    expect(await response.json()).toEqual({ message: "Service unavailable" })
  })

  it("redacts an API key in a passthrough error body exactly once", async () => {
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "rejected credential ksk_leakedsecret123" }), { status: 403 }),
    )
    const text = await response.text()

    expect(fetchCalls).toBe(1)
    expect(response.status).toBe(403)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(text).toBe(JSON.stringify({ message: "rejected credential ksk_<redacted>" }))
    expect(text.split("ksk_").length - 1).toBe(1)
  })

  it("passes a non-JSON error body through verbatim with a JSON content-type", async () => {
    const { response, fetchCalls } = await chatAgainst(new Response("boom", { status: 500 }))

    expect(fetchCalls).toBe(1)
    expect(response.status).toBe(500)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe("boom")
  })

  it("maps an empty error body to a generic failure message", async () => {
    const { response, fetchCalls } = await chatAgainst(new Response("", { status: 503 }))

    expect(fetchCalls).toBe(1)
    expect(response.status).toBe(503)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe("Kiro request failed (503)")
  })

  it("reshapes CONTENT_LENGTH_EXCEEDS_THRESHOLD into a prompt-too-long error", async () => {
    const { response, fetchCalls } = await chatAgainst(
      new Response(
        JSON.stringify({
          __type: "ValidationException",
          message: "Input content length exceeds threshold",
          reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
        }),
        { status: 400 },
      ),
    )
    const error = (await response.json()) as any

    expect(fetchCalls).toBe(1)
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(error.type).toBe("error")
    expect(error.error.type).toBe("invalid_request_error")
    expect(error.error.message).toMatch(/prompt is too long/i)
    expect(error.error.message).not.toContain("CONTENT_LENGTH_EXCEEDS_THRESHOLD")
  })
})

describe("credential-tier client seams", () => {
  it("falls through a GetProfile network error to the second region", async () => {
    const urls: string[] = []
    const fetcher = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input))
      if (urls.length === 1) throw new TypeError("offline region")
      return new Response(JSON.stringify({ profile: { arn: PROFILE_ARN } }))
    }) as unknown as typeof globalThis.fetch

    expect(await fetchApiKeyProfileArn("ksk_networkfallback", { fetch: fetcher })).toBe(PROFILE_ARN)
    expect(urls).toEqual([
      "https://management.us-east-1.kiro.dev/",
      "https://management.eu-central-1.kiro.dev/",
    ])
  })

  it("falls through an ok GetProfile response without a usable ARN", async () => {
    const urls: string[] = []
    const fetcher = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input))
      if (urls.length === 1) return new Response(JSON.stringify({ profile: {} }))
      return new Response(JSON.stringify({ profile: { arn: PROFILE_ARN } }))
    }) as unknown as typeof globalThis.fetch

    expect(await fetchApiKeyProfileArn("ksk_unusablefirstregion", { fetch: fetcher })).toBe(PROFILE_ARN)
    expect(urls).toEqual([
      "https://management.us-east-1.kiro.dev/",
      "https://management.eu-central-1.kiro.dev/",
    ])
  })

  it("reports an error after both GetProfile regions reject", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response("{}", { status: 403 })
    }) as unknown as typeof globalThis.fetch

    const message = await fetchApiKeyProfileArn("ksk_allregionsfail", { fetch: fetcher }).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )
    expect(calls).toBe(2)
    expect(message).toContain("could not use the configured credential")
    expect(message).toContain("management.us-east-1.kiro.dev: HTTP 403")
    expect(message).toContain("management.eu-central-1.kiro.dev: HTTP 403")
  })

  it("names each region's distinct failure in the error", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return calls === 1 ? new Response("{}", { status: 503 }) : new Response("not json")
    }) as unknown as typeof globalThis.fetch

    const message = await fetchApiKeyProfileArn("ksk_diagnosticskey", { fetch: fetcher }).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )
    expect(message).toContain("management.us-east-1.kiro.dev: HTTP 503")
    expect(message).toContain("management.eu-central-1.kiro.dev: non-JSON response")
    // The diagnostics never include the credential.
    expect(message).not.toContain("ksk_diagnosticskey")
  })

  it("reports an ok response that lacks a profile ARN", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ profile: {} }))) as unknown as typeof globalThis.fetch

    const message = await fetchApiKeyProfileArn("ksk_noarnanywhere", { fetch: fetcher }).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )
    expect(message).toContain("management.us-east-1.kiro.dev: response has no profile ARN")
    expect(message).toContain("management.eu-central-1.kiro.dev: response has no profile ARN")
  })

  it("maps ListAvailableProfiles failure to the placeholder", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response("{}", { status: 503 })
    }) as unknown as typeof globalThis.fetch

    expect(await getProfileArn("list-profile-failure", { fetch: fetcher })).toBe(
      KIRO_PROFILE_ARN_PLACEHOLDER,
    )
    expect(calls).toBe(1)
  })
})
