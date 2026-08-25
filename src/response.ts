import { drainKiroEvents, type KiroEvent } from "./eventstream"
import {
  EMPTY_TURN_ERROR_MESSAGE,
  beginsAssistantOutput,
  parseKiroEvent,
  resolveRetryAfter,
  type KiroStreamEvent,
} from "./events"
import { AnthropicSseEncoder, serializeSse, type AnthropicSseEvent } from "./sse"
import {
  createKiroDebugContext,
  kiroDebug,
  kiroDebugEnabled,
  kiroDebugError,
  redactKiroSecrets,
  type KiroDebugContext,
} from "./debug"

/* ---------------------------- response mapping ----------------------------- */

/** Canonical Anthropic error wire shape. Every error we emit flows through here. */
function anthropicErrorBody(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } })
}

export function anthropicErrorResponse(status: number, type: string, message: string, headers?: Headers): Response {
  return new Response(anthropicErrorBody(type, message), {
    status,
    headers: headers ?? { "content-type": "application/json" },
  })
}

function rateLimitResponse(
  res: Response,
  event: Extract<KiroStreamEvent, { kind: "rateLimit" }>,
): Response {
  const headers = new Headers({ "content-type": "application/json" })
  const retryAfter = resolveRetryAfter({ header: res.headers.get("retry-after"), event })
  if (retryAfter) headers.set("retry-after", retryAfter)
  return anthropicErrorResponse(429, "rate_limit_error", event.message, headers)
}

type DecodedKiroEvent = { event: KiroEvent; parsed: KiroStreamEvent }

type KiroEventSourceRead =
  | { kind: "event"; entry: DecodedKiroEvent }
  | { kind: "eof" }
  | { kind: "readError"; error: unknown }

type KiroEventSource = {
  next(): Promise<KiroEventSourceRead>
  cancel(reason?: unknown): Promise<void>
  release(): void
  stats(): {
    chunks: number
    totalBytes: number
    eventCount: number
    eventTypes: Record<string, number>
    trailingBytes: number
  }
}

type PreflightResult =
  | { kind: "stream"; buffered: DecodedKiroEvent[] }
  | { kind: "httpError"; response: Response }

function createKiroEventSource(
  body: NonNullable<Response["body"]>,
  debug: KiroDebugContext,
  debugEnabled: boolean,
): KiroEventSource {
  const reader = body.getReader()
  const pending: KiroEvent[] = []
  const eventTypes: Record<string, number> = {}
  let buf = Buffer.alloc(0)
  let chunks = 0
  let totalBytes = 0
  let eventCount = 0
  let cancellation: Promise<void> | undefined

  return {
    async next(): Promise<KiroEventSourceRead> {
      while (true) {
        const event = pending.shift()
        if (event) {
          eventCount += 1
          eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1
          if (debugEnabled) {
            kiroDebug(debug, "response.event", {
              sequence: eventCount,
              eventType: event.eventType,
              ...kiroEventShape(event),
            })
          }
          return { kind: "event", entry: { event, parsed: parseKiroEvent(event) } }
        }

        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (error) {
          return { kind: "readError", error }
        }
        if (next.done) return { kind: "eof" }

        chunks += 1
        totalBytes += next.value.byteLength
        buf = Buffer.concat([buf, Buffer.from(next.value)])
        const { events, rest } = drainKiroEvents(buf)
        buf = Buffer.from(rest)
        if (debugEnabled) {
          kiroDebug(debug, "response.chunk", {
            chunk: chunks,
            bytes: next.value.byteLength,
            totalBytes,
            decodedEvents: events.length,
            trailingBytes: buf.length,
          })
        }
        pending.push(...events)
      }
    },

    cancel(reason?: unknown): Promise<void> {
      if (!cancellation) {
        try {
          cancellation = Promise.resolve(reader.cancel(reason)).then(
            () => {},
            () => {},
          )
        } catch {
          cancellation = Promise.resolve()
        }
      }
      return cancellation
    },

    release(): void {
      reader.releaseLock()
    },

    stats() {
      return { chunks, totalBytes, eventCount, eventTypes, trailingBytes: buf.length }
    },
  }
}

