import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createKiroFetch } from "../src/plugin"
import type { KiroSession } from "../src/session"
import { kiroResponseToAnthropic, mapKiroError } from "../src/response"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { isolateEnv } from "./support/isolation"

/** Convert a synthetic Kiro event stream built from the given frames. */
function preflight(...frames: Uint8Array[]): Promise<Response> {
  return kiroResponseToAnthropic(chunkedResponse(...frames), {
    model: "claude-sonnet-4.6",
    contextLimit: 1_000_000,
  })
}

/** Convert synthetic Kiro frames to the Anthropic SSE text a client would receive. */
async function streamedSse(model: string, ...frames: Uint8Array[]): Promise<string> {
  const response = await kiroResponseToAnthropic(chunkedResponse(...frames), {
    model,
    contextLimit: 1_000_000,
  })
  return response.text()
}

async function errorBody(res: Response): Promise<{ error?: { type?: string; message?: string } }> {
  return (await res.json()) as { error?: { type?: string; message?: string } }
}

type ParsedSseFrame = { event: string; data: Record<string, any> }

function parseSse(value: string): ParsedSseFrame[] {
  return value
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n")
      return {
        event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "",
        data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}"),
      }
    })
}

function expectEventStream(response: Response): void {
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/event-stream")
}

function expectTerminalError(frames: ParsedSseFrame[]): void {
  expect(frames.filter((frame) => frame.event === "error")).toHaveLength(1)
  expect(frames.some((frame) => frame.data.type === "message_stop")).toBe(false)
}

type ReaderStep = Uint8Array | Error | "wait" | "wait-error" | "eof"

function steppedResponse(...initialSteps: ReaderStep[]) {
  const steps = [...initialSteps]
  let reads = 0
  let cancels = 0
  let releases = 0
  let cancelReason: unknown
  let finishPendingRead: (() => void) | undefined
  let failPendingRead: (() => void) | undefined
  let cancelWait: Promise<void> | undefined
  let resolveReleased!: () => void
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve
  })

  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      reads += 1
      const step = steps.shift() ?? "eof"
      if (step instanceof Error) throw step
      if (step === "wait" || step === "wait-error") {
        return new Promise((resolve, reject) => {
          finishPendingRead = () => resolve({ done: true })
          if (step === "wait-error") failPendingRead = () => reject(new Error("read aborted"))
        })
      }
      if (step === "eof") return { done: true }
      return { done: false, value: step }
    },
    async cancel(reason?: unknown): Promise<void> {
      cancels += 1
      cancelReason = reason
      if (failPendingRead) failPendingRead()
      else finishPendingRead?.()
      finishPendingRead = undefined
      failPendingRead = undefined
      await cancelWait
    },
    releaseLock(): void {
      releases += 1
      resolveReleased()
    },
  }

  return {
    response: {
      status: 200,
      headers: new Headers({ "content-type": "application/vnd.amazon.eventstream" }),
      body: { getReader: () => reader },
    } as unknown as Response,
    stats: () => ({ reads, cancels, releases, cancelReason, remainingSteps: steps.length }),
    released,
    holdCancellation: () => {
      cancelWait = new Promise(() => {})
    },
  }
}

async function fullPipeline(...chunks: Uint8Array[]): Promise<Response> {
  const session: KiroSession = {
    async authHeaders() {
      return { authorization: "Bearer test-token" }
    },
    async chatProfileArn() {
      return "arn:aws:codewhisperer:us-east-1:111122223333:profile/STREAMTEST"
    },
    async mcpProfileArn() {
      return "arn:aws:codewhisperer:us-east-1:111122223333:profile/STREAMTEST"
    },
  }
  const fetcher = (async () => chunkedResponse(...chunks)) as unknown as typeof globalThis.fetch
  const input = {
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "kiro",
                models: { "claude-fable-5": { limit: { context: 200_000 } } },
              },
            ],
          },
        }),
      },
    },
  } as unknown as PluginInput
  const kiroFetch = createKiroFetch("kiro", "oauth", input, async () => session, { fetch: fetcher })
  return kiroFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-fable-5",
      messages: [{ role: "user", content: "run a command" }],
      tools: [
        {
          name: "bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    }),
  })
}

