import { describe, expect, it } from "bun:test"
import { kiroToAnthropicStream, mapKiroError, preflightKiroResponse } from "../src/transform"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { isolateEnv } from "./support/isolation"

/** Preflight a synthetic Kiro event stream built from the given frames. */
function preflight(...frames: Uint8Array[]): Promise<Response> {
  return preflightKiroResponse(chunkedResponse(...frames))
}

/** Preflight then convert to the Anthropic SSE text a client would receive. */
async function streamedSse(model: string, ...frames: Uint8Array[]): Promise<string> {
  const prepared = await preflight(...frames)
  return kiroToAnthropicStream(prepared, model).text()
}

async function errorBody(res: Response): Promise<{ error?: { type?: string; message?: string } }> {
  return (await res.json()) as { error?: { type?: string; message?: string } }
}

// Usage is derived from Kiro's contextUsageEvent percentage.
describe("usage reporting", () => {
  const successFrames = () => [
    encodeKiroEvent("assistantResponseEvent", { content: "hello" }),
    encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }),
  ]

  it("successful stream preflight", async () => {
    const prepared = await preflight(...successFrames())
    expect(prepared.status).toBe(200)
  })

  it("usage input tokens", async () => {
    const prepared = await preflight(...successFrames())
    const out = await kiroToAnthropicStream(prepared, "claude-sonnet-4.6", 1_000_000).text()
    const delta = out.split("\n").find((l) => l.startsWith("data:") && l.includes("message_delta"))
    expect(delta).toBeDefined()
    const usage = JSON.parse(delta!.slice(5)).usage
    expect(usage?.input_tokens).toBe(50_000)
  })
})

// In-band throttling -> HTTP 429 so opencode's outer retry loop sees it.
describe("in-band throttling", () => {
  isolateEnv("KIRO_RATE_LIMIT_RETRY_SECONDS")

  it("stream throttle mapping", async () => {
    delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
    const throttledFrame = encodeKiroEvent(
      "ThrottlingException",
      { message: "Rate exceeded", retryAfterSeconds: 3 },
      ":exception-type",
    )
    // Split mid-frame to exercise partial-frame buffering in the preflight reader.
    const mapped = await preflightKiroResponse(
      chunkedResponse(throttledFrame.subarray(0, 9), throttledFrame.subarray(9)),
    )
    expect(mapped.status).toBe(429)
    expect(mapped.headers.get("retry-after")).toBe("3")
    const body = await errorBody(mapped)
    expect(body.error?.type).toBe("rate_limit_error")
  })

  it("default retry backoff preserved", async () => {
    delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
    const res = await preflight(encodeKiroEvent("TooManyRequestsException", { message: "Slow down" }, ":exception-type"))
    expect(res.headers.get("retry-after")).toBeNull()
  })

  it("configured fixed retry delay", async () => {
    process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = "10"
    const res = await preflight(encodeKiroEvent("TooManyRequestsException", { message: "Slow down" }, ":exception-type"))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("10")
  })
})

// Pre-output timeout -> retryable HTTP error, never a successful empty turn.
describe("pre-output timeouts", () => {
  it("stream timeout mapping", async () => {
    const res = await preflight(encodeKiroEvent("error", { message: "TimeoutError: The operation timed out." }))
    expect(res.status).toBe(504)
    const body = await errorBody(res)
    expect(body.error?.type).toBe("api_error")
    expect(body.error?.message).toContain("timed out")
  })

  it("transport timeout mapping", async () => {
    const res = await preflightKiroResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("The operation timed out.", "TimeoutError"))
          },
        }),
      ),
    )
    expect(res.status).toBe(504)
    expect(await res.text()).toContain("TimeoutError: The operation timed out.")
  })
})

