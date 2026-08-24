import { randomUUID } from "node:crypto"
import { DEFAULT_MODEL, KIRO_ORIGIN } from "./constants"
import { drainKiroEvents, readKiroEvents, type KiroEvent } from "./eventstream"
import {
  OMITTED_REASONING_SENTINEL,
  beginsAssistantOutput,
  parseKiroEvent,
  resolveRetryAfter,
  type KiroStreamEvent,
} from "./events"
import { AnthropicSseEncoder, serializeSse, type AnthropicSseEvent } from "./sse"
import {
  createKiroDebugContext,
  kiroDebug,
  kiroDebugEnabled,
  kiroDebugError,
  redactKiroSecrets,
  type KiroDebugContext,
} from "./debug"

/* ----------------------------- request mapping ----------------------------- */

type Block = Record<string, any>
type Message = { role: string; content: string | Block[] }
type AnthropicRequest = {
  model?: string
  system?: string | Block[]
  messages?: Message[]
  tools?: Block[]
  [key: string]: unknown
}

/**
 * Build the additionalModelRequestFields for Kiro based on model + selected variant.
 * Returns undefined when no special fields are needed (no variant selected).
 *
 * Claude models use:  { thinking: { type, display? }, output_config: { effort } }
 * GPT models use:     { reasoning: { effort, mode? } }
 */
function buildModelRequestFields(modelId: string, effort?: string): Record<string, any> | undefined {
  if (!effort) return undefined

  if (modelId.startsWith("gpt-")) {
    return { reasoning: { effort } }
  }

  if (modelId.startsWith("claude-")) {
    return {
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort },
    }
  }

  return undefined
}

const ENV_STATE = {
  operatingSystem: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  currentWorkingDirectory: process.cwd(),
  environmentVariables: [] as string[],
}

/**
 * Format the local time exactly like kiro-cli's CONTEXT ENTRY, e.g.
 * "Friday, 2026-06-12T20:09:05.270+07:00" (long weekday + ISO8601 local time with ms
 * and numeric UTC offset). Verified against a live kiro-cli request capture.
 */
