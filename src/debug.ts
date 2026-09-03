import { randomUUID } from "node:crypto"
import { REFRESH_STATE_PREFIX } from "./constants"

/**
 * Per-request diagnostics handle. `enabled` is captured once when the context is created, so
 * every log call answers to the context rather than re-reading the environment.
 */
export type KiroDebugContext = {
  id: string
  startedAt: number
  enabled: boolean
}

export function createKiroDebugContext(): KiroDebugContext {
  return { id: randomUUID(), startedAt: Date.now(), enabled: kiroDebugEnabled() }
}

function kiroDebugEnabled(): boolean {
  const value = process.env.KIRO_DEBUG?.trim().toLowerCase()
  return value === "1" || value === "true"
}

export function kiroDebug(
  context: KiroDebugContext,
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!context.enabled) return
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

// The packed refresh state is base64url (no padding), so its alphabet is exactly [A-Za-z0-9_-].
const REFRESH_STATE_PATTERN = new RegExp(`\\b${REFRESH_STATE_PREFIX}[A-Za-z0-9_-]+`, "g")

/**
 * Redact every credential shape this plugin handles: API keys, bearer tokens, and the packed
 * OAuth refresh state (refresh token + client secret in one blob). Idempotent.
 */
export function redactKiroSecrets(value: string): string {
  return value
    .replace(REFRESH_STATE_PATTERN, `${REFRESH_STATE_PREFIX}<redacted>`)
    .replace(/\bksk_(?!<redacted>)[A-Za-z0-9._~+\/=:-]*/g, "ksk_<redacted>")
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
