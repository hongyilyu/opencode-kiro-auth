import { randomUUID } from "node:crypto"
import { redactKiroSecrets } from "./debug"
import {
  EMPTY_TURN_ERROR_MESSAGE,
  OMITTED_REASONING_SENTINEL,
  completesAssistantTurn,
  isContentFilteredStop,
  type KiroStreamEvent,
  type MetadataEvent,
} from "./events"

export type AnthropicSseEvent = { event: string; data: Record<string, unknown> }

export function serializeSse(event: AnthropicSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

type OpenBlock =
  | { kind: "none" }
  | { kind: "text" }
  | { kind: "thinking"; hasText: boolean }

/** Kiro may deliver the name on any frame up to the stop frame, so it stays optional while pending. */
type PendingTool = {
  id: string
  name?: string
  fragments: string[]
}

type StopDelta =
  | { stop_reason: "end_turn" | "tool_use"; stop_sequence: null }
  | {
      stop_reason: "refusal"
      stop_sequence: null
      stop_details: { type: "refusal"; category?: string; explanation?: string }
    }

/** Encoder lifecycle: streaming, ended successfully, or ended with a terminal error frame. */
type StreamState = "open" | "completed" | "errored"

export class AnthropicSseEncoder {
  private readonly model: string
  private readonly contextLimit: number
  private readonly messageId: string
  private block: OpenBlock = { kind: "none" }
  private index = -1
  private pendingTool: PendingTool | undefined
  private readonly emittedToolIds = new Set<string>()
  private emittedToolBlock = false
  // Set via completesAssistantTurn (D1) at emission time: text as it streams, tool calls only
  // once their block was actually emitted — a discarded pending tool never completes the turn.
  private turnCompleted = false
  private contextPercent: number | null = null
  /** Kiro's terminal metadata (last wins); only a refusal changes the emitted stop reason. */
  private metadata: MetadataEvent | undefined
  private outputChars = 0
  private state: StreamState = "open"
  private discardedPendingTool = 0
  private droppedToolFragments = 0
  private unknownEventTypes: Record<string, number> = {}

  constructor(opts: { model: string; contextLimit: number; messageId?: string }) {
    this.model = opts.model
    this.contextLimit = opts.contextLimit
    this.messageId = opts.messageId ?? `msg_${randomUUID().replace(/-/g, "")}`
  }

  get terminated(): boolean {
    return this.state === "errored"
  }

  /** One immutable snapshot of accounting and diagnostics, for debug payloads and tests. */
  debugState(): {
    outputChars: number
    usedTool: boolean
    contextPercent: number | null
    discardedPendingTool: number
    droppedToolFragments: number
    unknownEventTypes: Record<string, number>
    stopReason: string | null
  } {
    return {
      outputChars: this.outputChars,
      usedTool: this.emittedToolBlock,
      contextPercent: this.contextPercent,
      discardedPendingTool: this.discardedPendingTool,
      droppedToolFragments: this.droppedToolFragments,
      unknownEventTypes: { ...this.unknownEventTypes },
      stopReason: this.metadata?.stopReason ?? null,
    }
  }

  begin(): AnthropicSseEvent[] {
    if (this.state !== "open") return []
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ]
  }

  onEvent(event: KiroStreamEvent): AnthropicSseEvent[] {
    if (this.state !== "open") return []

    switch (event.kind) {
      case "text":
        return this.onText(event)
      case "reasoning":
        return this.onReasoning(event)
      case "toolUse":
        return this.onToolUse(event)
      case "contextUsage":
        this.contextPercent = event.percent
        return []
      case "metadata":
        this.metadata = event
        return []
      case "unknown":
        this.unknownEventTypes[event.eventType] = (this.unknownEventTypes[event.eventType] ?? 0) + 1
        return []
      case "rateLimit":
      case "timeout":
      case "streamError":
        return this.onError(event.message)
    }
  }

  onEof(): AnthropicSseEvent[] {
    if (this.state !== "open") return []

    const events = this.closeBlock()
    this.discardPendingTool()
    if (!this.turnCompleted) {
      this.state = "errored"
      events.push(this.errorEvent(EMPTY_TURN_ERROR_MESSAGE))
      return events
    }
    this.state = "completed"

    const inputTokens =
      this.contextPercent != null
        ? Math.round((this.contextPercent / 100) * this.contextLimit)
        : 0
    const outputTokens = this.outputChars > 0 ? Math.ceil(this.outputChars / 4) : 0
    events.push(
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: this.stopDelta(),
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    )
    return events
  }

  /**
   * Refusal wins over tool_use. Otherwise the reason is derived from what was emitted, never
   * from Kiro's END_TURN/TOOL_USE, so a discarded tool cannot report a tool stop.
   */
  private stopDelta(): StopDelta {
    if (isContentFilteredStop(this.metadata)) {
      const refusal = this.metadata.refusal
      return {
        stop_reason: "refusal",
        stop_sequence: null,
        stop_details: {
          type: "refusal",
          ...(refusal?.category ? { category: refusal.category } : {}),
          ...(refusal?.explanation ? { explanation: refusal.explanation } : {}),
        },
      }
    }
    return { stop_reason: this.emittedToolBlock ? "tool_use" : "end_turn", stop_sequence: null }
  }

  private onText(event: Extract<KiroStreamEvent, { kind: "text" }>): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    if (this.block.kind !== "text") {
      events.push(...this.closeBlock())
      this.index += 1
      this.block = { kind: "text" }
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "text", text: "" },
        },
      })
    }
    this.turnCompleted ||= completesAssistantTurn(event)
    this.outputChars += event.content.length
    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: this.index,
        delta: { type: "text_delta", text: event.content },
      },
    })
    return events
  }

  private onReasoning(event: Extract<KiroStreamEvent, { kind: "reasoning" }>): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = []
    const openThinking = () => {
      if (this.block.kind === "thinking") return
      events.push(...this.closeBlock())
      this.index += 1
      this.block = { kind: "thinking", hasText: false }
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "thinking", thinking: "" },
        },
      })
    }

    if (event.text) {
      openThinking()
      if (this.block.kind === "thinking") this.block.hasText = true
      this.outputChars += event.text.length
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "thinking_delta", thinking: event.text },
        },
      })
    }
    if (event.signature) {
      openThinking()
      if (this.block.kind === "thinking" && !this.block.hasText) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: this.index,
            delta: { type: "thinking_delta", thinking: OMITTED_REASONING_SENTINEL },
          },
        })
      }
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "signature_delta", signature: event.signature },
        },
      })
      events.push(...this.closeBlock())
    }
    return events
  }

  private onToolUse(event: Extract<KiroStreamEvent, { kind: "toolUse" }>): AnthropicSseEvent[] {
    if (this.emittedToolIds.has(event.id)) {
      if (event.input !== undefined) this.droppedToolFragments += 1
      return []
    }

    if (this.pendingTool && this.pendingTool.id !== event.id) {
      this.discardPendingTool()
    }
    if (!this.pendingTool) {
      // A stop without an announcement or input is not a complete tool call.
      if (event.stop && event.input === undefined) return []
      this.pendingTool = { id: event.id, fragments: [] }
    }

    if (this.pendingTool.name === undefined && event.name !== undefined) {
      this.pendingTool.name = event.name
    }
    if (event.input !== undefined) this.pendingTool.fragments.push(event.input)
    if (!event.stop) return []

    // A call whose name never arrived is unrepresentable: discard it (counted) instead of
    // emitting a nameless block the client would reject or record as a poisoned turn.
    const tool = this.pendingTool
    const name = tool.name
    if (!name) {
      this.discardPendingTool()
      return []
    }
    this.pendingTool = undefined
    const events = this.closeBlock()
    this.index += 1
    events.push(
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: tool.id, name, input: {} },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "input_json_delta", partial_json: tool.fragments.join("") },
        },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index: this.index },
      },
    )
    this.emittedToolBlock = true
    this.emittedToolIds.add(tool.id)
    this.turnCompleted ||= completesAssistantTurn(event)
    return events
  }

  private onError(message: string): AnthropicSseEvent[] {
    const events = this.closeBlock()
    this.discardPendingTool()
    this.state = "errored"
    events.push(this.errorEvent(redactKiroSecrets(message)))
    return events
  }

  private closeBlock(): AnthropicSseEvent[] {
    if (this.block.kind === "none") return []
    const event: AnthropicSseEvent = {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: this.index },
    }
    this.block = { kind: "none" }
    return [event]
  }

  private discardPendingTool(): void {
    if (!this.pendingTool) return
    this.pendingTool = undefined
    this.discardedPendingTool += 1
  }

  private errorEvent(message: string): AnthropicSseEvent {
    return {
      event: "error",
      data: { type: "error", error: { type: "api_error", message } },
    }
  }
}
