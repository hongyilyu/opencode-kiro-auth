import { describe, expect, it } from "bun:test"
import { kiroToAnthropicStream, preflightKiroResponse, toKiroRequest } from "../src/transform"
import { kiroDebug, redactKiroSecrets, type KiroDebugContext } from "../src/debug"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { captureConsoleError, isolateEnv } from "./support/isolation"

// Debug diagnostics expose request/event shapes without transcript content.
describe("debug diagnostics", () => {
  isolateEnv("KIRO_DEBUG")
  const captured = captureConsoleError()

  /** Run a full request -> preflight -> SSE round trip with KIRO_DEBUG on, returning the log. */
  async function debugRoundTrip(): Promise<string> {
    process.env.KIRO_DEBUG = "1"
    const debug: KiroDebugContext = { id: "debug-smoke", startedAt: Date.now() }
    toKiroRequest(
      {
        model: "claude-sonnet-4.6",
        messages: [
          { role: "user", content: "SECRET_PROMPT_TEXT" },
          { role: "assistant", content: "SECRET_ASSISTANT_TEXT" },
          { role: "user", content: "current" },
        ],
      },
      { authorization: "Bearer SECRET_ACCESS_TOKEN" },
      "SECRET_PROFILE_ARN",
      undefined,
      debug,
    )
    const debugResponse = await preflightKiroResponse(
      chunkedResponse(
        encodeKiroEvent("assistantResponseEvent", { content: "SECRET_MODEL_OUTPUT" }),
        encodeKiroEvent("metadataEvent", { stopReason: "end_turn" }),
        encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 7 }),
      ),
      debug,
    )
    await kiroToAnthropicStream(debugResponse, "claude-sonnet-4.6", 1_000_000, debug).text()
    return captured.lines.join("\n")
  }

  it("debug diagnostics emitted", async () => {
    const debugOutput = await debugRoundTrip()
    expect(debugOutput).toContain('"trace":"debug-smoke"')
    expect(debugOutput).toContain('"event":"request.history_shape"')
    expect(debugOutput).toContain('"event":"request.history_entry"')
    expect(debugOutput).toContain('"event":"response.event"')
    expect(debugOutput).toContain('"contentChars":19')
    expect(debugOutput).toContain('"stopReason":"end_turn"')
  })

  it("debug diagnostics redact content", async () => {
    const debugOutput = await debugRoundTrip()
    expect(debugOutput).not.toContain("SECRET_PROMPT_TEXT")
    expect(debugOutput).not.toContain("SECRET_ASSISTANT_TEXT")
    expect(debugOutput).not.toContain("SECRET_MODEL_OUTPUT")
    expect(debugOutput).not.toContain("SECRET_ACCESS_TOKEN")
    expect(debugOutput).not.toContain("SECRET_PROFILE_ARN")
  })

  it("debug recursively redacts credentials", () => {
    process.env.KIRO_DEBUG = "1"
    kiroDebug({ id: "recursive-redaction", startedAt: Date.now() }, "test.secret", {
      nested: { apiKey: "ksk_must_not_log", authorization: "Bearer oauth-secret-123" },
    })
    const debugOutput = captured.lines.join("\n")
    expect(debugOutput).toContain("ksk_<redacted>")
    expect(debugOutput).toContain("Bearer <redacted>")
    expect(debugOutput).not.toContain("must_not_log")
    expect(debugOutput).not.toContain("oauth-secret-123")
  })
})

describe("secret redaction", () => {
  it("secrets: redacts api keys and bearer tokens", () => {
    expect(
      redactKiroSecrets("failed for ksk_offlinetestkey with Bearer oauth-secret-123; bearer token was invalid"),
    ).toBe("failed for ksk_<redacted> with Bearer <redacted>; bearer token was invalid")
  })
})
