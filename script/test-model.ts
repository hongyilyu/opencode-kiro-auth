// Usage: bun run script/test-model.ts <modelId>
import { runOpenCode } from "./opencode"

const model = process.argv[2] ?? "claude-haiku-4.5"
await runOpenCode([
  "run",
  "Reply with exactly: ok",
  "--model",
  `kiro/${model}`,
])
