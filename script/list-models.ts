// Lists the Kiro models resolved by OpenCode's provider configuration.
import { runOpenCode } from "./opencode"

await runOpenCode(["models", "kiro", "--verbose"])
