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
      details: redactDebugValue(details),
    })}`,
  )
}

export function kiroDebugError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: compact(redactKiroSecrets(error.message)) }
  return { name: typeof error, message: compact(redactKiroSecrets(String(error))) }
}

export function redactKiroSecrets(value: string): string {
  return value
    .replace(/\bksk_[A-Za-z0-9._~+\/=:-]*/g, "ksk_<redacted>")
    .replace(
      /(\bBearer\s+)(?!(?:token|authentication|credential)\b)[^\s,;"'}\]]+/gi,
      "$1<redacted>",
    )
}

function redactDebugValue(value: unknown): unknown {
  if (typeof value === "string") return redactKiroSecrets(value)
  if (Array.isArray(value)) return value.map(redactDebugValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactDebugValue(entry)]),
  )
}

function compact(value: string, maxLength = 500): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength)}...`
}
