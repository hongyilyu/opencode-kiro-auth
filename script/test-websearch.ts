// End-to-end check of web_search through the configured OpenCode provider.
import { runOpenCode } from "./opencode"

const query = process.argv[2] ?? "latest Node.js LTS version"
const model = process.argv[3] ?? "claude-haiku-4.5"
await runOpenCode([
  "run",
  `Use web_search to answer this query with one cited result: ${query}`,
  "--model",
  `kiro/${model}`,
])
