// Combined regression smoke test after the release cleanup.
import { toKiroRequest, kiroToAnthropicStream, mapKiroError, preflightKiroResponse } from "../src/transform"
import { KiroApiKeyPlugin, KiroAuthPlugin } from "../src/plugin"
import type { KiroDebugContext } from "../src/debug"
import { resolveContextLimit } from "../src/limits"

const checks: Array<[string, boolean]> = []

const AUTH = { authorization: "Bearer t" }
const cur = (body: any) => JSON.parse(toKiroRequest(body, AUTH, "a").init.body as string).conversationState.currentMessage.userInputMessage

// 1) Tool-result continuation -> empty content, tool results carried in context.
const tr = cur({
  model: "claude-sonnet-4.6",
  tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
  ],
})
checks.push(["tool-result content empty", tr.content === ""])
checks.push(["tool-result carried", Boolean(tr.userInputMessageContext.toolResults)])

// 2) No tools sent + history has tool blocks (compaction): flatten to text, no toolConfig.
const flat = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "user", content: "summarize please" },
      ],
    } as any,
    AUTH,
    "a",
  ).init.body as string,
).conversationState
const flatHasToolStruct = flat.history.some(
  (e: any) => e.assistantResponseMessage?.toolUses || e.userInputMessage?.userInputMessageContext?.toolResults,
)
const flatHasCalledText = JSON.stringify(flat.history).includes("[called edit")
checks.push(["no-tools flattens tool blocks", !flatHasToolStruct && flatHasCalledText])
checks.push(["no-tools current has no toolConfig", (flat.currentMessage.userInputMessage.userInputMessageContext.tools ?? []).length === 0])

// 3) Image trimming: default keep=2 across 3 image turns drops the oldest.
delete process.env.KIRO_KEEP_IMAGE_TURNS
const img = (d: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: d } })
const payload = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: [img("OLD")] },
        { role: "assistant", content: "a" },
        { role: "user", content: [img("MID")] },
        { role: "assistant", content: "b" },
        { role: "user", content: [{ type: "text", text: "see" }, img("NEW")] },
      ],
    } as any,
    AUTH,
    "a",
  ).init.body as string,
)
const allImgs = [...payload.conversationState.history, payload.conversationState.currentMessage]
  .flatMap((e: any) => (e.userInputMessage?.images ?? []).map((i: any) => i.source.bytes))
checks.push(["drops oldest image", !allImgs.includes("OLD") && allImgs.includes("MID") && allImgs.includes("NEW")])

// 4) Usage from context percentage.
function frame(eventType: string, p: unknown, headerName = ":event-type"): Buffer {
  const b = Buffer.from(JSON.stringify(p)); const name = Buffer.from(headerName); const v = Buffer.from(eventType)
  const vl = Buffer.alloc(2); vl.writeUInt16BE(v.length)
  const h = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), vl, v])
  const total = 12 + h.length + b.length + 4; const buf = Buffer.alloc(total); let o = 0
  buf.writeUInt32BE(total, o); o += 4; buf.writeUInt32BE(h.length, o); o += 4; buf.writeUInt32BE(0, o); o += 4
  h.copy(buf, o); o += h.length; b.copy(buf, o); o += b.length; buf.writeUInt32BE(0, o); return buf
}
function chunkedResponse(...chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  )
}
const successfulResponse = chunkedResponse(
  frame("assistantResponseEvent", { content: "hello" }),
  frame("contextUsageEvent", { contextUsagePercentage: 5 }),
)
const preparedResponse = await preflightKiroResponse(successfulResponse)
checks.push(["successful stream preflight", preparedResponse.status === 200])
const out = await kiroToAnthropicStream(preparedResponse, "claude-sonnet-4.6", 1_000_000).text()
const delta = out.split("\n").find((l) => l.startsWith("data:") && l.includes("message_delta"))
const usage = delta ? JSON.parse(delta.slice(5)).usage : null
checks.push(["usage input tokens", usage?.input_tokens === 50_000])