// Usage is derived from Kiro's contextUsageEvent percentage.
describe("usage reporting", () => {
  const successFrames = () => [
    encodeKiroEvent("assistantResponseEvent", { content: "hello" }),
    encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }),
  ]

  it("successful stream preflight", async () => {
    const prepared = await preflight(...successFrames())
    expectEventStream(prepared)
  })

  it("usage input tokens", async () => {
    const out = await streamedSse("claude-sonnet-4.6", ...successFrames())
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
    const mapped = await kiroResponseToAnthropic(
      chunkedResponse(throttledFrame.subarray(0, 9), throttledFrame.subarray(9)),
      { model: "claude-sonnet-4.6", contextLimit: 1_000_000 },
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
    const res = await kiroResponseToAnthropic(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("The operation timed out.", "TimeoutError"))
          },
        }),
      ),
      { model: "claude-sonnet-4.6", contextLimit: 1_000_000 },
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
    const res = await kiroResponseToAnthropic(new Response(null), {
      model: "claude-sonnet-4.6",
      contextLimit: 1_000_000,
    })
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
  // the merged converter must emit a full tool_use block.
  const singleFrame = () => [
    encodeKiroEvent("toolUseEvent", { toolUseId: "one-shot", name: "bash", input: '{"command":"ls"}', stop: true }),
    encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }),
  ]

  it("single-frame tool call passes preflight", async () => {
    const res = await preflight(...singleFrame())
    expectEventStream(res)
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
    expectEventStream(res)
  })

  it("multi-frame tool call streamed once", async () => {
    const sse = await streamedSse("claude-sonnet-4.6", ...multiFrame())
    expect(sse.split('"content_block_start"').length - 1).toBe(1)
    expect(sse).toContain('"id":"multi"')
    expect(sse).toContain('"partial_json":"{\\"command\\":\\"ls\\"}"')
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
    expectEventStream(res)
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
    expectTerminalError(parseSse(sse))
  })

  // With display omitted, Kiro can emit only a signature before a tool call. OpenCode ignores an
  // empty thinking block, so keep it alive with a space and map that space back to empty on replay.
  const signatureOnly = () => [
    encodeKiroEvent("reasoningContentEvent", { signature: "sig_hidden" }),
    encodeKiroEvent("toolUseEvent", { toolUseId: "signed-tool", name: "bash", input: '{"command":"ls"}', stop: true }),
  ]

  it("signature-only reasoning waits for tool output", async () => {
    const res = await preflight(...signatureOnly())
    expectEventStream(res)
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
    expectEventStream(res)
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

describe("merged response driver", () => {
  it("emits the buffered prefix in order exactly once", async () => {
    const frames = parseSse(
      await streamedSse(
        "claude-fable-5",
        encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }),
        encodeKiroEvent("reasoningContentEvent", { text: "working" }),
        encodeKiroEvent("assistantResponseEvent", { content: "done" }),
      ),
    )
    const deltas = frames
      .filter((frame) => frame.data.type === "content_block_delta")
      .map((frame) => frame.data.delta)

    expect(deltas).toEqual([
      { type: "thinking_delta", thinking: "working" },
      { type: "text_delta", text: "done" },
    ])
  })

  it("passes a pre-output stream error through once", async () => {
    const response = await preflight(
      encodeKiroEvent("InternalServerException", { message: "provider failed" }, ":exception-type"),
      encodeKiroEvent("assistantResponseEvent", { content: "after" }),
    )
    const frames = parseSse(await response.text())

    expectEventStream(response)
    expectTerminalError(frames)
    expect(frames.find((frame) => frame.event === "error")?.data.error.message).toBe("provider failed")
    expect(frames.some((frame) => frame.data.delta?.text === "after")).toBe(false)
  })

  it("cancels upstream after a terminal stream event without another read", async () => {
    const upstream = steppedResponse(
      encodeKiroEvent("assistantResponseEvent", { content: "before" }),
      encodeKiroEvent("InternalServerException", { message: "provider failed" }, ":exception-type"),
      encodeKiroEvent("assistantResponseEvent", { content: "after" }),
      "eof",
    )
    upstream.holdCancellation()
    const response = await kiroResponseToAnthropic(upstream.response, {
      model: "claude-sonnet-4.6",
      contextLimit: 1_000_000,
    })
    const frames = parseSse(await response.text())

    expectTerminalError(frames)
    expect(upstream.stats()).toEqual({
      reads: 2,
      cancels: 1,
      releases: 1,
      cancelReason: undefined,
      remainingSteps: 2,
    })
  })

  it("closes an open text block before a transport error", async () => {
    const upstream = steppedResponse(
      encodeKiroEvent("assistantResponseEvent", { content: "before" }),
      new Error("socket reset"),
    )
    const response = await kiroResponseToAnthropic(upstream.response, {
      model: "claude-sonnet-4.6",
      contextLimit: 1_000_000,
    })
    const frames = parseSse(await response.text())

    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ])
    expect(frames.at(-1)?.data.error.message).toBe("Error: socket reset")
    expectTerminalError(frames)
  })

  it("discards a pending tool before a transport error", async () => {
    const pendingTool = Buffer.concat([
      encodeKiroEvent("toolUseEvent", { toolUseId: "pending", name: "bash" }),
      encodeKiroEvent("toolUseEvent", { toolUseId: "pending", input: '{"command":"ls"' }),
    ])
    const upstream = steppedResponse(pendingTool, new Error("tool stream broke"))
    const response = await kiroResponseToAnthropic(upstream.response, {
      model: "claude-sonnet-4.6",
      contextLimit: 1_000_000,
    })
    const frames = parseSse(await response.text())

    expect(frames.filter((frame) => frame.data.content_block?.type === "tool_use")).toHaveLength(0)
    expect(frames.filter((frame) => frame.data.delta?.type === "input_json_delta")).toHaveLength(0)
    expectTerminalError(frames)
  })

  it("keeps the common transport error frame byte-identical", async () => {
    const upstream = steppedResponse(
      encodeKiroEvent("toolUseEvent", {
        toolUseId: "complete",
        name: "bash",
        input: '{"command":"ls"}',
        stop: true,
      }),
      new Error("socket reset"),
    )
    const response = await kiroResponseToAnthropic(upstream.response, {
      model: "claude-sonnet-4.6",
      contextLimit: 1_000_000,
    })
    const sse = await response.text()
    const frames = parseSse(sse)
    const expectedError =
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Error: socket reset"}}\n\n'

    expect(sse.endsWith(expectedError)).toBe(true)
    expectTerminalError(frames)
  })

  it("propagates consumer cancellation without manufacturing an error", async () => {
    const upstream = steppedResponse(
      encodeKiroEvent("assistantResponseEvent", { content: "before" }),
      "wait-error",
    )
    const response = await kiroResponseToAnthropic(upstream.response, {
      model: "claude-sonnet-4.6",
      contextLimit: 1_000_000,
    })
    const reader = response.body!.getReader()
    const received: Uint8Array[] = []
    for (let index = 0; index < 3; index++) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      received.push(next.value)
    }

    expect(new TextDecoder().decode(Buffer.concat(received))).not.toContain("event: error")
    await reader.cancel("consumer stopped")
    await upstream.released
    expect((await reader.read()).done).toBe(true)

    expect(upstream.stats()).toEqual({
      reads: 2,
      cancels: 1,
      releases: 1,
      cancelReason: "consumer stopped",
      remainingSteps: 0,
    })
  })
})

