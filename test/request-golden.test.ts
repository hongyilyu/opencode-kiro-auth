import { describe, expect, it } from "bun:test"
import { toKiroPayload } from "../src/transform"
import { isolateEnv } from "./support/isolation"

const MODULE_CWD = process.cwd()
const IMAGE = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
})
const BASH_TOOL = { name: "bash", description: "Run a command", input_schema: { type: "object" } }

function normalizedPayloadJson(body: any, effort?: string, preserveCwd = false): string {
  const payload: any = structuredClone(toKiroPayload(body, effort))
  payload.conversationState.conversationId = "<conversation-id>"
  payload.conversationState.agentContinuationId = "<continuation-id>"

  const normalize = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach(normalize)
      return
    }

    const object = value as Record<string, unknown>
    if (typeof object.content === "string") {
      object.content = object.content.replace(/Current time: [^\n]+/, "Current time: <timestamp>")
    }
    if (object.currentWorkingDirectory === MODULE_CWD) {
      object.currentWorkingDirectory = preserveCwd ? "<module-load-cwd>" : "<cwd>"
    }
    Object.values(object).forEach(normalize)
  }
  normalize(payload)

  return JSON.stringify(payload, null, 2)
}

describe("request payload golden corpus", () => {
  isolateEnv("KIRO_KEEP_IMAGE_TURNS")

  it("maps a plain text turn", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "continue" },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("folds system text into the first user turn", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        system: [{ type: "text", text: "Follow the rules." }],
        messages: [{ role: "user", content: [{ type: "text", text: "Start." }] }],
      }),
    ).toMatchSnapshot()
  })

  it("maps a tool-result continuation", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        tools: [BASH_TOOL],
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "a.ts" }] },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("splits a mixed retry turn", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        tools: [BASH_TOOL],
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "a.ts" },
              { type: "text", text: "Try again with details." },
            ],
          },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("degrades an orphaned tool use", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        tools: [BASH_TOOL],
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "orphan", name: "bash", input: { command: "ls" } }],
          },
          { role: "user", content: "What happened?" },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("degrades tool blocks during tool-less compaction", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "a.ts" }] },
          { role: "user", content: "Summarize." },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("trims images across the retention boundary", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        tools: [BASH_TOOL],
        messages: [
          { role: "user", content: "capture" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "shot-1", name: "bash", input: { command: "screenshot" } }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "shot-1",
                content: [{ type: "text", text: "old" }, IMAGE("OLD_TOOL_IMAGE")],
              },
            ],
          },
          { role: "assistant", content: "captured" },
          { role: "user", content: [{ type: "text", text: "new" }, IMAGE("NEW_IMAGE")] },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("preserves a tool-result image inside the retention window", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        tools: [BASH_TOOL],
        messages: [
          { role: "user", content: "capture" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "shot-1", name: "bash", input: { command: "screenshot" } }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "shot-1",
                content: [{ type: "text", text: "latest" }, IMAGE("KEPT_TOOL_IMAGE")],
              },
            ],
          },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("replays signature-only reasoning", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson({
        model: "claude-fable-5",
        messages: [
          { role: "user", content: "start" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: " ", signature: "sig-hidden" },
              { type: "text", text: "done" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      }),
    ).toMatchSnapshot()
  })

  it("maps Claude and GPT effort variants", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      JSON.stringify(
        {
          claude: JSON.parse(
            normalizedPayloadJson(
              { model: "claude-fable-5", messages: [{ role: "user", content: "work" }] },
              "max",
            ),
          ),
          gpt: JSON.parse(
            normalizedPayloadJson(
              { model: "gpt-5.6-sol", messages: [{ role: "user", content: "work" }] },
              "xhigh",
            ),
          ),
        },
        null,
        2,
      ),
    ).toMatchSnapshot()
  })

  it("captures the module-load working directory", () => {
    process.env.KIRO_KEEP_IMAGE_TURNS = "1"
    expect(
      normalizedPayloadJson(
        { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "where am I?" }] },
        undefined,
        true,
      ),
    ).toMatchSnapshot()
  })
})
