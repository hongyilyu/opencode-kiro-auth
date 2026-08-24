import { randomUUID } from "node:crypto"
import { redactKiroSecrets } from "./debug"
import { OMITTED_REASONING_SENTINEL, type KiroStreamEvent } from "./events"

export type AnthropicSseEvent = { event: string; data: Record<string, unknown> }

export function serializeSse(event: AnthropicSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

type OpenBlock =
  | { kind: "none" }
  | { kind: "text" }
  | { kind: "thinking"; hasText: boolean }

type PendingTool = {
  id: string
  name?: string
  fragments: string[]
}

export class AnthropicSseEncoder {
  private readonly model: string
  private readonly contextLimit: number
  private readonly messageId: string
  private block: OpenBlock = { kind: "none" }
  private index = -1
  private pendingTool: PendingTool | undefined
  private readonly emittedToolIds = new Set<string>()
  private emittedToolBlock = false
  private hasText = false
  private contextPercent: number | null = null
  private outputChars = 0
  private finished = false
  private _terminated = false

  readonly diagnostics = {
    discardedPendingTool: 0,
    droppedToolFragments: 0,
    unknownEventTypes: {} as Record<string, number>,
  }

  constructor(opts: { model: string; contextLimit: number; messageId?: string }) {
    this.model = opts.model
    this.contextLimit = opts.contextLimit
    this.messageId = opts.messageId ?? `msg_${randomUUID().replace(/-/g, "")}`
  }

  get terminated(): boolean {
    return this._terminated
  }

  debugState(): {
    outputChars: number
    usedTool: boolean
    contextPercent: number | null
    discardedPendingTool: number
    droppedToolFragments: number
    unknownEventTypes: Record<string, number>
  } {
    return {
      outputChars: this.outputChars,
      usedTool: this.emittedToolBlock,
      contextPercent: this.contextPercent,
      discardedPendingTool: this.diagnostics.discardedPendingTool,
      droppedToolFragments: this.diagnostics.droppedToolFragments,
      unknownEventTypes: { ...this.diagnostics.unknownEventTypes },
    }
  }

  begin(): AnthropicSseEvent[] {
    if (this.finished) return []
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
    if (this.finished || this._terminated) return []

    switch (event.kind) {
      case "text":
        return this.onText(event.content)
      case "reasoning":
        return this.onReasoning(event)
      case "toolUse":
        return this.onToolUse(event)
      case "contextUsage":
        this.contextPercent = event.percent
        return []
      case "metadata":
        return []
      case "unknown":
        this.diagnostics.unknownEventTypes[event.eventType] =
          (this.diagnostics.unknownEventTypes[event.eventType] ?? 0) + 1
        return []
      case "rateLimit":
      case "timeout":
      case "streamError":
        return this.onError(event.message)
    }
  }

  onEof(): AnthropicSseEvent[] {
    if (this.finished || this._terminated) return []
    this.finished = true

    const events = this.closeBlock()
    this.discardPendingTool()
    if (!this.hasText && !this.emittedToolBlock) {
      this._terminated = true
      events.push(this.errorEvent("Kiro closed the response stream without assistant output."))
      return events
    }

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
          delta: {
            stop_reason: this.emittedToolBlock ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    )
    return events
  }

  private onText(content: string): AnthropicSseEvent[] {
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
    this.hasText = true
    this.outputChars += content.length
    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: this.index,
        delta: { type: "text_delta", text: content },
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
      if (event.input !== undefined) this.diagnostics.droppedToolFragments += 1
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
    if (this.pendingTool.id !== event.id) return []

    if (this.pendingTool.name === undefined && event.name !== undefined) {
      this.pendingTool.name = event.name
    }
    if (event.input !== undefined) this.pendingTool.fragments.push(event.input)
    if (!event.stop) return []

    const tool = this.pendingTool
    this.pendingTool = undefined
    const events = this.closeBlock()
    this.index += 1
    events.push(
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
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
    return events
  }

  private onError(message: string): AnthropicSseEvent[] {
    const events = this.closeBlock()
    this.discardPendingTool()
    this.finished = true
    this._terminated = true
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
    this.diagnostics.discardedPendingTool += 1
  }

  private errorEvent(message: string): AnthropicSseEvent {
    return {
      event: "error",
      data: { type: "error", error: { type: "api_error", message } },
    }
  }
}
