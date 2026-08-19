import { randomUUID } from "node:crypto"

export type KiroDebugContext = {
  id: string
  startedAt: number
}

export function createKiroDebugContext(): KiroDebugContext {
  return { id: randomUUID(), startedAt: Date.now() }
}

export function kiroDebugEnabled(): boolean {
  const value = process.env.KIRO_DEBUG?.trim().toLowerCase()
  return value === "1" || value === "true"
}

export function kiroDebug(
  context: KiroDebugContext,
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!kiroDebugEnabled()) return
  console.error(
    `[kiro-debug] ${JSON.stringify({
      time: new Date().toISOString(),
      trace: context.id,
      elapsedMs: Date.now() - context.startedAt,
      event,
      details,
    })}`,
  )
}

export function kiroDebugError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: compact(error.message) }
  return { name: typeof error, message: compact(String(error)) }
}

function compact(value: string, maxLength = 500): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength)}...`
}
