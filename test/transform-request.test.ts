import { describe, expect, it } from "bun:test"
import { toKiroPayload } from "../src/transform"
import { isolateEnv } from "./support/isolation"

/** Parse the conversationState Kiro would receive for an Anthropic request body. */
function kiroPayload(body: any): any {
  return toKiroPayload(body)
}

function conversationState(body: any) {
  return kiroPayload(body).conversationState
}

function currentUserMessage(body: any) {
  return conversationState(body).currentMessage.userInputMessage
}

describe("tool-result continuation", () => {
  const body = {
    model: "claude-sonnet-4.6",
    tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
    ],
  }

  it("tool-result content empty", () => {
    expect(currentUserMessage(body).content).toBe("")
  })

  it("tool-result carried", () => {
    expect(currentUserMessage(body).userInputMessageContext.toolResults).toBeTruthy()
  })

  // Pure tool-result continuation (no text) WITH tools present stays structured.
  it("pure continuation keeps toolResults", () => {
    const pure = conversationState({
      model: "claude-sonnet-4.6",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "out" }] },
      ],
    })
    expect(pure.currentMessage.userInputMessage.userInputMessageContext.toolResults).toBeTruthy()
  })
})

// No tools sent + history has tool blocks (compaction): flatten to text, no toolConfig.
describe("tool-less requests (compaction)", () => {
  const flat = () =>
    conversationState({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "user", content: "summarize please" },
      ],
    })

  it("no-tools flattens tool blocks", () => {
    const state = flat()
    const hasToolStruct = state.history.some(
      (e: any) => e.assistantResponseMessage?.toolUses || e.userInputMessage?.userInputMessageContext?.toolResults,
    )
    expect(hasToolStruct).toBe(false)
    expect(JSON.stringify(state.history)).toContain("[called edit")
  })

  it("no-tools current has no toolConfig", () => {
    const state = flat()
    expect(state.currentMessage.userInputMessage.userInputMessageContext.tools ?? []).toHaveLength(0)
  })
})

describe("image trimming", () => {
  isolateEnv("KIRO_KEEP_IMAGE_TURNS")

  it("drops oldest image", () => {
    // Default keep=2 across 3 image turns drops the oldest.
    delete process.env.KIRO_KEEP_IMAGE_TURNS
    const img = (d: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: d } })
    const payload = kiroPayload({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: [img("OLD")] },
        { role: "assistant", content: "a" },
        { role: "user", content: [img("MID")] },
        { role: "assistant", content: "b" },
        { role: "user", content: [{ type: "text", text: "see" }, img("NEW")] },
      ],
    })
    const allImgs = [...payload.conversationState.history, payload.conversationState.currentMessage].flatMap(
      (e: any) => (e.userInputMessage?.images ?? []).map((i: any) => i.source.bytes),
    )
    expect(allImgs).not.toContain("OLD")
    expect(allImgs).toContain("MID")
    expect(allImgs).toContain("NEW")
  })
})

// A manual retry can be merged into the tool-result turn by the Anthropic adapter.
// Keep the tool protocol structured, then insert an assistant boundary before the retry.
describe("mixed tool-result retry turns", () => {
  const mixed = () =>
    conversationState({
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
    })

  it("mixed retry keeps structured tool use", () => {
    expect(mixed().history.at(-3)?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe("ss1")
  })

  it("mixed retry keeps structured tool result", () => {
    expect(mixed().history.at(-2)?.userInputMessage?.userInputMessageContext.toolResults?.[0]?.toolUseId).toBe("ss1")
  })

  it("mixed retry separates result content", () => {
    expect(mixed().history.at(-2)?.userInputMessage?.content).toBe("")
  })

  it("mixed retry inserts assistant boundary", () => {
    const boundary = mixed().history.at(-1)?.assistantResponseMessage
    expect(typeof boundary?.content).toBe("string")
    expect(boundary.content.length).toBeGreaterThan(0)
  })

  it("mixed retry keeps current text only", () => {
    const current = mixed().currentMessage.userInputMessage
    expect(current.userInputMessageContext.toolResults).toBeUndefined()
    expect(current.content).toContain("Create a summary")
    expect(current.content).not.toContain("shot-data")
  })
})

// Orphan tool_use WITH tools present (compaction cut): degraded to text on both sides.
describe("orphaned tool blocks", () => {
  it("orphan tool_use degraded", () => {
    const orphan = conversationState({
      model: "claude-sonnet-4.6",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "orph", name: "bash", input: { cmd: "ls" } }] },
        { role: "user", content: "what did you find?" }, // no tool_result -> orphan tool_use
      ],
    })
    expect(orphan.history.some((e: any) => e.assistantResponseMessage?.toolUses)).toBe(false)
    expect(JSON.stringify(orphan.history)).toContain("[called bash")
  })

  // A history cut can make a tool-result continuation the first user turn. Folding the
  // system prompt into it makes the turn mixed, so normalize after folding and flatten it.
  it("system mixed with first tool result is flattened", () => {
    const state = conversationState({
      model: "claude-sonnet-4.6",
      system: "system",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "cut1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "cut1", content: "result" }] },
        { role: "user", content: "continue" },
      ],
    })
    const history = JSON.stringify(state.history)
    expect(history).not.toContain("toolResults")
    expect(history).not.toContain("toolUses")
    expect(history).toContain("result")
  })
})

// Reasoning captured from a Kiro stream must replay back to Kiro on the next request.
describe("reasoning replay", () => {
  it("signed reasoning replays to Kiro", () => {
    const replayed = conversationState({
      model: "claude-fable-5",
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "working", signature: "sig_replay" },
            { type: "text", text: "done" },
          ],
        },
        { role: "user", content: "next" },
      ],
    }).history[1].assistantResponseMessage
    expect(replayed.content).toBe("done")
    expect(replayed.reasoningContent?.reasoningText?.text).toBe("working")
    expect(replayed.reasoningContent?.reasoningText?.signature).toBe("sig_replay")
  })

  // OpenCode ignores an empty thinking block, so the stream side keeps it alive with a
  // single-space sentinel; the request side must map that space back to empty on replay.
  it("signature-only reasoning replays with omitted text", () => {
    const replayed = conversationState({
      model: "claude-fable-5",
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: " ", signature: "sig_hidden" },
            { type: "tool_use", id: "signed-tool", name: "bash", input: { command: "ls" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "signed-tool", content: "ok" }] },
      ],
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
    }).history[1].assistantResponseMessage
    expect(replayed.reasoningContent?.reasoningText?.text).toBe("")
    expect(replayed.reasoningContent?.reasoningText?.signature).toBe("sig_hidden")
  })
})

// Variant -> additionalModelRequestFields mapping (Claude vs GPT vs none).
describe("effort variant fields", () => {
  const fields = (model: string, effort?: string) =>
    toKiroPayload({ model, messages: [{ role: "user", content: "hi" }] }, effort)
      .additionalModelRequestFields

  it("claude variant -> output_config.effort", () => {
    const claudeFields = fields("claude-fable-5", "max")
    expect(claudeFields?.output_config?.effort).toBe("max")
    expect(claudeFields?.thinking?.type).toBe("adaptive")
  })

  it("gpt variant -> reasoning.effort", () => {
    expect(fields("gpt-5.6-sol", "xhigh")?.reasoning?.effort).toBe("xhigh")
  })

  it("no variant -> no extra fields", () => {
    expect(fields("claude-fable-5")).toBeUndefined()
  })
})
