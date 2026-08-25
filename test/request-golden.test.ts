import { describe, expect, it } from "bun:test"
import { toKiroPayload, type RequestDependencies } from "../src/request"

const GOLDEN_NOW = {
  toLocaleDateString: () => "Friday",
  getFullYear: () => 2026,
  getMonth: () => 5,
  getDate: () => 12,
  getHours: () => 20,
  getMinutes: () => 9,
  getSeconds: () => 5,
  getMilliseconds: () => 270,
  getTimezoneOffset: () => -420,
} as Date
const IMAGE = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
})
const BASH_TOOL = { name: "bash", description: "Run a command", input_schema: { type: "object" } }

function dependencies(cwd = "/golden/cwd"): RequestDependencies {
  let uuid = 0
  return {
    now: () => GOLDEN_NOW,
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    cwd: () => cwd,
    keepImageTurns: 1,
  }
}

function normalizedPayloadJson(body: any, effort?: string, cwd?: string): string {
  return JSON.stringify(toKiroPayload(body, effort, undefined, dependencies(cwd)), null, 2)
}

describe("request payload golden corpus", () => {
  it("maps a plain text turn", () => {
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
    expect(
      normalizedPayloadJson({
        model: "claude-sonnet-4.6",
        system: [{ type: "text", text: "Follow the rules." }],
        messages: [{ role: "user", content: [{ type: "text", text: "Start." }] }],
      }),
    ).toMatchSnapshot()
  })

  it("maps a tool-result continuation", () => {
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

  it("captures the working directory for each request", () => {
    // Sanctioned change: cwd now comes from the request dependency, not module initialization.
    expect(
      normalizedPayloadJson(
        { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "where am I?" }] },
        undefined,
        "/request/cwd",
      ),
    ).toMatchSnapshot()
  })
})