async function preflightKiroEvents(
  res: Response,
  source: KiroEventSource,
  debug: KiroDebugContext,
  startedAt: number,
): Promise<PreflightResult> {
  const buffered: DecodedKiroEvent[] = []
  let terminalMetadata: Extract<KiroStreamEvent, { kind: "metadata" }> | undefined

  while (true) {
    const next = await source.next()
    if (next.kind === "readError") {
      const message = String(next.error)
      const stats = source.stats()
      kiroDebug(debug, "response.read_error", {
        ...kiroDebugError(next.error),
        chunks: stats.chunks,
        totalBytes: stats.totalBytes,
        eventCount: stats.eventCount,
        eventTypes: stats.eventTypes,
        preflightMs: Date.now() - startedAt,
      })
      return {
        kind: "httpError",
        response: anthropicErrorResponse(
          /timeout|timed out/i.test(message) ? 504 : 502,
          "api_error",
          redactKiroSecrets(message),
        ),
      }
    }

    if (next.kind === "eof") {
      const stats = source.stats()
      kiroDebug(debug, "response.empty_eof", {
        chunks: stats.chunks,
        totalBytes: stats.totalBytes,
        eventCount: stats.eventCount,
        eventTypes: stats.eventTypes,
        trailingBytes: stats.trailingBytes,
        preflightMs: Date.now() - startedAt,
      })
      return {
        kind: "httpError",
        response:
          terminalMetadata?.stopReason === "CONTENT_FILTERED"
            ? anthropicErrorResponse(400, "invalid_request_error", contentFilteredMessage(terminalMetadata))
            : anthropicErrorResponse(502, "api_error", EMPTY_TURN_ERROR_MESSAGE),
      }
    }

    const { event, parsed } = next.entry
    buffered.push(next.entry)
    if (parsed.kind === "metadata") terminalMetadata = parsed
    if (parsed.kind === "rateLimit") {
      await source.cancel()
      kiroDebug(debug, "response.rate_limited", {
        eventType: event.eventType,
        retryAfter: resolveRetryAfter({ header: res.headers.get("retry-after"), event: parsed }) ?? null,
      })
      return {
        kind: "httpError",
        response: rateLimitResponse(res, parsed),
      }
    }
    if (parsed.kind === "timeout") {
      await source.cancel()
      kiroDebug(debug, "response.timed_out", { eventType: event.eventType })
      return {
        kind: "httpError",
        response: anthropicErrorResponse(504, "api_error", parsed.message),
      }
    }
    if (parsed.kind === "streamError") {
      kiroDebug(debug, "response.error_passthrough", { eventType: event.eventType })
      return { kind: "stream", buffered }
    }
    if (!beginsAssistantOutput(parsed)) continue

    const stats = source.stats()
    kiroDebug(debug, "response.output_detected", {
      eventType: event.eventType,
      chunks: stats.chunks,
      totalBytes: stats.totalBytes,
      eventCount: stats.eventCount,
      preflightMs: Date.now() - startedAt,
    })
    return { kind: "stream", buffered }
  }
}

