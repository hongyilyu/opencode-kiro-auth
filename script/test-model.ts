// Usage: bun run script/test-model.ts <modelId>
import { runOpenCode } from "./opencode"

const model = process.argv[2] ?? "claude-sonnet-4.6"
await runOpenCode([
  "run",
  "Reply with exactly: ok",
  "--model",
  `kiro/${model}`,
])