describe("injected full response pipeline", () => {
  it("turns a truncated tool announcement into one empty-turn error", async () => {
    const response = await fullPipeline(
      encodeKiroEvent("toolUseEvent", { toolUseId: "truncated", name: "bash" }),
    )
    const frames = parseSse(await response.text())

    expect(response.status).toBe(200)
    expect(frames.filter((frame) => frame.data.content_block?.type === "tool_use")).toHaveLength(0)
    expect(frames.filter((frame) => frame.event === "error")).toEqual([
      {
        event: "error",
        data: {
          type: "error",
          error: {
            type: "api_error",
            message: "Kiro closed the response stream without assistant output.",
          },
        },
      },
    ])
    expect(frames.some((frame) => frame.data.type === "message_stop")).toBe(false)
  })

  it("keeps one atomic tool call across interleaved reasoning and text", async () => {
    const response = await fullPipeline(
      encodeKiroEvent("toolUseEvent", { toolUseId: "interleaved", name: "bash" }),
      encodeKiroEvent("reasoningContentEvent", { text: "checking" }),
      encodeKiroEvent("toolUseEvent", { toolUseId: "interleaved", input: '{"command":' }),
      encodeKiroEvent("assistantResponseEvent", { content: "status" }),
      encodeKiroEvent("toolUseEvent", { toolUseId: "interleaved", input: '"ls"}' }),
      encodeKiroEvent("toolUseEvent", { toolUseId: "interleaved", stop: true }),
    )
    const frames = parseSse(await response.text())
    const starts = frames.filter((frame) => frame.data.type === "content_block_start")
    const toolStarts = starts.filter((frame) => frame.data.content_block.type === "tool_use")
    const argDeltas = frames.filter((frame) => frame.data.delta?.type === "input_json_delta")

    expect(starts.map((frame) => frame.data.content_block.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ])
    expect(starts.map((frame) => frame.data.index)).toEqual([0, 1, 2])
    expect(toolStarts).toHaveLength(1)
    expect(toolStarts[0]?.data.content_block.id).toBe("interleaved")
    expect(argDeltas).toHaveLength(1)
    expect(argDeltas[0]?.data.delta.partial_json).toBe('{"command":"ls"}')
    expect(frames.some((frame) => frame.data.delta?.stop_reason === "tool_use")).toBe(true)
  })

  it("coerces object input and emits it through the real pipeline", async () => {
    const response = await fullPipeline(
      encodeKiroEvent("toolUseEvent", {
        toolUseId: "object-input",
        name: "bash",
        input: { command: "ls" },
        stop: true,
      }),
    )
    const frames = parseSse(await response.text())
    const argDeltas = frames.filter((frame) => frame.data.delta?.type === "input_json_delta")

    expect(argDeltas).toHaveLength(1)
    expect(argDeltas[0]?.data.delta.partial_json).toBe('{"command":"ls"}')
    expect(frames.some((frame) => frame.data.type === "message_stop")).toBe(true)
  })

  it("makes a post-output stream error terminal", async () => {
    const response = await fullPipeline(
      encodeKiroEvent("assistantResponseEvent", { content: "before" }),
      encodeKiroEvent(
        "InternalServerException",
        { message: "provider failed" },
        ":exception-type",
      ),
      encodeKiroEvent("assistantResponseEvent", { content: "after" }),
    )
    const frames = parseSse(await response.text())

    expect(frames.filter((frame) => frame.event === "error")).toHaveLength(1)
    expect(frames.filter((frame) => frame.data.delta?.type === "text_delta")).toEqual([
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "before" },
        },
      },
    ])
    expect(frames.some((frame) => frame.data.type === "message_delta")).toBe(false)
    expect(frames.some((frame) => frame.data.type === "message_stop")).toBe(false)
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
