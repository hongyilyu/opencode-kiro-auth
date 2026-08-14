// End-to-end check of web_search through the configured OpenCode provider.
import { runOpenCode } from "./opencode"

const query = process.argv[2] ?? "latest Node.js LTS version"
await runOpenCode([
  "run",
  `Use web_search to answer this query with one cited result: ${query}`,
  "--model",
  "kiro/claude-sonnet-4.6",
])
