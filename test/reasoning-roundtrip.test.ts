import { describe, expect, it } from "bun:test"
import type { KiroEvent } from "../src/eventstream"
import {
  KTR_MARKER,
  KTR_REASONING_PLACEHOLDER,
  OMITTED_REASONING_SENTINEL,
  parseKiroEvent,
} from "../src/events"
import { toKiroPayload } from "../src/request"
import { AnthropicSseEncoder, type AnthropicSseEvent } from "../src/sse"

type RecordedThinking = {
  type: "thinking"
  thinking: string
  signature: string
}

function recordThinking(events: KiroEvent[]): RecordedThinking {
  const encoder = new AnthropicSseEncoder({
    model: "claude-fable-5",
    contextLimit: 200_000,
    messageId: "msg_roundtrip",
  })
  const output: AnthropicSseEvent[] = encoder.begin()
  for (const event of events) output.push(...encoder.onEvent(parseKiroEvent(event)))
  output.push(
    ...encoder.onEvent(parseKiroEvent({ eventType: "assistantResponseEvent", payload: { content: "done" } })),
    ...encoder.onEof(),
  )

  let thinking = ""
  let signature = ""
  for (const event of output) {
    const delta = event.data.delta as Record<string, unknown> | undefined
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") thinking += delta.thinking
    if (delta?.type === "signature_delta" && typeof delta.signature === "string") signature += delta.signature
  }
  return { type: "thinking", thinking, signature }
}

function replayThinking(block: RecordedThinking): { text: string; signature: string } {
  const payload = toKiroPayload(
    {
      model: "claude-fable-5",
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: [block, { type: "text", text: "done" }] },
        { role: "user", content: "continue" },
      ],
    },
    {
      now: () => new Date(0),
      uuid: () => "roundtrip-id",
      cwd: () => "/roundtrip",
      keepImageTurns: 0,
    },
  )
  const assistant = payload.conversationState.history[1]
  if (!assistant || !("assistantResponseMessage" in assistant)) {
    throw new Error("expected the assistant reasoning turn in Kiro history")
  }
  const reasoning = assistant.assistantResponseMessage.reasoningContent?.reasoningText
  if (!reasoning) throw new Error("expected Kiro reasoning content")
  return reasoning
}

describe("reasoning emit-replay round trip", () => {
  const ktrSignature = `${KTR_MARKER}opaque-redacted-reasoning`
  const cases: Array<{
    name: string
    events: KiroEvent[]
    recordedText: string
    replayedText: string
    signature: string
  }> = [
    {
      name: "signature-only reasoning",
      events: [{ eventType: "reasoningContentEvent", payload: { signature: "sig/hidden+==" } }],
      recordedText: OMITTED_REASONING_SENTINEL,
      replayedText: "",
      signature: "sig/hidden+==",
    },
    {
      name: "text and signature reasoning",
      events: [
        { eventType: "reasoningContentEvent", payload: { text: "line one\n" } },
        { eventType: "reasoningContentEvent", payload: { text: "line two", signature: "sig/text+==" } },
      ],
      recordedText: "line one\nline two",
      replayedText: "line one\nline two",
      signature: "sig/text+==",
    },
    {
      name: "KTR envelope reasoning",
      events: [
        {
          eventType: "reasoningContentEvent",
          payload: { redactedContent: Buffer.from(ktrSignature).toString("base64") },
        },
      ],
      recordedText: KTR_REASONING_PLACEHOLDER,
      replayedText: KTR_REASONING_PLACEHOLDER,
      signature: ktrSignature,
    },
  ]

  for (const testCase of cases) {
    it(`round-trips ${testCase.name}`, () => {
      const recorded = recordThinking(testCase.events)
      expect(recorded.thinking).toBe(testCase.recordedText)
      expect(recorded.signature).toBe(testCase.signature)

      const replayed = replayThinking(recorded)
      expect(replayed.text).toBe(testCase.replayedText)
      expect(replayed.signature).toBe(testCase.signature)
    })
  }
})
