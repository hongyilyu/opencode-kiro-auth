import { spawn } from "node:child_process"

export async function runOpenCode(args: string[]): Promise<void> {
  const localPlugin = new URL("../", import.meta.url).href
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")
  } catch {
    throw new Error("OPENCODE_CONFIG_CONTENT must be valid JSON.")
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : []

  const child = spawn("opencode", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        plugin: [...plugins, localPlugin],
      }),
    },
    stdio: "inherit",
  })
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (value) => resolve(value ?? 1))
  })
  if (code !== 0) process.exit(code)
}
