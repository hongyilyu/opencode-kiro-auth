// Verifies the OpenCode-owned Kiro credential end to end. Never reads or prints tokens.
import { runOpenCode } from "./opencode"

const model = process.argv[2] ?? "claude-haiku-4.5"
await runOpenCode([
  "run",
  "Reply with exactly: ok",
  "--model",
  `kiro/${model}`,
])
