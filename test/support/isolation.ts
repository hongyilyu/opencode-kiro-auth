import { afterEach, beforeEach } from "bun:test"

/**
 * Snapshot the named environment variables before each test in the enclosing scope and restore
 * them afterwards. Variables that were unset before a test are deleted again, so tests can
 * freely set or delete them without leaking state into later tests (or the developer's shell).
 */
export function isolateEnv(...names: string[]): void {
  let saved: Array<[string, string | undefined]> = []
  beforeEach(() => {
    saved = names.map((name) => [name, process.env[name]])
  })
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

/**
 * Capture console.error output for each test in the enclosing scope, restoring the real
 * implementation afterwards. Returns a live handle whose `lines` array is reset per test.
 */
export function captureConsoleError(): { lines: string[] } {
  const capture = { lines: [] as string[] }
  let original: typeof console.error
  beforeEach(() => {
    original = console.error
    capture.lines.length = 0
    console.error = (...args: unknown[]) => {
      capture.lines.push(args.map(String).join(" "))
    }
  })
  afterEach(() => {
    console.error = original
  })
  return capture
}
