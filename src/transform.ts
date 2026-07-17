import { randomUUID } from "node:crypto"
import {
  DEFAULT_MODEL,
  KIRO_ENDPOINT,
  KIRO_TARGET,
  KIRO_CONTENT_TYPE,
  KIRO_ORIGIN,
  KIRO_USER_AGENT,
  KIRO_X_AMZ_USER_AGENT,
} from "./constants"
import { readKiroEvents } from "./eventstream"

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
 *   - the tool_result turn isn't mixed with regular text (Bedrock rejects that).
 * Every other tool_use/tool_result (orphans, mixed turns, and all blocks on tool-less requests
 * like compaction/summaries) is degraded to plain text on BOTH sides, keeping the conversation
 * valid while preserving the information.
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
  return {
    assistantResponseMessage: {
      content: textOf(msg.content),
      ...(tu ? { toolUses: tu } : {}),
    },
  }
}

/** Map an Anthropic Messages request to a Kiro GenerateAssistantResponse request. */
export function toKiroRequest(
  body: AnthropicRequest,
  accessToken: string,
  profileArn: string,
  effort?: string,
): { url: string; init: RequestInit } {
  const modelId = body.model || DEFAULT_MODEL

  // CodeWhisperer has no system role: fold the system prompt into the first user turn.
  const messages = (body.messages ?? []).map((m) => ({ ...m }))
  const tools = toolSpecs(body.tools)
  // Keep clean tool pairs structured when tools are present; otherwise (compaction/summaries)
  // degrade all tool blocks to text. Also fixes orphan/mixed tool turns either way.
  normalizeToolBlocks(messages, Boolean(tools))

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
    profileArn,
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

  return {
    url: KIRO_ENDPOINT,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": KIRO_CONTENT_TYPE,
        "x-amz-target": KIRO_TARGET,
        "user-agent": KIRO_USER_AGENT,
        "x-amz-user-agent": KIRO_X_AMZ_USER_AGENT,
        "x-amzn-codewhisperer-optout": "false",
        "amz-sdk-invocation-id": randomUUID(),
        "amz-sdk-request": "attempt=1; max=3",
      },
      body: JSON.stringify(payload),
    },
  }
}

/* ---------------------------- response mapping ----------------------------- */

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Convert Kiro's event-stream into the Anthropic Messages SSE stream opencode expects. */
export function kiroToAnthropicStream(res: Response, model: string, contextLimit = 1_000_000): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sse(event, data)))

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${randomUUID().replace(/-/g, "")}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })

      let index = -1
      let currentTool: string | null = null
      let usedTool = false
      let blockOpen = false
      // Kiro emits a contextUsageEvent (percentage) and meteringEvent (credits) near the
      // end of the stream. We translate the percentage into a token count for opencode's
      // gauge, and estimate output tokens from the streamed text (~4 chars/token).
      let contextPercent: number | null = null
      let outputChars = 0

      const closeBlock = () => {
        if (!blockOpen) return
        send("content_block_stop", { type: "content_block_stop", index })
        blockOpen = false
        currentTool = null
      }

      try {
        for await (const ev of readKiroEvents(res)) {
          if (ev.eventType === "assistantResponseEvent") {
            const content = ev.payload.content
            if (typeof content !== "string" || content.length === 0) continue
            outputChars += content.length
            if (currentTool || !blockOpen) {
              closeBlock()
              index += 1
              blockOpen = true
              send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
            }
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: content } })
            continue
          }

          if (ev.eventType === "toolUseEvent") {
            const id = ev.payload.toolUseId as string
            const input = ev.payload.input as string | undefined
            const stop = ev.payload.stop === true

            if (id && id !== currentTool && input === undefined && !stop) {
              closeBlock()
              index += 1
              currentTool = id
              usedTool = true
              blockOpen = true
              send("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "tool_use", id, name: ev.payload.name, input: {} },
              })
              continue
            }
            if (typeof input === "string" && input.length > 0) {
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input } })
            }
            if (stop) closeBlock()
            continue
          }

          if (ev.eventType === "contextUsageEvent") {
            const pct = (ev.payload as { contextUsagePercentage?: unknown }).contextUsagePercentage
            if (typeof pct === "number" && Number.isFinite(pct)) contextPercent = pct
            continue
          }

          if (ev.eventType.toLowerCase().includes("exception") || ev.eventType === "error") {
            send("error", { type: "error", error: { type: "api_error", message: JSON.stringify(ev.payload) } })
          }
        }

        closeBlock()
        const inputTokens = contextPercent != null ? Math.round((contextPercent / 100) * contextLimit) : 0
        const outputTokens = outputChars > 0 ? Math.ceil(outputChars / 4) : 0
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: usedTool ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        })
        send("message_stop", { type: "message_stop" })
      } catch (error) {
        send("error", { type: "error", error: { type: "api_error", message: String(error) } })
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
