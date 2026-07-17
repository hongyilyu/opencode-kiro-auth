// Combined regression smoke test after the release cleanup.
import { toKiroRequest, kiroToAnthropicStream, mapKiroError } from "../src/transform"

const checks: Array<[string, boolean]> = []
const cur = (body: any) => JSON.parse(toKiroRequest(body, "t", "a").init.body as string).conversationState.currentMessage.userInputMessage

// 1) Tool-result continuation -> empty content, tool results carried in context.
const tr = cur({
  model: "claude-sonnet-4.6",
  tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
  ],
})
checks.push(["tool-result content empty", tr.content === ""])
checks.push(["tool-result carried", Boolean(tr.userInputMessageContext.toolResults)])

// 2) No tools sent + history has tool blocks (compaction): flatten to text, no toolConfig.
const flat = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "user", content: "summarize please" },
      ],
    } as any,
    "t",
    "a",
  ).init.body as string,
).conversationState
const flatHasToolStruct = flat.history.some(
  (e: any) => e.assistantResponseMessage?.toolUses || e.userInputMessage?.userInputMessageContext?.toolResults,
)
const flatHasCalledText = JSON.stringify(flat.history).includes("[called edit")
checks.push(["no-tools flattens tool blocks", !flatHasToolStruct && flatHasCalledText])
checks.push(["no-tools current has no toolConfig", (flat.currentMessage.userInputMessage.userInputMessageContext.tools ?? []).length === 0])

// 4) Image trimming: default keep=2 across 3 image turns drops the oldest.
delete process.env.KIRO_KEEP_IMAGE_TURNS
const img = (d: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: d } })
const payload = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: [img("OLD")] },
        { role: "assistant", content: "a" },
        { role: "user", content: [img("MID")] },
        { role: "assistant", content: "b" },
        { role: "user", content: [{ type: "text", text: "see" }, img("NEW")] },
      ],
    } as any,
    "t",
    "a",
  ).init.body as string,
)
const allImgs = [...payload.conversationState.history, payload.conversationState.currentMessage]
  .flatMap((e: any) => (e.userInputMessage?.images ?? []).map((i: any) => i.source.bytes))
checks.push(["drops oldest image", !allImgs.includes("OLD") && allImgs.includes("MID") && allImgs.includes("NEW")])

// 5) Usage from context percentage.
function frame(eventType: string, p: unknown): Buffer {
  const b = Buffer.from(JSON.stringify(p)); const name = Buffer.from(":event-type"); const v = Buffer.from(eventType)
  const vl = Buffer.alloc(2); vl.writeUInt16BE(v.length)
  const h = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), vl, v])
  const total = 12 + h.length + b.length + 4; const buf = Buffer.alloc(total); let o = 0
  buf.writeUInt32BE(total, o); o += 4; buf.writeUInt32BE(h.length, o); o += 4; buf.writeUInt32BE(0, o); o += 4
  h.copy(buf, o); o += h.length; b.copy(buf, o); o += b.length; buf.writeUInt32BE(0, o); return buf
}
const stream = Buffer.concat([frame("assistantResponseEvent", { content: "hello" }), frame("contextUsageEvent", { contextUsagePercentage: 5 })])
const out = await kiroToAnthropicStream(new Response(new Uint8Array(stream)), "claude-sonnet-4.6", 1_000_000).text()
const delta = out.split("\n").find((l) => l.startsWith("data:") && l.includes("message_delta"))
const usage = delta ? JSON.parse(delta.slice(5)).usage : null
checks.push(["usage input tokens", usage?.input_tokens === 50_000])

// 6) Error mapping -> context overflow phrase.
const mapped = mapKiroError(JSON.stringify({ reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD", message: "Input content length exceeds threshold." }), 400)
checks.push(["overflow mapping", mapped.status === 400 && mapped.body.toLowerCase().includes("prompt is too long")])
checks.push(["passthrough", mapKiroError("boom", 500).body === "boom"])

// 7) Mixed tool_result + text turn WITH tools present: inline result, unpair tool_use.
const mixed = JSON.parse(
  toKiroRequest(
    {
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
    } as any,
    "t",
    "a",
  ).init.body as string,
).conversationState
const mixedCurrent = mixed.currentMessage.userInputMessage
const mixedPrevAsst = mixed.history[mixed.history.length - 1].assistantResponseMessage
checks.push(["mixed turn drops structured toolResults", mixedCurrent.userInputMessageContext.toolResults === undefined])
checks.push(["mixed turn keeps text", mixedCurrent.content.includes("Create a summary") && mixedCurrent.content.includes("shot-data")])
checks.push(["preceding assistant unpaired", mixedPrevAsst.toolUses === undefined])

// 8) Pure tool-result continuation (no text) WITH tools present stays structured.
const pure = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "out" }] },
      ],
    } as any,
    "t",
    "a",
  ).init.body as string,
).conversationState
checks.push(["pure continuation keeps toolResults", Boolean(pure.currentMessage.userInputMessage.userInputMessageContext.toolResults)])

// 8) Orphan tool_use WITH tools present (compaction cut): degraded to text on both sides.
const orphan = JSON.parse(
  toKiroRequest(
    {
      model: "claude-sonnet-4.6",
      tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "orph", name: "bash", input: { cmd: "ls" } }] },
        { role: "user", content: "what did you find?" }, // no tool_result -> orphan tool_use
      ],
    } as any,
    "t",
    "a",
  ).init.body as string,
).conversationState
const orphanHasToolUse = orphan.history.some((e: any) => e.assistantResponseMessage?.toolUses)
const orphanHasCalledText = JSON.stringify(orphan.history).includes("[called bash")
checks.push(["orphan tool_use degraded", !orphanHasToolUse && orphanHasCalledText])

// 9) Variant -> additionalModelRequestFields mapping (Claude vs GPT vs none).
const fields = (model: string, variant?: string) =>
  JSON.parse(toKiroRequest({ model, messages: [{ role: "user", content: "hi" }] } as any, "t", "a", variant).init.body as string)
    .additionalModelRequestFields
const claudeFields = fields("claude-fable-5", "max")
checks.push(["claude variant -> output_config.effort", claudeFields?.output_config?.effort === "max" && claudeFields?.thinking?.type === "adaptive"])
checks.push(["gpt variant -> reasoning.effort", fields("gpt-5.6-sol", "xhigh")?.reasoning?.effort === "xhigh"])
checks.push(["no variant -> no extra fields", fields("claude-fable-5") === undefined])

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