// 5) In-band throttling -> HTTP 429 so opencode's outer retry loop sees it.
const originalRetrySeconds = process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
const throttledFrame = frame("ThrottlingException", { message: "Rate exceeded", retryAfterSeconds: 3 }, ":exception-type")
const throttledResponse = chunkedResponse(
  throttledFrame.subarray(0, 9),
  throttledFrame.subarray(9),
)
const mappedStreamError = await preflightKiroResponse(throttledResponse)
const mappedStreamBody = await mappedStreamError.json() as any
checks.push([
  "stream throttle mapping",
  mappedStreamError.status === 429 &&
    mappedStreamError.headers.get("retry-after") === "3" &&
    mappedStreamBody?.error?.type === "rate_limit_error",
])
const noDelayResponse = await preflightKiroResponse(
  chunkedResponse(frame("TooManyRequestsException", { message: "Slow down" }, ":exception-type")),
)
checks.push(["default retry backoff preserved", noDelayResponse.headers.get("retry-after") === null])
process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = "10"
const fixedDelayResponse = await preflightKiroResponse(
  chunkedResponse(frame("TooManyRequestsException", { message: "Slow down" }, ":exception-type")),
)
checks.push([
  "configured fixed retry delay",
  fixedDelayResponse.status === 429 && fixedDelayResponse.headers.get("retry-after") === "10",
])
if (originalRetrySeconds === undefined) delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
else process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = originalRetrySeconds

// 6) Pre-output timeout -> retryable HTTP error, never a successful empty turn.
const timedOutResponse = await preflightKiroResponse(
  chunkedResponse(frame("error", { message: "TimeoutError: The operation timed out." })),
)
const timedOutBody = await timedOutResponse.json() as any
checks.push([
  "stream timeout mapping",
  timedOutResponse.status === 504 &&
    timedOutBody?.error?.type === "api_error" &&
    timedOutBody?.error?.message.includes("timed out"),
])
const thrownTimeoutResponse = await preflightKiroResponse(
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("The operation timed out.", "TimeoutError"))
      },
    }),
  ),
)
checks.push([
  "transport timeout mapping",
  thrownTimeoutResponse.status === 504 &&
    (await thrownTimeoutResponse.text()).includes("TimeoutError: The operation timed out."),
])

// 7) Metadata and empty assistant events are not model output.
const emptyResponse = await preflightKiroResponse(
  chunkedResponse(
    frame("assistantResponseEvent", { content: "" }),
    frame("contextUsageEvent", { contextUsagePercentage: 19.8811 }),
    frame("meteringEvent", { usage: 1 }),
  ),
)
const emptyBody = await emptyResponse.json() as any
checks.push([
  "empty stream mapping",
  emptyResponse.status === 502 &&
    emptyBody?.error?.type === "api_error" &&
    emptyBody?.error?.message.includes("without assistant output"),
])
const bodylessResponse = await preflightKiroResponse(new Response(null))
checks.push([
  "bodyless response mapping",
  bodylessResponse.status === 502 && (await bodylessResponse.text()).includes("without an event stream"),
])
const emptyToolResponse = await preflightKiroResponse(
  chunkedResponse(frame("toolUseEvent", { toolUseId: "orphan-stop", stop: true })),
)
checks.push([
  "empty tool event mapping",
  emptyToolResponse.status === 502 && (await emptyToolResponse.text()).includes("without assistant output"),
])
// A complete tool call packed into one frame (input + stop together) is real output:
// preflight must replay it and the SSE converter must emit a full tool_use block.
const singleFrameToolResponse = await preflightKiroResponse(
  chunkedResponse(
    frame("toolUseEvent", { toolUseId: "one-shot", name: "bash", input: '{"command":"ls"}', stop: true }),
    frame("contextUsageEvent", { contextUsagePercentage: 5 }),
  ),
)
checks.push(["single-frame tool call passes preflight", singleFrameToolResponse.status === 200])
const singleFrameSse = await kiroToAnthropicStream(singleFrameToolResponse, "claude-sonnet-4.6").text()
checks.push([
  "single-frame tool call streamed",
  singleFrameSse.includes('"type":"tool_use"') &&
    singleFrameSse.includes('"id":"one-shot"') &&
    singleFrameSse.includes('"partial_json":"{\\"command\\":\\"ls\\"}"') &&
    singleFrameSse.includes('"stop_reason":"tool_use"'),
])
// The observed multi-frame shape (start, input deltas, stop) must keep working unchanged.
const multiFrameToolResponse = await preflightKiroResponse(
  chunkedResponse(
    frame("toolUseEvent", { toolUseId: "multi", name: "bash" }),
    frame("toolUseEvent", { toolUseId: "multi", name: "bash", input: '{"command"' }),
    frame("toolUseEvent", { toolUseId: "multi", name: "bash", input: ':"ls"}' }),
    frame("toolUseEvent", { toolUseId: "multi", name: "bash", stop: true }),
  ),
)
checks.push(["multi-frame tool call passes preflight", multiFrameToolResponse.status === 200])
const multiFrameSse = await kiroToAnthropicStream(multiFrameToolResponse, "claude-sonnet-4.6").text()
checks.push([
  "multi-frame tool call streamed once",
  multiFrameSse.split('"content_block_start"').length - 1 === 1 &&
    multiFrameSse.includes('"id":"multi"') &&
    multiFrameSse.includes('"partial_json":"{\\"command\\""') &&
    multiFrameSse.includes('"stop_reason":"tool_use"'),
])
const filteredResponse = await preflightKiroResponse(
  chunkedResponse(
    frame("initial-response", { conversationId: "" }),
    frame("metadataEvent", {
      stopReason: "CONTENT_FILTERED",
      stopDetails: {
        refusal: {
          category: "REASONING_EXTRACTION",
          explanation: "Select a different model or start a new conversation.",
        },
      },
    }),
    frame("contextUsageEvent", { contextUsagePercentage: 19.88 }),
  ),
)
const filteredBody = await filteredResponse.json() as any
checks.push([
  "content filter mapping",
  filteredResponse.status === 400 &&
    filteredBody?.error?.type === "invalid_request_error" &&
    filteredBody?.error?.message.includes("REASONING_EXTRACTION") &&
    filteredBody?.error?.message.includes("Select a different model") &&
    filteredBody?.error?.message.includes("Retrying the unchanged conversation will not help"),
])

