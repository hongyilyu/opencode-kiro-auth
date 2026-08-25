import { randomUUID } from "node:crypto"
import { DEFAULT_MODEL, KIRO_ORIGIN } from "./constants"
import {
  createKiroDebugContext,
  kiroDebug,
  kiroDebugEnabled,
  type KiroDebugContext,
} from "./debug"
import { OMITTED_REASONING_SENTINEL } from "./events"

type Block = Record<string, any>
type Message = { role: string; content: string | Block[] }
type AnthropicRequest = {
  model?: string
  system?: string | Block[]
  messages?: Message[]
  tools?: Block[]
  [key: string]: unknown
}

type KiroEnvironmentState = {
  operatingSystem: "windows" | "macos" | "linux"
  currentWorkingDirectory: string
  environmentVariables: string[]
}

type KiroTool = {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: unknown }
  }
}

type KiroToolResult = {
  toolUseId: string
  content: Array<{ text: string }>
  status: "error" | "success"
}

type KiroToolUse = {
  toolUseId: string
  name: string
  input: unknown
}

export type KiroUserEntry = {
  userInputMessage: {
    content: string
    userInputMessageContext: {
      envState: KiroEnvironmentState
      toolResults?: KiroToolResult[]
      tools?: KiroTool[]
    }
    origin: typeof KIRO_ORIGIN
    modelId: string
    images?: Array<{ format: string; source: { bytes: string } }>
  }
}

export type KiroAssistantEntry = {
  assistantResponseMessage: {
    content: string
    toolUses?: KiroToolUse[]
    reasoningContent?: {
      reasoningText: {
        text: string
        signature: string
      }
    }
  }
}

export type KiroModelRequestFields =
  | { reasoning: { effort: string } }
  | {
      thinking: { type: "adaptive"; display: "omitted" }
      output_config: { effort: string }
    }

export type KiroRequestPayload = {
  conversationState: {
    conversationId: string
    currentMessage: KiroUserEntry
    history: Array<KiroUserEntry | KiroAssistantEntry>
    chatTriggerType: "MANUAL"
    agentContinuationId: string
    agentTaskType: "vibe"
  }
  additionalModelRequestFields?: KiroModelRequestFields
}

export type RequestDependencies = {
  now?: () => Date
  uuid?: () => string
  cwd?: () => string
  platform?: string
  keepImageTurns?: number
}

type NormalizedMessage = Message & {
  keepImages: boolean
}

/** The history normalizer's result: rewritten turns plus the image-retention bookkeeping. */
type NormalizedHistory = {
  messages: NormalizedMessage[]
  /** Indexes of image-bearing source turns (top-level or nested in a tool result). */
  imageTurns: number[]
  /** The tail of imageTurns inside the retention window; only these keep image bytes. */
  keptImageTurns: number[]
}

type NormalizeOptions = {
  hasTools: boolean
  systemText: string
  keepImageTurns: number
}

type BuildOptions = {
  modelId: string
  tools?: KiroTool[]
  effort?: string
  now: Date
  uuid: () => string
  envState: KiroEnvironmentState
}

function operatingSystem(platform: string): KiroEnvironmentState["operatingSystem"] {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux"
}

const DEFAULT_KEEP_IMAGE_TURNS = 2
const TOOL_RETRY_BOUNDARY = "The tool calls completed before the next user message."