// Metadata and empty assistant events are not model output.
describe("empty streams", () => {
  it("empty stream mapping", async () => {
    const res = await preflight(
      encodeKiroEvent("assistantResponseEvent", { content: "" }),
      encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 19.8811 }),
      encodeKiroEvent("meteringEvent", { usage: 1 }),
    )
    expect(res.status).toBe(502)
    const body = await errorBody(res)
    expect(body.error?.type).toBe("api_error")
    expect(body.error?.message).toContain("without assistant output")
  })

  it("bodyless response mapping", async () => {
    const res = await preflightKiroResponse(new Response(null))
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("without an event stream")
  })

  it("empty tool event mapping", async () => {
    const res = await preflight(encodeKiroEvent("toolUseEvent", { toolUseId: "orphan-stop", stop: true }))
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("without assistant output")
  })
})

describe("tool call streams", () => {
  // A complete tool call packed into one frame (input + stop together) is real output:
  // preflight must replay it and the SSE converter must emit a full tool_use block.
  const singleFrame = () => [
    encodeKiroEvent("toolUseEvent", { toolUseId: "one-shot", name: "bash", input: '{"command":"ls"}', stop: true }),
    encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }),
  ]

  it("single-frame tool call passes preflight", async () => {
    const res = await preflight(...singleFrame())
    expect(res.status).toBe(200)
  })

  it("single-frame tool call streamed", async () => {
    const sse = await streamedSse("claude-sonnet-4.6", ...singleFrame())
    expect(sse).toContain('"type":"tool_use"')
    expect(sse).toContain('"id":"one-shot"')
    expect(sse).toContain('"partial_json":"{\\"command\\":\\"ls\\"}"')
    expect(sse).toContain('"stop_reason":"tool_use"')
  })

  // The observed multi-frame shape (start, input deltas, stop) must keep working unchanged.
  const multiFrame = () => [
    encodeKiroEvent("toolUseEvent", { toolUseId: "multi", name: "bash" }),
    encodeKiroEvent("toolUseEvent", { toolUseId: "multi", name: "bash", input: '{"command"' }),
    encodeKiroEvent("toolUseEvent", { toolUseId: "multi", name: "bash", input: ':"ls"}' }),
    encodeKiroEvent("toolUseEvent", { toolUseId: "multi", name: "bash", stop: true }),
  ]

  it("multi-frame tool call passes preflight", async () => {
    const res = await preflight(...multiFrame())
    expect(res.status).toBe(200)
  })

  it("multi-frame tool call streamed once", async () => {
    const sse = await streamedSse("claude-sonnet-4.6", ...multiFrame())
    expect(sse.split('"content_block_start"').length - 1).toBe(1)
    expect(sse).toContain('"id":"multi"')
    expect(sse).toContain('"partial_json":"{\\"command\\""')
    expect(sse).toContain('"stop_reason":"tool_use"')
  })
})

// Reasoning is visible progress, but it is not a complete assistant response by itself.
// Preflight should release it immediately; the SSE converter must still fail at EOF if no text
// or tool call follows so OpenCode never records a successful reasoning-only turn.
describe("reasoning streams", () => {
  const reasoningOnly = () => [
    encodeKiroEvent("reasoningContentEvent", { text: "working" }),
    encodeKiroEvent("reasoningContentEvent", { signature: "sig_1" }),
    encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }),
  ]

  it("reasoning stream passes preflight", async () => {
    const res = await preflight(...reasoningOnly())
    expect(res.status).toBe(200)
  })

  it("reasoning stream is visible", async () => {
    const sse = await streamedSse("claude-fable-5", ...reasoningOnly())
    expect(sse).toContain('"type":"thinking"')
    expect(sse).toContain('"type":"thinking_delta","thinking":"working"')
    expect(sse).toContain('"type":"signature_delta","signature":"sig_1"')
    expect(sse).not.toContain('"type":"thinking_delta","thinking":" "')
  })

  it("reasoning-only EOF remains an error", async () => {
    const sse = await streamedSse("claude-fable-5", ...reasoningOnly())
    expect(sse).toContain("Kiro closed the response stream without assistant output")
    expect(sse).not.toContain('"type":"message_stop"')
  })

  // With display omitted, Kiro can emit only a signature before a tool call. OpenCode ignores an
  // empty thinking block, so keep it alive with a space and map that space back to empty on replay.
  const signatureOnly = () => [
    encodeKiroEvent("reasoningContentEvent", { signature: "sig_hidden" }),
    encodeKiroEvent("toolUseEvent", { toolUseId: "signed-tool", name: "bash", input: '{"command":"ls"}', stop: true }),
  ]

  it("signature-only reasoning waits for tool output", async () => {
    const res = await preflight(...signatureOnly())
    expect(res.status).toBe(200)
  })

  it("signature-only reasoning is retained", async () => {
    const sse = await streamedSse("claude-fable-5", ...signatureOnly())
    expect(sse).toContain('"type":"thinking_delta","thinking":" "')
    expect(sse).toContain('"type":"signature_delta","signature":"sig_hidden"')
    expect(sse).toContain('"id":"signed-tool"')
    expect(sse).toContain('"stop_reason":"tool_use"')
  })

  it("reasoning followed by text completes", async () => {
    const sse = await streamedSse(
      "claude-fable-5",
      encodeKiroEvent("reasoningContentEvent", { text: "working" }),
      encodeKiroEvent("reasoningContentEvent", { signature: "sig_2" }),
      encodeKiroEvent("assistantResponseEvent", { content: "done" }),
    )
    expect(sse).toContain('"type":"thinking_delta","thinking":"working"')
    expect(sse).toContain('"type":"text_delta","text":"done"')
    expect(sse).toContain('"type":"message_stop"')
    expect(sse).not.toContain("without assistant output")
  })
})