function currentTimestamp(d: Date = new Date()): string {
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" })
  const pad = (n: number, len = 2) => String(n).padStart(len, "0")
  const offsetMin = -d.getTimezoneOffset() // minutes east of UTC
  const sign = offsetMin >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  return (
    `${weekday}, ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * Wrap the current user turn exactly like kiro-cli: a CONTEXT ENTRY block carrying the
 * current local time, followed by the USER MESSAGE markers. Matches the byte-for-byte
 * framing observed in a live GenerateAssistantResponse capture:
 *   --- CONTEXT ENTRY BEGIN ---
 *   Current time: <ts>
 *   --- CONTEXT ENTRY END ---
 *
 *   --- USER MESSAGE BEGIN ---
 *   <text>--- USER MESSAGE END ---
 */
function wrapCurrentContent(text: string): string {
  return (
    "--- CONTEXT ENTRY BEGIN ---\n" +
    `Current time: ${currentTimestamp()}\n` +
    "--- CONTEXT ENTRY END ---\n\n" +
    `--- USER MESSAGE BEGIN ---\n${text}--- USER MESSAGE END ---`
  )
}

function textOf(content: string | Block[]): string {
  if (typeof content === "string") return content
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
}

function contentShape(content: string | Block[]) {
  if (typeof content === "string") return { textChars: content.length, blockTypes: { string: 1 } }

  const blockTypes: Record<string, number> = {}
  let textChars = 0
  let imageBytes = 0
  const toolUses: Array<{ id: string; name: string }> = []
  const toolResults: Array<{ toolUseId: string; contentChars: number; isError: boolean }> = []
  for (const block of content) {
    const type = typeof block?.type === "string" ? block.type : "unknown"
    blockTypes[type] = (blockTypes[type] ?? 0) + 1
    if (type === "text" && typeof block.text === "string") textChars += block.text.length
    if (isImageBlock(block) && typeof block.source.data === "string") imageBytes += block.source.data.length
    if (type === "tool_use") {
      toolUses.push({
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
      })
    }
    if (type === "tool_result") {
      toolResults.push({
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        contentChars: stringifyResultContent(block.content).length,
        isError: block.is_error === true,
      })
    }
  }
  return { textChars, imageBytes, blockTypes, toolUses, toolResults }
}

function systemText(system: AnthropicRequest["system"]): string {
  if (!system) return ""
  return typeof system === "string" ? system : textOf(system)
}

function toolSpecs(tools?: Block[]) {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name,
      description: t.description ?? "",
      inputSchema: { json: t.input_schema ?? t.inputSchema ?? { type: "object", properties: {} } },
    },
  }))
}

/**
 * Normalize tool_use/tool_result blocks so the request always satisfies Bedrock's tool rules,
 * which kiro-cli only ever sends in clean form. A tool id is kept as a structured pair only if:
 *   - the request actually carries tools (`keepStructured`),
 *   - both its tool_use and tool_result are present (no orphan from a compaction cut), and
 *   - the tool_result turn isn't mixed with regular text after retry turns have been split.
 * Every other tool_use/tool_result (orphans, malformed mixed turns, and all blocks on tool-less
 * requests like compaction/summaries) is degraded to plain text on BOTH sides, keeping the
 * conversation valid while preserving the information.
 */
function normalizeToolBlocks(messages: Message[], keepStructured: boolean): void {
  const info = new Map<string, { use: boolean; result: boolean; mixed: boolean }>()
  const entry = (id: string) => {
    let x = info.get(id)
    if (!x) info.set(id, (x = { use: false, result: false, mixed: false }))
    return x
  }
  for (const m of messages) {
    if (typeof m.content === "string") continue
    const hasText = m.content.some((b) => b?.type === "text" && (b.text ?? "").trim().length > 0)
    for (const b of m.content) {
      if (b?.type === "tool_use" && b.id) entry(b.id).use = true
      if (b?.type === "tool_result" && b.tool_use_id) {
        const x = entry(b.tool_use_id)
        x.result = true
        if (hasText) x.mixed = true
      }
    }
  }
  const keepId = (id: string) => {
    const x = info.get(id)
    return keepStructured && !!x && x.use && x.result && !x.mixed
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (typeof m.content === "string") continue
    if (!m.content.some((b) => b?.type === "tool_use" || b?.type === "tool_result")) continue
    messages[i] = {
      ...m,
      content: m.content.map((b) => {
        if (b?.type === "tool_use" && !keepId(b.id)) {
          const input = b.input && Object.keys(b.input).length ? ` ${JSON.stringify(b.input)}` : ""
          return { type: "text", text: `[called ${b.name}${input}]` }
        }
        if (b?.type === "tool_result" && !keepId(b.tool_use_id)) {
          return { type: "text", text: `[tool result]\n${stringifyResultContent(b.content)}`.trim() }
        }
        return b
      }),
    }
  }
}

const TOOL_RETRY_BOUNDARY = "The tool calls completed before the next user message."

/**
 * Bedrock rejects a user turn containing both tool_result blocks and ordinary text. OpenCode can
 * create that shape when a user manually retries after a completed tool turn: the adapter merges
 * the stale results with the new text. Preserve the real tool protocol, then separate the new
 * user message with an assistant boundary so Kiro does not treat protocol markers as user text.
 */
function splitMixedToolResultTurns(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== "user" || typeof message.content === "string") continue

    const results = message.content.filter((block) => block?.type === "tool_result")
    const rest = message.content.filter((block) => block?.type !== "tool_result")
    if (!results.length || !rest.some((block) => block?.type === "text" && (block.text ?? "").trim().length > 0)) {
      continue
    }

    messages.splice(
      i,
      1,
      { ...message, content: results },
      { role: "assistant", content: TOOL_RETRY_BOUNDARY },
      { ...message, content: rest },
    )
    i += 2
  }
}

function toolResults(content: string | Block[]) {
  if (typeof content === "string") return undefined
  const results = content.filter((b) => b?.type === "tool_result")
  if (!results.length) return undefined
  return results.map((r) => ({
    toolUseId: r.tool_use_id,
    content: [{ text: typeof r.content === "string" ? r.content : JSON.stringify(r.content) }],
    status: r.is_error ? "error" : "success",
  }))
}

function stringifyResultContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n")
  }
  return content == null ? "" : JSON.stringify(content)
}

function toolUses(content: string | Block[]) {
  if (typeof content === "string") return undefined
  const uses = content.filter((b) => b?.type === "tool_use")
  if (!uses.length) return undefined
  return uses.map((u) => ({ toolUseId: u.id, name: u.name, input: u.input ?? {} }))
}

const IMAGE_FORMATS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
}

function isImageBlock(b: Block): boolean {
  return b?.type === "image" && b.source?.type === "base64" && b.source?.data
}

function images(content: string | Block[]) {
  if (typeof content === "string") return undefined
  const imgs = content.filter(isImageBlock)
  if (!imgs.length) return undefined
  return imgs.map((b) => ({ format: IMAGE_FORMATS[b.source.media_type] ?? "png", source: { bytes: b.source.data } }))
}

function hasImages(content: string | Block[]): boolean {
  return typeof content !== "string" && content.some(isImageBlock)
}

// Number of most-recent image-bearing turns whose images are sent to Kiro. Older images are
// dropped from history (replaced with a placeholder) to keep the request under Kiro's
// content-length threshold, which base64 images blow past in long sessions. Override with
// KIRO_KEEP_IMAGE_TURNS (0 strips all images).
const DEFAULT_KEEP_IMAGE_TURNS = 2

function keepImageTurns(): number {
  const raw = process.env.KIRO_KEEP_IMAGE_TURNS
  const n = raw != null ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_KEEP_IMAGE_TURNS
}

function userEntry(
  msg: Message,
  modelId: string,
  tools?: ReturnType<typeof toolSpecs>,
  isCurrent = false,
  keepImages = true,
) {
  const context: Record<string, unknown> = { envState: ENV_STATE }
  const tr = toolResults(msg.content)
  if (tr) context.toolResults = tr
  if (tools) context.tools = tools
  const imgs = keepImages ? images(msg.content) : undefined
  const rawText = textOf(msg.content)
  const hasToolResults = Boolean(tr)
  const droppedImages = !keepImages && hasImages(msg.content)

  // A tool-result continuation turn carries no user text — only the tool_result blocks,
  // which live in userInputMessageContext.toolResults. kiro-cli sends these with empty
  // content and no USER MESSAGE framing. If we instead wrap whitespace in the USER MESSAGE
  // markers, the model reads it as a blank user turn and replies "you sent an empty message"
  // while ignoring the tool result. So only fabricate a user message when there is real text.
  // When we drop a dated image with no accompanying text, leave a marker so the turn isn't blank.
  let text: string
  if (rawText) text = rawText
  else if (droppedImages && !hasToolResults) text = "[image omitted]"
  else text = hasToolResults ? "" : " "
  const content = isCurrent && text ? wrapCurrentContent(text) : text

  return {
    userInputMessage: {
      // The current turn carries kiro-cli's CONTEXT ENTRY + USER MESSAGE framing; prior
      // turns are sent as-is, matching how kiro-cli replays history.
      content,
      userInputMessageContext: context,
      origin: KIRO_ORIGIN,
      modelId,
      ...(imgs ? { images: imgs } : {}),
    },
  }
}

function assistantEntry(msg: Message) {
  const tu = toolUses(msg.content)
  let reasoning: Block | undefined
  if (typeof msg.content !== "string") {
    // Kiro accepts one reasoning carrier per assistant message. Match KAS by replaying the last
    // complete phase when a turn contains multiple signed thinking blocks.
    for (const block of msg.content) {
      if (
        block?.type === "thinking" &&
        typeof block.thinking === "string" &&
        typeof block.signature === "string" &&
        block.signature.length > 0
      ) {
        reasoning = block
      }
    }
  }
  return {
    assistantResponseMessage: {
      content: textOf(msg.content),
      ...(tu ? { toolUses: tu } : {}),
      ...(reasoning
        ? {
            reasoningContent: {
              reasoningText: {
                text: reasoning.thinking === OMITTED_REASONING_SENTINEL ? "" : reasoning.thinking,
                signature: reasoning.signature,
              },
            },
          }
        : {}),
    },
  }
}

/** Map an Anthropic Messages request to a Kiro GenerateAssistantResponse payload. */
export function toKiroPayload(
  body: AnthropicRequest,
  effort?: string,
  debug: KiroDebugContext = createKiroDebugContext(),
) {
  const modelId = body.model || DEFAULT_MODEL

  // CodeWhisperer has no system role: fold the system prompt into the first user turn.
  const messages = (body.messages ?? []).map((m) => ({ ...m }))
  const tools = toolSpecs(body.tools)

  // Split genuine retry text before folding the system prompt. If a history cut leaves a tool
  // result as the first user turn, the folded system text still makes that pair malformed and the
  // normalizer deliberately degrades it to text.
  if (tools) splitMixedToolResultTurns(messages)

  const sys = systemText(body.system)
  if (sys) {
    const firstUser = messages.find((m) => m.role === "user")
    if (firstUser) {
      firstUser.content =
        typeof firstUser.content === "string"
          ? `${sys}\n\n${firstUser.content}`
          : [{ type: "text", text: sys }, ...firstUser.content]
    }
  }

  normalizeToolBlocks(messages, Boolean(tools))

  // Keep images only on the most recent N image-bearing turns; strip older ones so the
  // serialized request stays under Kiro's content-length threshold.
  const keep = keepImageTurns()
  const imageIdx: number[] = []
  messages.forEach((m, i) => {
    if (hasImages(m.content)) imageIdx.push(i)
  })
  const keepSet = new Set(keep > 0 ? imageIdx.slice(-keep) : [])

  const history = messages
    .slice(0, -1)
    .map((m, i) => (m.role === "assistant" ? assistantEntry(m) : userEntry(m, modelId, undefined, false, keepSet.has(i))))

  const last = messages[messages.length - 1]
  const current = last && last.role !== "assistant" ? last : { role: "user", content: " " }
  const currentKeepImages = keepSet.has(messages.length - 1)

  const additionalModelRequestFields = buildModelRequestFields(modelId, effort)
  const payload = {
    conversationState: {
      conversationId: randomUUID(),
      currentMessage: userEntry(current, modelId, tools, true, currentKeepImages),
      history,
      chatTriggerType: "MANUAL",
      agentContinuationId: randomUUID(),
      agentTaskType: "vibe",
    },
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  }

  const serializedPayload = JSON.stringify(payload)
  kiroDebug(debug, "request.mapped", {
    modelId,
    effort: effort ?? null,
    sourceMessages: body.messages?.length ?? 0,
    historyEntries: history.length,
    requestBytes: Buffer.byteLength(serializedPayload),
    systemChars: sys.length,
    toolCount: tools?.length ?? 0,
    toolNames: body.tools?.map((tool) => tool.name).filter((name) => typeof name === "string") ?? [],
    imageTurns: imageIdx.length,
    keptImageTurns: [...keepSet],
  })
  if (kiroDebugEnabled()) {
    kiroDebug(debug, "request.history_shape", {
      messages: messages.length,
      userMessages: messages.filter((message) => message.role === "user").length,
      assistantMessages: messages.filter((message) => message.role === "assistant").length,
    })
    messages.forEach((message, index) => {
      const encoded = index < history.length ? history[index] : payload.conversationState.currentMessage
      kiroDebug(debug, "request.history_entry", {
        index,
        role: message.role,
        current: index === messages.length - 1,
        encodedBytes: Buffer.byteLength(JSON.stringify(encoded)),
        ...contentShape(message.content),
      })
    })
  }

  return payload
}

/* ---------------------------- response mapping ----------------------------- */

/**
 * The subset of a body reader that replay needs, typed structurally: under @types/bun,
 * `Response.body.getReader()` returns Node's `stream/web` reader interface while the global
 * `ReadableStreamDefaultReader` is Bun's extended one (adds `readMany`), and the two are not
 * mutually assignable.
 */
type BodyStreamReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "releaseLock" | "cancel">

function replayKiroResponse(
  res: Response,
  prefix: Uint8Array[],
  reader?: BodyStreamReader,
): Response {
  let index = 0
  let released = false
  const release = () => {
    if (reader && !released) {
      released = true
      reader.releaseLock()
    }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) {
        controller.enqueue(prefix[index++])
        return
      }
      if (!reader) {
        controller.close()
        return
      }
      try {
        const next = await reader.read()
        if (next.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      if (!reader) return
      try {
        await reader.cancel(reason)
      } finally {
        release()
      }
    },
  })
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

function streamErrorResponse(status: number, type: string, message: string, headers?: Headers): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: headers ?? { "content-type": "application/json" },
  })
}

function rateLimitResponse(
  res: Response,
  event: Extract<KiroStreamEvent, { kind: "rateLimit" }>,
): Response {
  const headers = new Headers({ "content-type": "application/json" })
  const retryAfter = resolveRetryAfter({ header: res.headers.get("retry-after"), event })
  if (retryAfter) headers.set("retry-after", retryAfter)
  return streamErrorResponse(429, "rate_limit_error", event.message, headers)
}

/**
 * Kiro can return HTTP 200 and put failures in the AWS event stream. Read through
 * the first real output/error event, replaying the exact prefix for successful
 * responses. Pre-output failures become HTTP errors opencode can retry or surface.
 */
export async function preflightKiroResponse(
  res: Response,
  debug: KiroDebugContext = createKiroDebugContext(),
): Promise<Response> {
  const preflightStartedAt = Date.now()
  // Hoisted so the per-event debug shapes are never computed when debugging is off.
  const debugEnabled = kiroDebugEnabled()
  const eventTypes: Record<string, number> = {}
  let chunks = 0
  let totalBytes = 0
  let eventCount = 0
  let terminalMetadata: Extract<KiroStreamEvent, { kind: "metadata" }> | undefined
  kiroDebug(debug, "response.preflight_start", { status: res.status, hasBody: Boolean(res.body) })
  if (!res.body) {
    kiroDebug(debug, "response.body_missing", { status: res.status })
    return streamErrorResponse(502, "api_error", "Kiro returned a response without an event stream.")
  }
  const reader = res.body.getReader()
  const prefix: Uint8Array[] = []
  let buf = Buffer.alloc(0)
  let readerOwned = true
  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>
      try {
        next = await reader.read()
      } catch (error) {
        readerOwned = false
        reader.releaseLock()
        const message = String(error)
        kiroDebug(debug, "response.read_error", {
          ...kiroDebugError(error),
          chunks,
          totalBytes,
          eventCount,
          eventTypes,
          preflightMs: Date.now() - preflightStartedAt,
        })
        return streamErrorResponse(
          /timeout|timed out/i.test(message) ? 504 : 502,
          "api_error",
          redactKiroSecrets(message),
        )
      }
      if (next.done) {
        reader.releaseLock()
        readerOwned = false
        kiroDebug(debug, "response.empty_eof", {
          chunks,
          totalBytes,
          eventCount,
          eventTypes,
          trailingBytes: buf.length,
          preflightMs: Date.now() - preflightStartedAt,
        })
        if (terminalMetadata?.stopReason === "CONTENT_FILTERED") {
          return streamErrorResponse(
            400,
            "invalid_request_error",
            contentFilteredMessage(terminalMetadata),
          )
        }
        return streamErrorResponse(
          502,
          "api_error",
          "Kiro closed the response stream without assistant output.",
        )
      }

      chunks += 1
      totalBytes += next.value.byteLength
      prefix.push(next.value)
      buf = Buffer.concat([buf, Buffer.from(next.value)])
      const { events, rest } = drainKiroEvents(buf)
      buf = Buffer.from(rest)
      if (debugEnabled) {
        kiroDebug(debug, "response.chunk", {
          chunk: chunks,
          bytes: next.value.byteLength,
          totalBytes,
          decodedEvents: events.length,
          trailingBytes: buf.length,
        })
      }
      for (const event of events) {
        eventCount += 1
        eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1
        if (debugEnabled) {
          kiroDebug(debug, "response.event", {
            sequence: eventCount,
            eventType: event.eventType,
            ...kiroEventShape(event),
          })
        }
        const parsed = parseKiroEvent(event)
        if (parsed.kind === "metadata") terminalMetadata = parsed
        if (parsed.kind === "rateLimit") {
          try {
            await reader.cancel()
          } catch {
            // The synthetic 429 remains useful even if the upstream body resists cancellation.
          } finally {
            reader.releaseLock()
            readerOwned = false
          }
          kiroDebug(debug, "response.rate_limited", {
            eventType: event.eventType,
            retryAfter:
              resolveRetryAfter({ header: res.headers.get("retry-after"), event: parsed }) ?? null,
          })
          return rateLimitResponse(res, parsed)
        }
        if (parsed.kind === "timeout") {
          try {
            await reader.cancel()
          } catch {
            // The synthetic timeout remains useful even if the upstream body resists cancellation.
          } finally {
            reader.releaseLock()
            readerOwned = false
          }
          kiroDebug(debug, "response.timed_out", { eventType: event.eventType })
          return streamErrorResponse(504, "api_error", parsed.message)
        }
        if (parsed.kind === "streamError") {
          kiroDebug(debug, "response.error_passthrough", { eventType: event.eventType })
          const replay = replayKiroResponse(res, prefix, reader)
          readerOwned = false
          return replay
        }
        if (beginsAssistantOutput(parsed)) {
          kiroDebug(debug, "response.output_detected", {
            eventType: event.eventType,
            chunks,
            totalBytes,
            eventCount,
            preflightMs: Date.now() - preflightStartedAt,
          })
          const replay = replayKiroResponse(res, prefix, reader)
          readerOwned = false
          return replay
        }
      }
    }
  } finally {
    if (readerOwned) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

function contentFilteredMessage(metadata: Extract<KiroStreamEvent, { kind: "metadata" }>): string {
  const category = metadata.refusal?.category
  const explanation = metadata.refusal?.explanation

  return [
    `Kiro blocked this response${category ? ` (${category})` : " because the conversation triggered its content filter"}.`,
    explanation,
    "Retrying the unchanged conversation will not help.",
  ]
    .filter(Boolean)
    .join(" ")
}

function kiroEventShape(event: KiroEvent): Record<string, unknown> {
  const payload = event.payload
  const shape: Record<string, unknown> = { payloadKeys: Object.keys(payload).sort() }
  for (const key of [
    "conversationId",
    "stopReason",
    "reason",
    "code",
    "errorCode",
    "status",
    "statusCode",
    "unit",
    "unitPlural",
    "usage",
  ]) {
    const value = payload[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      shape[key] = value
    }
  }
  if (typeof payload.content === "string") shape.contentChars = payload.content.length
  if (typeof payload.toolUseId === "string") shape.toolUseId = payload.toolUseId
  if (typeof payload.name === "string") shape.toolName = payload.name
  if (typeof payload.input === "string") shape.inputChars = payload.input.length
  if (typeof payload.stop === "boolean") shape.stop = payload.stop
  if (typeof payload.contextUsagePercentage === "number") {
    shape.contextUsagePercentage = payload.contextUsagePercentage
  }
  if (typeof payload.message === "string") shape.message = payload.message.slice(0, 500)
  if (typeof payload.Message === "string") shape.message = payload.Message.slice(0, 500)
  if (typeof payload.errorMessage === "string") shape.message = payload.errorMessage.slice(0, 500)
  if (typeof payload.raw === "string") shape.rawChars = payload.raw.length
  const refusal =
    payload.stopDetails && typeof payload.stopDetails === "object"
      ? (payload.stopDetails as { refusal?: unknown }).refusal
      : undefined
  if (refusal && typeof refusal === "object") {
    const category = (refusal as { category?: unknown }).category
    const explanation = (refusal as { explanation?: unknown }).explanation
    shape.refusal = {
      ...(typeof category === "string" ? { category: category.slice(0, 100) } : {}),
      ...(typeof explanation === "string" ? { explanation: explanation.slice(0, 500) } : {}),
    }
  }
  return shape
}

/** Convert Kiro's event-stream into the Anthropic Messages SSE stream opencode expects. */
export function kiroToAnthropicStream(
  res: Response,
  model: string,
  contextLimit = 1_000_000,
  debug: KiroDebugContext = createKiroDebugContext(),
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const textEncoder = new TextEncoder()
      const encoder = new AnthropicSseEncoder({ model, contextLimit })
      const send = (events: AnthropicSseEvent[]) => {
        for (const event of events) controller.enqueue(textEncoder.encode(serializeSse(event)))
      }
      let eventCount = 0
      const eventTypes: Record<string, number> = {}
      // Hoisted so the per-event debug shapes are never computed when debugging is off.
      const debugEnabled = kiroDebugEnabled()
      send(encoder.begin())
      kiroDebug(debug, "sse.start", { model, contextLimit })

      try {
        for await (const ev of readKiroEvents(res)) {
          eventCount += 1
          eventTypes[ev.eventType] = (eventTypes[ev.eventType] ?? 0) + 1
          if (debugEnabled) {
            kiroDebug(debug, "sse.event", {
              sequence: eventCount,
              eventType: ev.eventType,
              ...kiroEventShape(ev),
            })
          }
          const parsed = parseKiroEvent(ev)
          send(encoder.onEvent(parsed))
          if (encoder.terminated) {
            const state = encoder.debugState()
            kiroDebug(debug, "sse.error", {
              name: parsed.kind,
              message: "message" in parsed ? parsed.message : "Kiro stream error",
              eventCount,
              eventTypes,
              outputChars: state.outputChars,
              usedTool: state.usedTool,
              discardedPendingTool: state.discardedPendingTool,
              droppedToolFragments: state.droppedToolFragments,
              unknownEventTypes: state.unknownEventTypes,
            })
            break
          }
        }

        const terminatedByEvent = encoder.terminated
        send(encoder.onEof())
        const state = encoder.debugState()
        if (terminatedByEvent) return
        if (encoder.terminated) {
          kiroDebug(debug, "sse.empty_eof", {
            eventCount,
            eventTypes,
            contextPercent: state.contextPercent,
            discardedPendingTool: state.discardedPendingTool,
            droppedToolFragments: state.droppedToolFragments,
            unknownEventTypes: state.unknownEventTypes,
          })
          return
        }
        kiroDebug(debug, "sse.complete", {
          eventCount,
          eventTypes,
          outputChars: state.outputChars,
          usedTool: state.usedTool,
          contextPercent: state.contextPercent,
          discardedPendingTool: state.discardedPendingTool,
          droppedToolFragments: state.droppedToolFragments,
          unknownEventTypes: state.unknownEventTypes,
        })
      } catch (error) {
        const state = encoder.debugState()
        kiroDebug(debug, "sse.error", {
          ...kiroDebugError(error),
          eventCount,
          eventTypes,
          outputChars: state.outputChars,
          usedTool: state.usedTool,
          discardedPendingTool: state.discardedPendingTool,
          droppedToolFragments: state.droppedToolFragments,
          unknownEventTypes: state.unknownEventTypes,
        })
        send([
          {
            event: "error",
            data: {
              type: "error",
              error: { type: "api_error", message: redactKiroSecrets(String(error)) },
            },
          },
        ])
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/* ------------------------------ error mapping ------------------------------ */

/**
 * Translate a Kiro error response into something opencode handles well.
 *
 * Kiro returns a 400 ValidationException ("Input content length exceeds threshold",
 * reason CONTENT_LENGTH_EXCEEDS_THRESHOLD) when the whole request (history + images)
 * is too large. opencode only recognizes a request as a context overflow — and then
 * shows a clear "start a new session or /compact" message — when the 400 message
 * contains phrases like "prompt is too long". So we reshape that specific case into an
 * Anthropic-style error carrying that phrase; everything else is passed through verbatim.
 */
export function mapKiroError(detail: string, status: number): { body: string; status: number } {
  detail = redactKiroSecrets(detail)
  let reason = ""
  let message = ""
  try {
    const parsed = JSON.parse(detail) as { reason?: string; message?: string }
    reason = parsed.reason ?? ""
    message = parsed.message ?? ""
  } catch {
    // non-JSON body; fall through to pass-through
  }

  const tooLong = reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD" || /content length exceeds/i.test(message)
  if (status === 400 && tooLong) {
    const friendly =
      "Prompt is too long: Kiro rejected the request because the total input " +
      "(conversation history plus images) exceeds its content-length limit. Start a new " +
      "session or run /compact to reduce context, and avoid very large or tall images."
    return {
      status: 400,
      body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: friendly } }),
    }
  }

  return { body: detail || `Kiro request failed (${status})`, status }
}