function anthropicStreamResponse(
  source: KiroEventSource,
  buffered: DecodedKiroEvent[],
  opts: { model: string; contextLimit: number },
  debug: KiroDebugContext,
  debugEnabled: boolean,
): Response {
  const textEncoder = new TextEncoder()
  const encoder = new AnthropicSseEncoder({ model: opts.model, contextLimit: opts.contextLimit })
  let outputCancelled = false

  const pump = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    let eventCount = 0
    const eventTypes: Record<string, number> = {}
    const send = (events: AnthropicSseEvent[]): void => {
      for (const event of events) controller.enqueue(textEncoder.encode(serializeSse(event)))
    }
    const sendEvent = (entry: DecodedKiroEvent): boolean => {
      eventCount += 1
      eventTypes[entry.event.eventType] = (eventTypes[entry.event.eventType] ?? 0) + 1
      if (debugEnabled) {
        kiroDebug(debug, "sse.event", {
          sequence: eventCount,
          eventType: entry.event.eventType,
          ...kiroEventShape(entry.event),
        })
      }
      send(encoder.onEvent(entry.parsed))
      if (!encoder.terminated) return false

      kiroDebug(debug, "sse.error", {
        name: entry.parsed.kind,
        message: "message" in entry.parsed ? entry.parsed.message : "Kiro stream error",
        eventCount,
        eventTypes,
        ...encoder.debugState(),
      })
      return true
    }

    try {
      send(encoder.begin())
      kiroDebug(debug, "sse.start", { model: opts.model, contextLimit: opts.contextLimit })

      for (const entry of buffered) {
        if (sendEvent(entry)) {
          void source.cancel()
          return
        }
      }

      while (true) {
        const next = await source.next()
        if (outputCancelled) return
        if (next.kind === "readError") throw next.error
        if (next.kind === "eof") {
          send(encoder.onEof())
          if (encoder.terminated) {
            kiroDebug(debug, "sse.empty_eof", {
              eventCount,
              eventTypes,
              ...encoder.debugState(),
            })
            return
          }
          kiroDebug(debug, "sse.complete", {
            eventCount,
            eventTypes,
            ...encoder.debugState(),
          })
          return
        }
        if (sendEvent(next.entry)) {
          void source.cancel()
          return
        }
      }
    } catch (error) {
      if (outputCancelled) return

      const failure = { kind: "streamError" as const, message: String(error) }
      const failureEvents = encoder.onEvent(failure)
      kiroDebug(debug, "sse.error", {
        ...kiroDebugError(error),
        eventCount,
        eventTypes,
        ...encoder.debugState(),
      })
      try {
        send(failureEvents)
      } catch {
        // The consumer may have cancelled while the upstream failure was in flight.
      }
      void source.cancel(error)
    } finally {
      try {
        controller.close()
      } catch {
        // A cancelled output stream is already closed.
      }
      source.release()
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void pump(controller)
    },
    async cancel(reason) {
      outputCancelled = true
      await source.cancel(reason)
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** Decode one Kiro response and expose either a pre-output HTTP error or Anthropic SSE. */
export async function kiroResponseToAnthropic(
  res: Response,
  opts: { model: string; contextLimit: number; debug?: KiroDebugContext },
): Promise<Response> {
  const debug = opts.debug ?? createKiroDebugContext()
  const preflightStartedAt = Date.now()
  const debugEnabled = kiroDebugEnabled()
  kiroDebug(debug, "response.preflight_start", { status: res.status, hasBody: Boolean(res.body) })
  const body = res.body
  if (!body) {
    kiroDebug(debug, "response.body_missing", { status: res.status })
    const response = anthropicErrorResponse(502, "api_error", "Kiro returned a response without an event stream.")
    kiroDebug(debug, "response.preflight_error", { status: response.status })
    return response
  }

  const source = createKiroEventSource(body, debug, debugEnabled)
  let preflight: PreflightResult
  try {
    preflight = await preflightKiroEvents(res, source, debug, preflightStartedAt)
  } catch (error) {
    void source.cancel(error)
    source.release()
    throw error
  }

  if (preflight.kind === "httpError") {
    source.release()
    kiroDebug(debug, "response.preflight_error", { status: preflight.response.status })
    return preflight.response
  }

  kiroDebug(debug, "response.preflight_ok", { contextLimit: opts.contextLimit })
  return anthropicStreamResponse(source, preflight.buffered, opts, debug, debugEnabled)
}

function contentFilteredMessage(metadata: Extract<KiroStreamEvent, { kind: "metadata" }>): string {
  const category = metadata.refusal?.category
  const explanation = metadata.refusal?.explanation

  return [
    `Kiro blocked this response${category ? ` (${category})` : " because the conversation triggered its content filter"}.`,
    explanation,
    "Retrying the unchanged conversation will not help.",
  ]
    .filter(Boolean)
    .join(" ")
}

function kiroEventShape(event: KiroEvent): Record<string, unknown> {
  const payload = event.payload
  const shape: Record<string, unknown> = { payloadKeys: Object.keys(payload).sort() }
  for (const key of [
    "conversationId",
    "stopReason",
    "reason",
    "code",
    "errorCode",
    "status",
    "statusCode",
    "unit",
    "unitPlural",
    "usage",
  ]) {
    const value = payload[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      shape[key] = value
    }
  }
  if (typeof payload.content === "string") shape.contentChars = payload.content.length
  if (typeof payload.toolUseId === "string") shape.toolUseId = payload.toolUseId
  if (typeof payload.name === "string") shape.toolName = payload.name
  if (typeof payload.input === "string") shape.inputChars = payload.input.length
  if (typeof payload.stop === "boolean") shape.stop = payload.stop
  if (typeof payload.contextUsagePercentage === "number") {
    shape.contextUsagePercentage = payload.contextUsagePercentage
  }
  if (typeof payload.message === "string") shape.message = payload.message.slice(0, 500)
  if (typeof payload.Message === "string") shape.message = payload.Message.slice(0, 500)
  if (typeof payload.errorMessage === "string") shape.message = payload.errorMessage.slice(0, 500)
  if (typeof payload.raw === "string") shape.rawChars = payload.raw.length
  const refusal =
    payload.stopDetails && typeof payload.stopDetails === "object"
      ? (payload.stopDetails as { refusal?: unknown }).refusal
      : undefined
  if (refusal && typeof refusal === "object") {
    const category = (refusal as { category?: unknown }).category
    const explanation = (refusal as { explanation?: unknown }).explanation
    shape.refusal = {
      ...(typeof category === "string" ? { category: category.slice(0, 100) } : {}),
      ...(typeof explanation === "string" ? { explanation: explanation.slice(0, 500) } : {}),
    }
  }
  return shape
}

/* ------------------------------ error mapping ------------------------------ */

/**
 * Translate a Kiro error response into something opencode handles well.
 *
 * Kiro returns a 400 ValidationException ("Input content length exceeds threshold",
 * reason CONTENT_LENGTH_EXCEEDS_THRESHOLD) when the whole request (history + images)
 * is too large. opencode only recognizes a request as a context overflow — and then
 * shows a clear "start a new session or /compact" message — when the 400 message
 * contains phrases like "prompt is too long". So we reshape that specific case into an
 * Anthropic-style error carrying that phrase; everything else is passed through verbatim.
 */
export function mapKiroError(detail: string, status: number): { body: string; status: number } {
  detail = redactKiroSecrets(detail)
  let reason = ""
  let message = ""
  try {
    const parsed = JSON.parse(detail) as { reason?: string; message?: string }
    reason = parsed.reason ?? ""
    message = parsed.message ?? ""
  } catch {
    // non-JSON body; fall through to pass-through
  }

  const tooLong = reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD" || /content length exceeds/i.test(message)
  if (status === 400 && tooLong) {
    const friendly =
      "Prompt is too long: Kiro rejected the request because the total input " +
      "(conversation history plus images) exceeds its content-length limit. Start a new " +
      "session or run /compact to reduce context, and avoid very large or tall images."
    return {
      status: 400,
      body: anthropicErrorBody("invalid_request_error", friendly),
    }
  }

  return { body: detail || `Kiro request failed (${status})`, status }
}