// 8) Debug diagnostics expose request/event shapes without transcript content.
const originalDebug = process.env.KIRO_DEBUG
process.env.KIRO_DEBUG = "1"
const debugLines: string[] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => debugLines.push(args.map(String).join(" "))
try {
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
      frame("assistantResponseEvent", { content: "SECRET_MODEL_OUTPUT" }),
      frame("metadataEvent", { stopReason: "end_turn" }),
      frame("contextUsageEvent", { contextUsagePercentage: 7 }),
    ),
    debug,
  )
  await kiroToAnthropicStream(debugResponse, "claude-sonnet-4.6", 1_000_000, debug).text()
} finally {
  console.error = originalConsoleError
  if (originalDebug === undefined) delete process.env.KIRO_DEBUG
  else process.env.KIRO_DEBUG = originalDebug
}
const debugOutput = debugLines.join("\n")
checks.push([
  "debug diagnostics emitted",
  debugOutput.includes('"trace":"debug-smoke"') &&
    debugOutput.includes('"event":"request.history_shape"') &&
    debugOutput.includes('"event":"request.history_entry"') &&
    debugOutput.includes('"event":"response.event"') &&
    debugOutput.includes('"contentChars":19') &&
    debugOutput.includes('"stopReason":"end_turn"'),
])
checks.push([
  "debug diagnostics redact content",
  !debugOutput.includes("SECRET_PROMPT_TEXT") &&
    !debugOutput.includes("SECRET_ASSISTANT_TEXT") &&
    !debugOutput.includes("SECRET_MODEL_OUTPUT") &&
    !debugOutput.includes("SECRET_ACCESS_TOKEN") &&
    !debugOutput.includes("SECRET_PROFILE_ARN"),
])

const recursiveDebugLines: string[] = []
console.error = (...args: unknown[]) => recursiveDebugLines.push(args.map(String).join(" "))
process.env.KIRO_DEBUG = "1"
try {
  const { kiroDebug } = await import("../src/debug")
  kiroDebug(
    { id: "recursive-redaction", startedAt: Date.now() },
    "test.secret",
    { nested: { apiKey: "ksk_must_not_log", authorization: "Bearer oauth-secret-123" } },
  )
} finally {
  console.error = originalConsoleError
  if (originalDebug === undefined) delete process.env.KIRO_DEBUG
  else process.env.KIRO_DEBUG = originalDebug
}
const recursiveDebugOutput = recursiveDebugLines.join("\n")
checks.push([
  "debug recursively redacts credentials",
  recursiveDebugOutput.includes("ksk_<redacted>") &&
    recursiveDebugOutput.includes("Bearer <redacted>") &&
    !recursiveDebugOutput.includes("must_not_log") &&
    !recursiveDebugOutput.includes("oauth-secret-123"),
])