const IMAGE_FORMATS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** Build Kiro's model-specific fields for the selected effort variant. */
function buildModelRequestFields(modelId: string, effort?: string): KiroModelRequestFields | undefined {
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

/** Format the local time exactly like kiro-cli's CONTEXT ENTRY. */
function currentTimestamp(d: Date): string {
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" })
  const pad = (n: number, len = 2) => String(n).padStart(len, "0")
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  return (
    `${weekday}, ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * Wrap the current user turn exactly like kiro-cli. The framing is verified byte-for-byte
 * against a live GenerateAssistantResponse capture; do not alter its whitespace.
 */
function wrapCurrentContent(text: string, now: Date): string {
  return (
    "--- CONTEXT ENTRY BEGIN ---\n" +
    `Current time: ${currentTimestamp(now)}\n` +
    "--- CONTEXT ENTRY END ---\n\n" +
    `--- USER MESSAGE BEGIN ---\n${text}--- USER MESSAGE END ---`
  )
}

function textOf(content: string | Block[]): string {
  if (typeof content === "string") return content
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
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

function toolSpecs(tools?: Block[]): KiroTool[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: { json: tool.input_schema ?? tool.inputSchema ?? { type: "object", properties: {} } },
    },
  }))
}

/**
 * Bedrock rejects a user turn containing both tool_result blocks and ordinary text. OpenCode can
 * create that shape when a user manually retries after a completed tool turn. Preserve the tool
 * protocol, then separate the retry text with an assistant boundary.
 */
function splitMixedToolResultTurns(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" || typeof message.content === "string") return [message]

    const results = message.content.filter((block) => block?.type === "tool_result")
    const rest = message.content.filter((block) => block?.type !== "tool_result")
    if (!results.length || !rest.some((block) => block?.type === "text" && (block.text ?? "").trim().length > 0)) {
      return [message]
    }

    return [
      { ...message, content: results },
      { role: "assistant", content: TOOL_RETRY_BOUNDARY },
      { ...message, content: rest },
    ]
  })
}

function foldSystemPrompt(messages: Message[], system: string): Message[] {
  if (!system) return messages
  const firstUser = messages.findIndex((message) => message.role === "user")
  if (firstUser < 0) return messages

  return messages.map((message, index) => {
    if (index !== firstUser) return message
    return {
      ...message,
      content:
        typeof message.content === "string"
          ? `${system}\n\n${message.content}`
          : [{ type: "text", text: system }, ...message.content],
    }
  })
}

/**
 * Keep a structured tool pair only when both sides are present and the result turn is clean.
 * Orphans, malformed mixed turns, and tool blocks in tool-less requests degrade to plain text.
 */
function normalizeToolBlocks(messages: Message[], keepStructured: boolean): Message[] {
  const info = new Map<string, { use: boolean; result: boolean; mixed: boolean }>()
  const entry = (id: string) => {
    let value = info.get(id)
    if (!value) info.set(id, (value = { use: false, result: false, mixed: false }))
    return value
  }

  for (const message of messages) {
    if (typeof message.content === "string") continue
    const hasText = message.content.some(
      (block) => block?.type === "text" && (block.text ?? "").trim().length > 0,
    )
    for (const block of message.content) {
      if (block?.type === "tool_use" && block.id) entry(block.id).use = true
      if (block?.type === "tool_result" && block.tool_use_id) {
        const value = entry(block.tool_use_id)
        value.result = true
        if (hasText) value.mixed = true
      }
    }
  }

  const keepId = (id: string) => {
    const value = info.get(id)
    return keepStructured && !!value && value.use && value.result && !value.mixed
  }

  return messages.map((message) => {
    if (typeof message.content === "string") return message
    if (!message.content.some((block) => block?.type === "tool_use" || block?.type === "tool_result")) {
      return message
    }
    return {
      ...message,
      content: message.content.map((block) => {
        if (block?.type === "tool_use" && !keepId(block.id)) {
          const input = block.input && Object.keys(block.input).length ? ` ${JSON.stringify(block.input)}` : ""
          return { type: "text", text: `[called ${block.name}${input}]` }
        }
        if (block?.type === "tool_result" && !keepId(block.tool_use_id)) {
          return { type: "text", text: `[tool result]\n${stringifyResultContent(block.content)}`.trim() }
        }
        return block
      }),
    }
  })
}

function toolResults(content: string | Block[]): KiroToolResult[] | undefined {
  if (typeof content === "string") return undefined
  const results = content.filter((block) => block?.type === "tool_result")
  if (!results.length) return undefined
  return results.map((result) => ({
    toolUseId: result.tool_use_id,
    content: [{ text: typeof result.content === "string" ? result.content : JSON.stringify(result.content) }],
    status: result.is_error ? "error" : "success",
  }))
}

function stringifyResultContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block?.type === "text" && typeof block.text === "string"
          ? block.text
          : block?.type === "image"
            ? "[image]"
            : "",
      )
      .filter(Boolean)
      .join("\n")
  }
  return content == null ? "" : JSON.stringify(content)
}

function toolUses(content: string | Block[]): KiroToolUse[] | undefined {
  if (typeof content === "string") return undefined
  const uses = content.filter((block) => block?.type === "tool_use")
  if (!uses.length) return undefined
  return uses.map((use) => ({ toolUseId: use.id, name: use.name, input: use.input ?? {} }))
}

function isImageBlock(block: Block): boolean {
  return block?.type === "image" && block.source?.type === "base64" && block.source?.data
}

function topLevelImages(content: string | Block[]) {
  if (typeof content === "string") return undefined
  const imageBlocks = content.filter(isImageBlock)
  if (!imageBlocks.length) return undefined
  return imageBlocks.map((block) => ({
    format: IMAGE_FORMATS[block.source.media_type] ?? "png",
    source: { bytes: block.source.data },
  }))
}

function hasImages(content: string | Block[]): boolean {
  if (typeof content === "string") return false
  return content.some(
    (block) =>
      isImageBlock(block) ||
      (block?.type === "tool_result" && Array.isArray(block.content) && block.content.some(isImageBlock)),
  )
}

function omitToolResultImages(content: string | Block[]): string | Block[] {
  if (typeof content === "string") return content
  return content.map((block) => {
    if (block?.type !== "tool_result" || !Array.isArray(block.content)) return block
    return {
      ...block,
      content: block.content.map((resultBlock: Block) =>
        isImageBlock(resultBlock) ? { type: "text", text: "[image omitted]" } : resultBlock,
      ),
    }
  })
}

function applyImagePolicy(messages: Message[], keepImageTurns: number): NormalizedHistory {
  const imageTurns = messages.flatMap((message, index) => (hasImages(message.content) ? [index] : []))
  const keptImageTurns = keepImageTurns > 0 ? imageTurns.slice(-keepImageTurns) : []
  const keepIndexes = new Set(keptImageTurns)

  return {
    messages: messages.map((message, index) => ({
      ...message,
      content: keepIndexes.has(index) ? message.content : omitToolResultImages(message.content),
      keepImages: keepIndexes.has(index),
    })),
    imageTurns,
    keptImageTurns,
  }
}

/**
 * Normalize history over a deep copy. Ordering is load-bearing: split retry turns before folding
 * the system prompt, normalize tool pairs after folding, then apply image retention. Keeping that
 * order inside one function makes the valid sequence uncallable-wrong.
 */
function normalizeMessages(messages: Message[], opts: NormalizeOptions): NormalizedHistory {
  let normalized = structuredClone(messages)
  if (opts.hasTools) normalized = splitMixedToolResultTurns(normalized)
  normalized = foldSystemPrompt(normalized, opts.systemText)
  normalized = normalizeToolBlocks(normalized, opts.hasTools)
  return applyImagePolicy(normalized, opts.keepImageTurns)
}

function userEntry(
  message: NormalizedMessage,
  modelId: string,
  envState: KiroEnvironmentState,
  now: Date,
  tools?: KiroTool[],
  isCurrent = false,
): KiroUserEntry {
  const context: KiroUserEntry["userInputMessage"]["userInputMessageContext"] = { envState }
  const results = toolResults(message.content)
  if (results) context.toolResults = results
  if (tools) context.tools = tools
  const turnImages = topLevelImages(message.content)
  const imageEntries = message.keepImages ? turnImages : undefined
  const rawText = textOf(message.content)
  const hasToolResults = Boolean(results)
  const droppedImages = !message.keepImages && Boolean(turnImages)

  // A tool-result continuation carries no user text; its blocks live in toolResults. Wrapping
  // whitespace makes Kiro treat it as a blank user turn. A dropped image-only turn gets a marker
  // so it does not become blank. These three forms ("", " ", marker) are wire-significant.
  let text: string
  if (rawText) text = rawText
  else if (droppedImages && !hasToolResults) text = "[image omitted]"
  else text = hasToolResults ? "" : " "
  const content = isCurrent && text ? wrapCurrentContent(text, now) : text

  return {
    userInputMessage: {
      content,
      userInputMessageContext: context,
      origin: KIRO_ORIGIN,
      modelId,
      ...(imageEntries ? { images: imageEntries } : {}),
    },
  }
}

function assistantEntry(message: Message): KiroAssistantEntry {
  const uses = toolUses(message.content)
  let reasoning: Block | undefined
  if (typeof message.content !== "string") {
    // Kiro accepts one reasoning carrier per assistant message. Match KAS by replaying the last
    // complete phase when a turn contains multiple signed thinking blocks.
    for (const block of message.content) {
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
      content: textOf(message.content),
      ...(uses ? { toolUses: uses } : {}),
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

function buildKiroPayload(messages: NormalizedMessage[], opts: BuildOptions): KiroRequestPayload {
  const history = messages.slice(0, -1).map((message) =>
    message.role === "assistant"
      ? assistantEntry(message)
      : userEntry(message, opts.modelId, opts.envState, opts.now),
  )

  const last = messages[messages.length - 1]
  // Kiro requires a user current message; a transcript ending on an assistant turn gets a
  // blank one (the " " form is wire-significant, see userEntry).
  const current: NormalizedMessage =
    last && last.role !== "assistant" ? last : { role: "user", content: " ", keepImages: false }
  const additionalModelRequestFields = buildModelRequestFields(opts.modelId, opts.effort)

  return {
    conversationState: {
      conversationId: opts.uuid(),
      currentMessage: userEntry(current, opts.modelId, opts.envState, opts.now, opts.tools, true),
      history,
      chatTriggerType: "MANUAL",
      agentContinuationId: opts.uuid(),
      agentTaskType: "vibe",
    },
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  }
}

function resolveKeepImageTurns(value: string | number | undefined): number {
  const number = value != null ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : DEFAULT_KEEP_IMAGE_TURNS
}

/** Map an Anthropic Messages request to a typed Kiro GenerateAssistantResponse payload. */
export function toKiroPayload(
  body: AnthropicRequest,
  effort?: string,
  debug: KiroDebugContext = createKiroDebugContext(),
  deps: RequestDependencies = {},
): KiroRequestPayload {
  const modelId = body.model || DEFAULT_MODEL
  const tools = toolSpecs(body.tools)
  const system = systemText(body.system)
  const keepImageTurns = resolveKeepImageTurns(
    deps.keepImageTurns ?? process.env.KIRO_KEEP_IMAGE_TURNS,
  )
  const normalized = normalizeMessages(body.messages ?? [], {
    hasTools: Boolean(tools),
    systemText: system,
    keepImageTurns,
  })
  const payload = buildKiroPayload(normalized.messages, {
    modelId,
    tools,
    effort,
    now: (deps.now ?? (() => new Date()))(),
    uuid: deps.uuid ?? randomUUID,
    envState: {
      operatingSystem: operatingSystem(deps.platform ?? process.platform),
      currentWorkingDirectory: (deps.cwd ?? (() => process.cwd()))(),
      environmentVariables: [],
    },
  })

  if (kiroDebugEnabled()) {
    const { messages, imageTurns, keptImageTurns } = normalized
    const history = payload.conversationState.history
    kiroDebug(debug, "request.mapped", {
      modelId,
      effort: effort ?? null,
      sourceMessages: body.messages?.length ?? 0,
      historyEntries: history.length,
      requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      systemChars: system.length,
      toolCount: tools?.length ?? 0,
      toolNames: body.tools?.map((tool) => tool.name).filter((name) => typeof name === "string") ?? [],
      imageTurns: imageTurns.length,
      keptImageTurns,
    })
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