// Native Kiro CLI receives packed turn-reconstruction state as a redactedContent blob. Convert
// only a decoded .KTR~~ envelope to the equivalent signature carrier OpenCode can persist.
describe("redacted KTR reasoning", () => {
  const ktrSignature = ".KTR~~eyJ2IjoxLCJtb2RlbEhhc2giOiJ0ZXN0Iiwic2xvdHMiOltdfQ=="
  const ktrFrames = () => [
    encodeKiroEvent("reasoningContentEvent", { redactedContent: Buffer.from(ktrSignature).toString("base64") }),
    encodeKiroEvent("toolUseEvent", { toolUseId: "ktr-tool", name: "bash", input: "{}", stop: true }),
  ]

  it("redacted KTR reasoning passes preflight", async () => {
    const res = await preflight(...ktrFrames())
    expect(res.status).toBe(200)
  })

  it("redacted KTR reasoning becomes a replayable signature", async () => {
    const sse = await streamedSse("auto", ...ktrFrames())
    expect(sse).toContain('"type":"thinking_delta","thinking":"..."')
    expect(sse).toContain(`"type":"signature_delta","signature":"${ktrSignature}"`)
    expect(sse).toContain('"id":"ktr-tool"')
  })

  it("opaque redacted reasoning is not misclassified", async () => {
    const res = await preflight(
      encodeKiroEvent("reasoningContentEvent", { redactedContent: Buffer.from("opaque").toString("base64") }),
    )
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("without assistant output")
  })
})

describe("content filter", () => {
  it("content filter mapping", async () => {
    const res = await preflight(
      encodeKiroEvent("initial-response", { conversationId: "" }),
      encodeKiroEvent("metadataEvent", {
        stopReason: "CONTENT_FILTERED",
        stopDetails: {
          refusal: {
            category: "REASONING_EXTRACTION",
            explanation: "Select a different model or start a new conversation.",
          },
        },
      }),
      encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 19.88 }),
    )
    expect(res.status).toBe(400)
    const body = await errorBody(res)
    expect(body.error?.type).toBe("invalid_request_error")
    expect(body.error?.message).toContain("REASONING_EXTRACTION")
    expect(body.error?.message).toContain("Select a different model")
    expect(body.error?.message).toContain("Retrying the unchanged conversation will not help")
  })
})

// HTTP error mapping -> context overflow phrase opencode recognizes.
describe("mapKiroError", () => {
  it("overflow mapping", () => {
    const mapped = mapKiroError(
      JSON.stringify({ reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD", message: "Input content length exceeds threshold." }),
      400,
    )
    expect(mapped.status).toBe(400)
    expect(mapped.body.toLowerCase()).toContain("prompt is too long")
  })

  it("passthrough", () => {
    expect(mapKiroError("boom", 500).body).toBe("boom")
  })
})