// 9) HTTP error mapping -> context overflow phrase.
const mapped = mapKiroError(JSON.stringify({ reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD", message: "Input content length exceeds threshold." }), 400)
checks.push(["overflow mapping", mapped.status === 400 && mapped.body.toLowerCase().includes("prompt is too long")])
checks.push(["passthrough", mapKiroError("boom", 500).body === "boom"])

// 10) Mixed tool_result + text turn WITH tools present: inline result, unpair tool_use.
const mixed = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      tools: [{ name: "screenshot", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "ss1", name: "screenshot", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "ss1", content: "shot-data" },
            { type: "text", text: "Create a summary of the conversation." },
          ],
        },
      ],
    } as any,
    AUTH,
    "a",
  ).init.body as string,
).conversationState
const mixedCurrent = mixed.currentMessage.userInputMessage
const mixedPrevAsst = mixed.history[mixed.history.length - 1].assistantResponseMessage
checks.push(["mixed turn drops structured toolResults", mixedCurrent.userInputMessageContext.toolResults === undefined])
checks.push(["mixed turn keeps text", mixedCurrent.content.includes("Create a summary") && mixedCurrent.content.includes("shot-data")])
checks.push(["preceding assistant unpaired", mixedPrevAsst.toolUses === undefined])

// 11) Pure tool-result continuation (no text) WITH tools present stays structured.
const pure = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "out" }] },
      ],
    } as any,
    AUTH,
    "a",
  ).init.body as string,
).conversationState
checks.push(["pure continuation keeps toolResults", Boolean(pure.currentMessage.userInputMessage.userInputMessageContext.toolResults)])

// 12) Orphan tool_use WITH tools present (compaction cut): degraded to text on both sides.
const orphan = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "orph", name: "bash", input: { cmd: "ls" } }] },
        { role: "user", content: "what did you find?" }, // no tool_result -> orphan tool_use
      ],
    } as any,
    AUTH,
    "a",
  ).init.body as string,
).conversationState
const orphanHasToolUse = orphan.history.some((e: any) => e.assistantResponseMessage?.toolUses)
const orphanHasCalledText = JSON.stringify(orphan.history).includes("[called bash")
checks.push(["orphan tool_use degraded", !orphanHasToolUse && orphanHasCalledText])

// A history cut can make a tool-result continuation the first user turn. Folding the
// system prompt into it makes the turn mixed, so normalize after folding and flatten it.
const systemOnResult = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      system: "system",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "cut1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "cut1", content: "result" }] },
        { role: "user", content: "continue" },
      ],
    } as any,
    AUTH,
    "a",
  ).init.body as string,
).conversationState
checks.push([
  "system mixed with first tool result is flattened",
  !JSON.stringify(systemOnResult.history).includes("toolResults") &&
    !JSON.stringify(systemOnResult.history).includes("toolUses") &&
    JSON.stringify(systemOnResult.history).includes("result"),
])

// 13) Variant -> additionalModelRequestFields mapping (Claude vs GPT vs none).
const fields = (model: string, effort?: string) =>
  JSON.parse(toKiroRequest({ model, messages: [{ role: "user", content: "hi" }] } as any, AUTH, "a", effort).init.body as string)
    .additionalModelRequestFields
const claudeFields = fields("claude-fable-5", "max")
checks.push(["claude variant -> output_config.effort", claudeFields?.output_config?.effort === "max" && claudeFields?.thinking?.type === "adaptive"])
checks.push(["gpt variant -> reasoning.effort", fields("gpt-5.6-sol", "xhigh")?.reasoning?.effort === "xhigh"])
checks.push(["no variant -> no extra fields", fields("claude-fable-5") === undefined])

// 14) Only the exact active model may expose one of its configured variants as effort.
const fakeClient = {
  session: {
    message: async ({ path }: any) => ({
      data: {
        info: {
          role: "assistant",
          providerID: path.messageID === "api-message" ? "kiro-api" : "kiro",
        },
      },
    }),
  },
  auth: { set: async () => ({}) },
} as any
const pluginInput = { client: fakeClient } as any
const hooks = await KiroAuthPlugin(pluginInput)
const effortHeader = async (activeModel: string, supported: string[], selectedModel: string, variant: string) => {
  const output = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]!(
    {
      model: {
        id: activeModel,
        providerID: "kiro",
        variants: Object.fromEntries(supported.map((value) => [value, {}])),
      },
      message: { model: { providerID: "kiro", modelID: selectedModel, variant } },
    } as any,
    output,
  )
  return output.headers["x-kiro-effort"]
}
checks.push(["matching model exposes effort", (await effortHeader("gpt-5.6-sol", ["max"], "gpt-5.6-sol", "max")) === "max"])
checks.push(["auxiliary model drops effort", (await effortHeader("claude-haiku-4.5", [], "gpt-5.6-sol", "max")) === undefined])
checks.push(["unsupported effort dropped", (await effortHeader("claude-sonnet-5", ["low"], "claude-sonnet-5", "max")) === undefined])

