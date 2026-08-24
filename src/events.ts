import { redactKiroSecrets } from "./debug"
import type { KiroEvent } from "./eventstream"

export const KTR_MARKER = ".KTR~~"
export const KTR_REASONING_PLACEHOLDER = "..."
// OpenCode drops an empty Anthropic thinking block before its later signature_delta arrives.
// A single space keeps the block alive; request replay maps it back to Kiro's empty form.
export const OMITTED_REASONING_SENTINEL = " "

export type KiroStreamEvent =
  | { kind: "text"; content: string }
  | { kind: "reasoning"; text?: string; signature?: string }
  | { kind: "toolUse"; id: string; name?: string; input?: string; stop: boolean }
  | { kind: "contextUsage"; percent: number }
  | {
      kind: "metadata"
      stopReason?: string
      refusal?: { category?: string; explanation?: string }
    }
  | { kind: "rateLimit"; message: string; retryAfterSeconds?: string }
  | { kind: "timeout"; message: string }
  | { kind: "streamError"; message: string }
  | { kind: "unknown"; eventType: string; payload: Record<string, unknown> }

function unknownEvent(eventType: string, payload: Record<string, unknown>): KiroStreamEvent {
  return { kind: "unknown", eventType, payload }
}

function stringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function redactedKtrSignature(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  // AWS JSON serializes blobs as base64 strings. Accepting the decoded marker only keeps arbitrary
  // provider redacted bytes out of the Anthropic signature field.
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return undefined
  const signature = decoded.toString("utf8")
  return signature.startsWith(KTR_MARKER) ? signature : undefined
}

function errorMessage(eventType: string, payload: Record<string, unknown>): string {
  const message = [payload.message, payload.Message, payload.errorMessage].find(
    (value) => typeof value === "string",
  )
  return redactKiroSecrets(
    typeof message === "string" && message.length > 0
      ? message
      : stringify(payload) || eventType,
  )
}

function retryAfterSeconds(payload: Record<string, unknown>): string | undefined {
  const value = payload.retryAfterSeconds ?? payload.retryAfter
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value)
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return value
  return undefined
}

/** Interpret one decoded Kiro wire event without closing the world to future event types. */
export function parseKiroEvent(event: KiroEvent): KiroStreamEvent {
  let eventType = "unknown"
  let payload: Record<string, unknown> = {}

  try {
    const rawEventType = event?.eventType
    eventType = typeof rawEventType === "string" ? rawEventType : "unknown"
    const rawPayload = event?.payload
    payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? rawPayload : {}
    const fallback = () => unknownEvent(eventType, payload)

    const lowerType = eventType.toLowerCase()
    if (lowerType === "error" || lowerType.includes("exception")) {
      const detail = `${eventType} ${stringify(payload) ?? ""}`.toLowerCase()
      const message = errorMessage(eventType, payload)
      if (
        detail.includes("throttl") ||
        detail.includes("toomanyrequests") ||
        detail.includes("too many requests") ||
        /rate[\s_-]*limit/.test(detail) ||
        /\brate(?:[\s_-]+limit)?[\s_-]+exceeded\b/.test(detail) ||
        /"(?:status|statuscode|httpstatuscode)"\s*:\s*429\b/.test(detail)
      ) {
        const retryAfter = retryAfterSeconds(payload)
        return {
          kind: "rateLimit",
          message,
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
        }
      }
      if (/timeout|timed out/i.test(`${eventType} ${stringify(payload) ?? ""}`)) {
        return { kind: "timeout", message }
      }
      return { kind: "streamError", message }
    }

    if (eventType === "assistantResponseEvent") {
      return typeof payload.content === "string" && payload.content.length > 0
        ? { kind: "text", content: payload.content }
        : fallback()
    }

    if (eventType === "reasoningContentEvent") {
      const redactedSignature = redactedKtrSignature(payload.redactedContent)
      if (redactedSignature) {
        return {
          kind: "reasoning",
          text: KTR_REASONING_PLACEHOLDER,
          signature: redactedSignature,
        }
      }

      const text = typeof payload.text === "string" && payload.text.length > 0 ? payload.text : undefined
      const signature =
        typeof payload.signature === "string" && payload.signature.length > 0
          ? payload.signature
          : undefined
      if (!text && !signature) return fallback()
      return {
        kind: "reasoning",
        ...(text ? { text } : {}),
        ...(signature ? { signature } : {}),
      }
    }

    if (eventType === "toolUseEvent") {
      const id = payload.toolUseId
      if (typeof id !== "string" || id.length === 0) return fallback()

      let input: string | undefined
      if (typeof payload.input === "string") {
        input = payload.input
      } else if (payload.input !== null && typeof payload.input === "object") {
        input = stringify(payload.input)
        if (input === undefined) return fallback()
      }
      return {
        kind: "toolUse",
        id,
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        ...(input !== undefined ? { input } : {}),
        stop: payload.stop === true,
      }
    }

    if (eventType === "contextUsageEvent") {
      return typeof payload.contextUsagePercentage === "number" &&
        Number.isFinite(payload.contextUsagePercentage)
        ? { kind: "contextUsage", percent: payload.contextUsagePercentage }
        : fallback()
    }

    if (eventType === "metadataEvent") {
      if (typeof payload.stopReason !== "string") return fallback()
      const stopDetails =
        payload.stopDetails && typeof payload.stopDetails === "object"
          ? (payload.stopDetails as { refusal?: unknown })
          : undefined
      const rawRefusal =
        stopDetails?.refusal && typeof stopDetails.refusal === "object"
          ? (stopDetails.refusal as { category?: unknown; explanation?: unknown })
          : undefined
      const refusal = rawRefusal
        ? {
            ...(typeof rawRefusal.category === "string" ? { category: rawRefusal.category } : {}),
            ...(typeof rawRefusal.explanation === "string"
              ? { explanation: rawRefusal.explanation }
              : {}),
          }
        : undefined
      return {
        kind: "metadata",
        stopReason: payload.stopReason,
        ...(refusal ? { refusal } : {}),
      }
    }

    return fallback()
  } catch {
    return unknownEvent(eventType, payload)
  }
}

/** Whether preflight can safely release the stream without hiding visible model progress. */
export function beginsAssistantOutput(event: KiroStreamEvent): boolean {
  if (event.kind === "text") return true
  if (event.kind === "reasoning") {
    return Boolean(event.text || event.signature?.startsWith(KTR_MARKER))
  }
  return event.kind === "toolUse" && (event.input !== undefined || !event.stop)
}

/** Whether an event can complete a usable turn; the encoder separately verifies tool emission. */
export function completesAssistantTurn(event: KiroStreamEvent): boolean {
  return event.kind === "text" || (event.kind === "toolUse" && event.stop)
}

/** Resolve retry-after once for HTTP and in-band rate-limit responses. */
export function resolveRetryAfter(source: {
  header?: string | null
  event?: KiroStreamEvent
}): string | undefined {
  const raw = process.env.KIRO_RATE_LIMIT_RETRY_SECONDS?.trim()
  if (raw) {
    const seconds = Number(raw)
    if (Number.isSafeInteger(seconds) && seconds > 0) return String(seconds)
  }
  if (source.header) return source.header
  return source.event?.kind === "rateLimit" ? source.event.retryAfterSeconds : undefined
}
