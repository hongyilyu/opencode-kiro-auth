import { describe, expect, it } from "bun:test"
import { encodeRefreshState, type RefreshState } from "../src/auth"
import { REFRESH_STATE_PREFIX } from "../src/constants"
import { createKiroFetch } from "../src/plugin"
import { toKiroPayload } from "../src/request"
import { createKiroDebugContext, kiroDebug, redactKiroSecrets, type KiroDebugContext } from "../src/debug"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { jsonResponse, scriptedFetch } from "./support/http-fixtures"
import { captureConsoleError, isolateEnv } from "./support/isolation"
import { fakePluginInput, fakeSession } from "./support/plugin-fixtures"
import { convert } from "./support/response-fixtures"

// Debug diagnostics expose request/event shapes without transcript content.
describe("debug diagnostics", () => {
  isolateEnv("KIRO_DEBUG")
  const captured = captureConsoleError()

  /** Run a full request and response round trip with KIRO_DEBUG on, returning the log. */
  async function debugRoundTrip(): Promise<string> {
    process.env.KIRO_DEBUG = "1"
    const debug: KiroDebugContext = { id: "debug-smoke", startedAt: Date.now(), enabled: true }
    toKiroPayload(
      {
        model: "claude-sonnet-4.6",
        messages: [
          { role: "user", content: "SECRET_PROMPT_TEXT" },
          { role: "assistant", content: "SECRET_ASSISTANT_TEXT" },
          { role: "user", content: "current" },
        ],
      },
      { debug },
    )
    const debugResponse = await convert(
      chunkedResponse(
        encodeKiroEvent("assistantResponseEvent", { content: "SECRET_MODEL_OUTPUT" }),
        encodeKiroEvent("metadataEvent", { stopReason: "end_turn" }),
        encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 7 }),
      ),
      { debug },
    )
    await debugResponse.text()
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
  })

  it("debug output from the full fetch path never contains the bearer token or profile ARN", async () => {
    process.env.KIRO_DEBUG = "1"
    const session = fakeSession({ token: "SECRET_ACCESS_TOKEN", profileArn: "SECRET_PROFILE_ARN" })
    const upstream = scriptedFetch(
      jsonResponse({ message: "Bearer SECRET_ACCESS_TOKEN is not valid" }, { status: 403 }),
      chunkedResponse(
        encodeKiroEvent("assistantResponseEvent", { content: "SECRET_MODEL_OUTPUT" }),
        encodeKiroEvent("metadataEvent", { stopReason: "end_turn" }),
      ),
    )
    const kiroFetch = createKiroFetch("kiro", fakePluginInput(), async () => session, { fetch: upstream.fetch })
    const request = {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "SECRET_PROMPT_TEXT" }],
      }),
    }

    const denied = await kiroFetch("https://api.anthropic.com/v1/messages", request)
    await denied.text()
    const streamed = await kiroFetch("https://api.anthropic.com/v1/messages", request)
    await streamed.text()
    const debugOutput = captured.lines.join("\n")

    // The secrets really travelled through the pipeline...
    expect(denied.status).toBe(403)
    expect(streamed.status).toBe(200)
    expect(upstream.calls.map((call) => new Headers(call.init?.headers).get("authorization"))).toEqual([
      "Bearer SECRET_ACCESS_TOKEN",
      "Bearer SECRET_ACCESS_TOKEN",
    ])
    expect(upstream.calls.map((call) => call.body)).toMatchObject([
      { profileArn: "SECRET_PROFILE_ARN" },
      { profileArn: "SECRET_PROFILE_ARN" },
    ])
    // ...and the debug log covered every stage of both requests...
    expect(debugOutput).toContain('"event":"request.received"')
    expect(debugOutput).toContain('"event":"profile.resolved"')
    expect(debugOutput).toContain('"event":"request.fetch_start"')
    expect(debugOutput).toContain('"event":"response.received"')
    expect(debugOutput).toContain('"event":"response.http_error"')
    expect(debugOutput).toContain('"event":"sse.complete"')
    expect(debugOutput).toContain("Bearer <redacted>")
    // ...without ever carrying either secret.
    expect(debugOutput).not.toContain("SECRET_ACCESS_TOKEN")
    expect(debugOutput).not.toContain("SECRET_PROFILE_ARN")
    expect(debugOutput).not.toContain("SECRET_PROMPT_TEXT")
    expect(debugOutput).not.toContain("SECRET_MODEL_OUTPUT")
  })

  it("debug recursively redacts credentials", () => {
    process.env.KIRO_DEBUG = "1"
    kiroDebug({ id: "recursive-redaction", startedAt: Date.now(), enabled: true }, "test.secret", {
      nested: { apiKey: "ksk_must_not_log", authorization: "Bearer oauth-secret-123" },
    })
    const debugOutput = captured.lines.join("\n")
    expect(debugOutput).toContain("ksk_<redacted>")
    expect(debugOutput).toContain("Bearer <redacted>")
    expect(debugOutput).not.toContain("must_not_log")
    expect(debugOutput).not.toContain("oauth-secret-123")
  })
})