const originalApiKey = process.env.KIRO_API_KEY
delete process.env.KIRO_API_KEY
const apiHooks = await KiroApiKeyPlugin(pluginInput)
const mirrored = async (input: any) => {
  await apiHooks.config!(input)
  return input.provider?.["kiro-api"]
}
const fromKiro = await mirrored({
  provider: { kiro: { name: "Kiro", npm: "@ai-sdk/anthropic", models: { "claude-sonnet-4.6": {} } } },
})
checks.push([
  "kiro-api inherits kiro models",
  Object.keys(fromKiro?.models ?? {}).join() === "claude-sonnet-4.6" && fromKiro?.npm === "@ai-sdk/anthropic",
])
checks.push(["kiro-api gets a distinct name", fromKiro?.name === "Kiro (API key)"])

const overridden = await mirrored({
  provider: {
    kiro: { name: "Kiro", models: { "claude-sonnet-4.6": {} } },
    "kiro-api": { name: "Custom", models: { "claude-opus-5": {} } },
  },
})
checks.push([
  "explicit kiro-api config preserved",
  overridden?.name === "Custom" && Object.keys(overridden?.models ?? {}).join() === "claude-opus-5",
])

const partialOverride = await mirrored({
  provider: {
    kiro: {
      name: "Kiro",
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "https://kiro.local" },
      models: { "claude-sonnet-4.6": {} },
    },
    "kiro-api": { name: "Custom", options: { custom: true } },
  },
})
checks.push([
  "partial kiro-api config inherits models",
  Object.keys(partialOverride?.models ?? {}).join() === "claude-sonnet-4.6" &&
    partialOverride?.npm === "@ai-sdk/anthropic" &&
    partialOverride?.options?.baseURL === "https://kiro.local" &&
    partialOverride?.options?.custom === true &&
    typeof partialOverride?.options?.fetch === "function" &&
    partialOverride?.options?.apiKey === "",
])

const noSource = await mirrored({ provider: {} })
checks.push(["no kiro block -> no kiro-api injected", noSource === undefined])

const oauthLabels = (hooks.auth!.methods as any[]).map((m) => `${m.type}:${m.label}`)
const apiLabels = (apiHooks.auth!.methods as any[]).map((m) => `${m.type}:${m.label}`)
checks.push([
  "kiro exposes only device flows",
  hooks.auth!.provider === "kiro" && oauthLabels.length === 2 && oauthLabels.every((l) => l.startsWith("oauth:")),
])
checks.push([
  "kiro-api exposes only the api method",
  apiHooks.auth!.provider === "kiro-api" && apiLabels.length === 1 && apiLabels[0].startsWith("api:"),
])
checks.push([
  "web_search registered once",
  hooks.tool === undefined && Object.keys(apiHooks.tool ?? {}).join() === "web_search",
])

const webSearchTool = apiHooks.tool!.web_search
const toolError = async (messageID: string) => {
  try {
    await webSearchTool.execute(
      { query: "test" } as never,
      { sessionID: "session", messageID, directory: "/tmp" } as never,
    )
    return ""
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
checks.push([
  "web_search routes to oauth provider",
  (await toolError("oauth-message")).includes("provider kiro"),
])
checks.push([
  "web_search routes to api provider",
  (await toolError("api-message")).includes("auth login --provider kiro-api"),
])
if (originalApiKey === undefined) delete process.env.KIRO_API_KEY
else process.env.KIRO_API_KEY = originalApiKey

const limitsClient = {
  config: {
    providers: async () => ({
      data: {
        providers: [
          { id: "kiro", models: { model: { limit: { context: 111_111 } } } },
          { id: "kiro-api", models: { model: { limit: { context: 999_999 } } } },
        ],
      },
    }),
  },
} as any
checks.push([
  "context limits cached per provider",
  (await resolveContextLimit(limitsClient, "kiro-api", "model")) === 999_999 &&
    (await resolveContextLimit(limitsClient, "kiro", "model")) === 111_111,
])

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
