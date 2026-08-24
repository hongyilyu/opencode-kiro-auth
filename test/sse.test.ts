import { describe, expect, it } from "bun:test"
import { parseKiroEvent, type KiroStreamEvent } from "../src/events"
import { AnthropicSseEncoder, serializeSse, type AnthropicSseEvent } from "../src/sse"

const opts = { model: "claude-fable-5", contextLimit: 1_000, messageId: "msg_test" }

function encode(events: KiroStreamEvent[]): {
  encoder: AnthropicSseEncoder
  frames: AnthropicSseEvent[]
} {
  const encoder = new AnthropicSseEncoder(opts)
  const frames = [...encoder.begin()]
  for (const event of events) frames.push(...encoder.onEvent(event))
  frames.push(...encoder.onEof())
  return { encoder, frames }
}

function tool(
  id: string,
  fields: Omit<Extract<KiroStreamEvent, { kind: "toolUse" }>, "kind" | "id">,
): KiroStreamEvent {
  return { kind: "toolUse", id, ...fields }
}

function framesOfType(frames: AnthropicSseEvent[], type: string): AnthropicSseEvent[] {
  return frames.filter((frame) => frame.data.type === type)
}

describe("AnthropicSseEncoder tool calls", () => {
  it("emits multi-frame and single-frame calls as the same atomic unit", () => {
    const multi = encode([
      tool("call", { name: "bash", stop: false }),
      tool("call", { input: '{"command"', stop: false }),
      tool("call", { input: ':"ls"}', stop: false }),
      tool("call", { stop: true }),
    ]).frames
    const single = encode([
      tool("call", { name: "bash", input: '{"command":"ls"}', stop: true }),
    ]).frames

    expect(multi).toEqual(single)
    expect(multi.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(multi[1]?.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call", name: "bash", input: {} },
    })
    expect(multi[2]?.data).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
    })
    expect(multi[4]?.data).toMatchObject({
      delta: { stop_reason: "tool_use" },
    })
  })

  it("emits an explicitly terminated argument-less call", () => {
    const { frames } = encode([
      tool("argless", { name: "ping", stop: false }),
      tool("argless", { stop: true }),
    ])
    const delta = framesOfType(frames, "content_block_delta")[0]
    expect(delta?.data).toMatchObject({
      delta: { type: "input_json_delta", partial_json: "" },
    })
    expect(framesOfType(frames, "message_stop")).toHaveLength(1)

    const singleFrame = encode([
      tool("argless", { name: "ping", input: "", stop: true }),
    ]).frames
    expect(framesOfType(singleFrame, "content_block_delta")[0]?.data).toMatchObject({
      delta: { type: "input_json_delta", partial_json: "" },
    })
    expect(framesOfType(singleFrame, "message_stop")).toHaveLength(1)
  })

  it("discards an unterminated tool instead of manufacturing an empty call", () => {
    for (const events of [
      [tool("truncated", { name: "bash", stop: false })],
      [
        tool("truncated", { name: "bash", stop: false }),
        tool("truncated", { input: '{"command":', stop: false }),
      ],
    ]) {
      const { encoder, frames } = encode(events)
      expect(framesOfType(frames, "content_block_start")).toHaveLength(0)
      expect(framesOfType(frames, "message_stop")).toHaveLength(0)
      expect(framesOfType(frames, "error")).toEqual([
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
      expect(encoder.diagnostics.discardedPendingTool).toBe(1)
    }
  })

  it("stringifies object input before atomic emission", () => {
    const parsed = parseKiroEvent({
      eventType: "toolUseEvent",
      payload: { toolUseId: "object", name: "bash", input: { command: "ls" }, stop: true },
    })
    const { frames } = encode([parsed])
    expect(framesOfType(frames, "content_block_delta")[0]?.data).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
    })
  })

  it("keeps a pending tool intact across interleaved reasoning and text", () => {
    const { frames } = encode([
      tool("interleaved", { name: "bash", stop: false }),
      { kind: "reasoning", text: "checking" },
      tool("interleaved", { input: '{"command":', stop: false }),
      { kind: "text", content: "status" },
      tool("interleaved", { input: '"ls"}', stop: false }),
      tool("interleaved", { stop: true }),
    ])

    const starts = framesOfType(frames, "content_block_start")
    expect(starts.map((frame) => frame.data.index)).toEqual([0, 1, 2])
    expect(starts.map((frame) => (frame.data.content_block as { type: string }).type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ])
    const toolStarts = starts.filter(
      (frame) => (frame.data.content_block as { type: string }).type === "tool_use",
    )
    expect(toolStarts).toHaveLength(1)
    const toolDeltas = framesOfType(frames, "content_block_delta").filter(
      (frame) => (frame.data.delta as { type: string }).type === "input_json_delta",
    )
    expect(toolDeltas).toHaveLength(1)
    expect(toolDeltas[0]?.data).toMatchObject({
      index: 2,
      delta: { partial_json: '{"command":"ls"}' },
    })
    expect(
      framesOfType(frames, "content_block_stop").map((frame) => frame.data.index),
    ).toEqual([0, 1, 2])
  })

  it("drops input after stop and merges duplicate announcements", () => {
    const encoder = new AnthropicSseEncoder(opts)
    encoder.begin()
    expect(encoder.onEvent(tool("call", { stop: false }))).toEqual([])
    expect(encoder.onEvent(tool("call", { name: "bash", stop: false }))).toEqual([])
    const emitted = encoder.onEvent(tool("call", { input: "{}", stop: true }))
    expect(framesOfType(emitted, "content_block_start")).toHaveLength(1)
    expect(emitted[0]?.data).toMatchObject({
      content_block: { id: "call", name: "bash" },
    })
    expect(encoder.onEvent(tool("call", { input: '{"late":true}', stop: false }))).toEqual([])
    expect(encoder.diagnostics.droppedToolFragments).toBe(1)
  })

  it("discards an old pending id when a new tool begins", () => {
    const { encoder, frames } = encode([
      tool("old", { name: "bash", stop: false }),
      tool("old", { input: '{"command":"bad"}', stop: false }),
      tool("new", { name: "bash", stop: false }),
      tool("new", { input: '{"command":"good"}', stop: true }),
    ])
    const starts = framesOfType(frames, "content_block_start")
    expect(starts).toHaveLength(1)
    expect(starts[0]?.data).toMatchObject({ content_block: { id: "new" } })
    expect(framesOfType(frames, "content_block_delta")[0]?.data).toMatchObject({
      delta: { partial_json: '{"command":"good"}' },
    })
    expect(encoder.diagnostics.discardedPendingTool).toBe(1)
  })
})

