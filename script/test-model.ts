// Live check that a modelId is accepted end-to-end: sends a tiny prompt, prints the reply.
// Usage: bun run script/test-model.ts <modelId>
import { getValidAccessToken } from "../src/auth"
import { getProfileArn } from "../src/profile"
import { toKiroRequest, kiroToAnthropicStream } from "../src/transform"

const model = process.argv[2] ?? "claude-sonnet-4.6"
const token = await getValidAccessToken()
const profileArn = await getProfileArn(token)
const request = toKiroRequest(
  { model, messages: [{ role: "user", content: "Reply with exactly: ok" }] } as any,
  token,
  profileArn,
)
const res = await fetch(request.url, request.init)
if (!res.ok) {
  console.log(`${model}: HTTP ${res.status}`, (await res.text()).slice(0, 300))
  process.exit(1)
}
const out = await kiroToAnthropicStream(res, model).text()
const text = out
  .split("\n")
  .filter((l) => l.startsWith("data:") && l.includes("text_delta"))
  .map((l) => JSON.parse(l.slice(5)).delta.text)
  .join("")
console.log(`${model}: OK ->`, JSON.stringify(text.slice(0, 80)))