describe("debug context", () => {
  isolateEnv("KIRO_DEBUG")
  const captured = captureConsoleError()

  it("createKiroDebugContext captures KIRO_DEBUG at creation", () => {
    delete process.env.KIRO_DEBUG
    expect(createKiroDebugContext().enabled).toBe(false)
    process.env.KIRO_DEBUG = "0"
    expect(createKiroDebugContext().enabled).toBe(false)
    process.env.KIRO_DEBUG = "1"
    expect(createKiroDebugContext().enabled).toBe(true)
    process.env.KIRO_DEBUG = "true"
    expect(createKiroDebugContext().enabled).toBe(true)
    process.env.KIRO_DEBUG = " TRUE "
    const enabled = createKiroDebugContext()
    expect(enabled.enabled).toBe(true)

    // The flag is a property of the context, not of the environment at log time.
    process.env.KIRO_DEBUG = "0"
    const disabled = createKiroDebugContext()
    expect(disabled.enabled).toBe(false)
    kiroDebug(enabled, "context.captured_on")
    kiroDebug(disabled, "context.captured_off")
    process.env.KIRO_DEBUG = "1"
    kiroDebug(disabled, "context.captured_off_still")
    const debugOutput = captured.lines.join("\n")
    expect(debugOutput).toContain('"event":"context.captured_on"')
    expect(debugOutput).not.toContain("context.captured_off")
  })
})

describe("secret redaction", () => {
  const refreshState: RefreshState = {
    version: 1,
    authMethod: "builder-id",
    region: "us-east-1",
    startUrl: "https://view.awsapps.com/start",
    clientId: "SECRET_CLIENT_ID",
    clientSecret: "SECRET_CLIENT_SECRET",
    refreshToken: "SECRET_REFRESH_TOKEN",
  }
  const packedBlob = encodeRefreshState(refreshState)
  const packedBody = packedBlob.slice(REFRESH_STATE_PREFIX.length)

  it("secrets: redacts api keys and bearer tokens", () => {
    expect(
      redactKiroSecrets("failed for ksk_offlinetestkey with Bearer oauth-secret-123; bearer token was invalid"),
    ).toBe("failed for ksk_<redacted> with Bearer <redacted>; bearer token was invalid")
  })

  it("redacts the packed refresh-state blob standalone and inside JSON", () => {
    expect(packedBody.length).toBeGreaterThan(20)
    expect(redactKiroSecrets(packedBlob)).toBe(`${REFRESH_STATE_PREFIX}<redacted>`)

    const embedded = JSON.stringify({
      type: "oauth",
      expires: 1_700_000_000_000,
      refresh: packedBlob,
      note: `stored as ${packedBlob} earlier`,
    })
    const redacted = redactKiroSecrets(embedded)
    expect(redacted).not.toContain(packedBody)
    expect(redacted).toContain(`"refresh":"${REFRESH_STATE_PREFIX}<redacted>"`)
    expect(redacted).toContain(`stored as ${REFRESH_STATE_PREFIX}<redacted> earlier`)
    // Only the blob is redacted; the non-secret neighbours survive and the record is still JSON.
    expect(JSON.parse(redacted)).toMatchObject({ type: "oauth", expires: 1_700_000_000_000 })
  })

  it("cannot redact a bare access token, so an OAuthCredential must never be stringified into a debug event", () => {
    // A Kiro access token has no recognisable prefix outside an `Authorization: Bearer` header,
    // so redaction is by construction unable to find it. Callers own this boundary: log the
    // credential's shape, never the credential.
    expect(redactKiroSecrets("aoaSECRETTOKEN")).toBe("aoaSECRETTOKEN")
  })

  it("redaction is idempotent", () => {
    const once = redactKiroSecrets(
      `api ksk_offlinetestkey, token Bearer oauth-secret-123, state ${packedBlob}; bearer token was invalid`,
    )
    expect(once).toBe(
      `api ksk_<redacted>, token Bearer <redacted>, state ${REFRESH_STATE_PREFIX}<redacted>; bearer token was invalid`,
    )
    expect(redactKiroSecrets(once)).toBe(once)
    expect(redactKiroSecrets(redactKiroSecrets(once))).toBe(once)
  })
})