describe("AnthropicSseEncoder transitions", () => {
  it("makes a mid-stream provider error terminal", () => {
    const encoder = new AnthropicSseEncoder(opts)
    const frames = [
      ...encoder.begin(),
      ...encoder.onEvent({ kind: "text", content: "partial" }),
      ...encoder.onEvent(tool("pending", { name: "bash", stop: false })),
      ...encoder.onEvent({ kind: "streamError", message: "failed ksk_secret" }),
    ]

    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ])
    expect(framesOfType(frames, "error")[0]?.data).toMatchObject({
      error: { type: "api_error", message: "failed ksk_<redacted>" },
    })
    expect(encoder.terminated).toBe(true)
    expect(encoder.diagnostics.discardedPendingTool).toBe(1)
    expect(encoder.onEvent({ kind: "text", content: "ignored" })).toEqual([])
    expect(encoder.onEof()).toEqual([])
    expect(framesOfType(frames, "message_stop")).toHaveLength(0)
  })

  it("ends a reasoning-only stream with an empty-turn error", () => {
    const { frames } = encode([
      { kind: "reasoning", text: "working" },
      { kind: "reasoning", signature: "sig" },
    ])
    expect(framesOfType(frames, "content_block_start")[0]?.data).toMatchObject({
      content_block: { type: "thinking" },
    })
    expect(framesOfType(frames, "error")).toHaveLength(1)
    expect(framesOfType(frames, "message_stop")).toHaveLength(0)
  })

  it("keeps a signature-only thinking block alive with the omitted sentinel", () => {
    const encoder = new AnthropicSseEncoder(opts)
    const frames = encoder.onEvent({ kind: "reasoning", signature: "sig_hidden" })
    expect(frames.map((frame) => frame.data)).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_hidden" },
      },
      { type: "content_block_stop", index: 0 },
    ])
  })

  it("computes usage and end-turn stop reason from text and context usage", () => {
    const { frames } = encode([
      { kind: "reasoning", text: "abcd" },
      { kind: "reasoning", signature: "sig" },
      { kind: "text", content: "12345" },
      { kind: "contextUsage", percent: 25 },
    ])
    expect(framesOfType(frames, "message_delta")).toEqual([
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 250, output_tokens: 3 },
        },
      },
    ])
  })

  it("records unknown event types without emitting frames", () => {
    const encoder = new AnthropicSseEncoder(opts)
    expect(
      encoder.onEvent({ kind: "unknown", eventType: "futureEvent", payload: { value: 1 } }),
    ).toEqual([])
    expect(encoder.diagnostics.unknownEventTypes).toEqual({ futureEvent: 1 })
  })
})

describe("serializeSse", () => {
  it("serializes one event and data record", () => {
    expect(serializeSse({ event: "message_stop", data: { type: "message_stop" } })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    )
  })
})
