import { drainKiroEvents, truncatedFrameFault, type KiroEvent, type KiroFramingFault } from "./eventstream"
import {
  EMPTY_TURN_ERROR_MESSAGE,
  beginsAssistantOutput,
  isContentFilteredStop,
  looksLikeTimeout,
  parseKiroEvent,
  resolveRetryAfter,
  type KiroStreamEvent,
  type MetadataEvent,
} from "./events"
import { AnthropicSseEncoder, serializeSse, type AnthropicSseEvent } from "./sse"
import {
  createKiroDebugContext,
  kiroDebug,
  kiroDebugError,
  redactKiroSecrets,
  type KiroDebugContext,
} from "./debug"

export type KiroResponseOptions = {
  model: string
  contextLimit: number
  debug?: KiroDebugContext
  /** The AI SDK's abort signal. A read that fails while it is aborted rethrows `signal.reason`. */
  signal?: AbortSignal
}

/* ---------------------------- error responses ------------------------------ */

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

/**
 * JSON headers plus retry-after. The only place the 429-only KIRO_RATE_LIMIT_RETRY_SECONDS
 * override lives; any other status forwards the upstream header verbatim.
 */
function retryAfterHeaders(
  status: number,
  upstreamHeader: string | null,
  event?: Extract<KiroStreamEvent, { kind: "rateLimit" }>,
): Headers {
  const headers = new Headers({ "content-type": "application/json" })
  const retryAfter =
    status === 429 ? resolveRetryAfter({ header: upstreamHeader, event }) : (upstreamHeader ?? undefined)
  if (retryAfter) headers.set("retry-after", retryAfter)
  return headers
}

function rateLimitResponse(res: Response, event: Extract<KiroStreamEvent, { kind: "rateLimit" }>): Response {
  return anthropicErrorResponse(
    429,
    "rate_limit_error",
    event.message,
    retryAfterHeaders(429, res.headers.get("retry-after"), event),
  )
}

/* ------------------------------ HTTP errors -------------------------------- */

/** One parse of Kiro's JSON error body, shared by the status mapping and the debug shape. */
type KiroErrorBody =
  | { parseable: false }
  | { parseable: true; keys: string[]; reason?: string; type?: string; message?: string }

function parseKiroErrorBody(redactedDetail: string): KiroErrorBody {
  try {
    const value: unknown = JSON.parse(redactedDetail)
    if (!value || typeof value !== "object" || Array.isArray(value)) return { parseable: false }
    const record = value as Record<string, unknown>
    return {
      parseable: true,
      keys: Object.keys(record).sort(),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
    }
  } catch {
    return { parseable: false }
  }
}

/**
 * Translate a Kiro error response into something opencode handles well.
 *
 * Kiro returns a 400 ValidationException ("Input content length exceeds threshold", reason
 * CONTENT_LENGTH_EXCEEDS_THRESHOLD) when the whole request (history + images) is too large.
 * opencode only recognizes a request as a context overflow, and then shows a clear "start a new
 * session or /compact" message, when the 400 message contains phrases like "prompt is too long".
 * So we reshape that specific case into an Anthropic-style error carrying that phrase; everything
 * else is passed through verbatim (already redacted).
 */
function mapKiroError(redactedDetail: string, status: number, body: KiroErrorBody): { body: string; status: number } {
  const tooLong =
    body.parseable &&
    (body.reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD" || /content length exceeds/i.test(body.message ?? ""))
  if (status === 400 && tooLong) {
    const friendly =
      "Prompt is too long: Kiro rejected the request because the total input " +
      "(conversation history plus images) exceeds its content-length limit. Start a new " +
      "session or run /compact to reduce context, and avoid very large or tall images."
    return { status: 400, body: anthropicErrorBody("invalid_request_error", friendly) }
  }
  return { body: redactedDetail || `Kiro request failed (${status})`, status }
}

/** Read once, redact once, parse once, map, log `response.http_error`, build the Response. */
async function kiroHttpErrorResponse(
  res: Response,
  signal: AbortSignal | undefined,
  debug: KiroDebugContext,
): Promise<Response> {
  const raw = await res.text().catch((error: unknown) => {
    // The caller aborted while the error body was still in flight: surface its reason.
    if (signal?.aborted) throw signal.reason ?? error
    return ""
  })
  const detail = redactKiroSecrets(raw)
  const body = parseKiroErrorBody(detail)
  const mapped = mapKiroError(detail, res.status, body)
  kiroDebug(debug, "response.http_error", {
    upstreamStatus: res.status,
    mappedStatus: mapped.status,
    bodyBytes: Buffer.byteLength(detail),
    error: body.parseable ? { ...body, message: body.message?.slice(0, 500) } : body,
  })
  return new Response(mapped.body, {
    status: mapped.status,
    headers: retryAfterHeaders(mapped.status, res.headers.get("retry-after")),
  })
}

/* ----------------------------- event source -------------------------------- */

/** Wraps a framing fault so it can ride the readError channel. The message never says "timeout". */
class KiroFramingError extends Error {
  constructor(readonly fault: KiroFramingFault) {
    super(
      `Kiro event stream framing is corrupt (${fault.reason}; total_len=${fault.totalLength}, ` +
        `headers_len=${fault.headersLength} at offset ${fault.offset}).`,
    )
    this.name = "KiroFramingError"
  }
}

type DecodedKiroEvent = { event: KiroEvent; parsed: KiroStreamEvent }

type KiroEventSourceRead =
  | { kind: "event"; entry: DecodedKiroEvent }
  | { kind: "eof" }
  /** The caller's abort signal fired; `reason` is what it aborted with. Sticky. */
  | { kind: "aborted"; reason: unknown }
  /** Transport rejection or framing fault (KiroFramingError). Sticky. */
  | { kind: "readError"; error: unknown }

type SourceStats = {
  chunks: number
  totalBytes: number
  eventCount: number
  eventTypes: Record<string, number>
  trailingBytes: number
}

type KiroEventSource = {
  next(): Promise<KiroEventSourceRead>
  cancel(reason?: unknown): Promise<void>
  release(): void
  stats(): SourceStats
}

type PreflightResult =
  | { kind: "stream"; buffered: DecodedKiroEvent[] }
  | { kind: "httpError"; response: Response }

/**
 * Owns the reader (D6): decodes each chunk exactly once, hands out interpreted events, and
 * classifies every failure once (caller abort, transport failure, framing fault). Once a failure
 * is returned it is returned forever and the body is never read again.
 */
function createKiroEventSource(
  body: NonNullable<Response["body"]>,
  debug: KiroDebugContext,
  signal: AbortSignal | undefined,
): KiroEventSource {
  const reader = body.getReader()
  const pending: KiroEvent[] = []
  const eventTypes: Record<string, number> = {}
  let buf = Buffer.alloc(0)
  let chunks = 0
  let totalBytes = 0
  let eventCount = 0
  let failure: Extract<KiroEventSourceRead, { kind: "aborted" | "readError" }> | undefined
  let cancellation: Promise<void> | undefined

  const cancel = (reason?: unknown): Promise<void> => {
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
  }

  /** A failed transport read: the caller's abort if its signal fired, otherwise a read error. */
  const fail = (error: unknown): KiroEventSourceRead => {
    failure = signal?.aborted ? { kind: "aborted", reason: signal.reason ?? error } : { kind: "readError", error }
    return failure
  }

  /**
   * The byte stream lied. Always a read error, even under abort: the bytes already arrived, so
   * the corruption is real and worth surfacing. Cancels upstream; every later byte is garbage.
   */
  const framingFailure = (fault: KiroFramingFault): KiroEventSourceRead => {
    const error = new KiroFramingError(fault)
    failure = { kind: "readError", error }
    void cancel(error)
    return failure
  }

  return {
    async next(): Promise<KiroEventSourceRead> {
      while (true) {
        const event = pending.shift()
        if (event) {
          eventCount += 1
          eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1
          if (debug.enabled) {
            kiroDebug(debug, "response.event", {
              sequence: eventCount,
              eventType: event.eventType,
              ...kiroEventShape(event),
            })
          }
          return { kind: "event", entry: { event, parsed: parseKiroEvent(event) } }
        }
        if (failure) return failure

        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (error) {
          return fail(error)
        }
        if (next.done) {
          if (buf.length === 0) return { kind: "eof" }
          // Closed inside a frame: a truncated turn must not complete as success (D3).
          return framingFailure(truncatedFrameFault(buf))
        }

        chunks += 1
        totalBytes += next.value.byteLength
        buf = Buffer.concat([buf, Buffer.from(next.value)])
        const { events, rest, fault } = drainKiroEvents(buf)
        buf = Buffer.from(rest)
        if (debug.enabled) {
          kiroDebug(debug, "response.chunk", {
            chunk: chunks,
            bytes: next.value.byteLength,
            totalBytes,
            decodedEvents: events.length,
            trailingBytes: buf.length,
            ...(fault ? { framingFault: fault } : {}),
          })
        }
        pending.push(...events)
        // Frames decoded before the fault are still delivered (pending drains first).
        if (fault) framingFailure(fault)
      }
    },

    cancel,

    release(): void {
      reader.releaseLock()
    },

    stats() {
      return { chunks, totalBytes, eventCount, eventTypes, trailingBytes: buf.length }
    },
  }
}

/* -------------------------------- preflight -------------------------------- */

async function preflightKiroEvents(
  res: Response,
  source: KiroEventSource,
  debug: KiroDebugContext,
  startedAt: number,
): Promise<PreflightResult> {
  const buffered: DecodedKiroEvent[] = []
  let terminalMetadata: MetadataEvent | undefined

  while (true) {
    const next = await source.next()
    if (next.kind === "aborted") throw next.reason

    if (next.kind === "readError") {
      const framing = next.error instanceof KiroFramingError ? next.error.fault : undefined
      const message = String(next.error)
      kiroDebug(debug, "response.read_error", {
        ...kiroDebugError(next.error),
        ...(framing ? { framingFault: framing } : {}),
        ...source.stats(),
        preflightMs: Date.now() - startedAt,
      })
      // Only an opaque transport failure is classified by its wording; our own framing error is
      // never a timeout.
      const status = !framing && looksLikeTimeout(message) ? 504 : 502
      return { kind: "httpError", response: anthropicErrorResponse(status, "api_error", redactKiroSecrets(message)) }
    }

    if (next.kind === "eof") {
      kiroDebug(debug, "response.empty_eof", { ...source.stats(), preflightMs: Date.now() - startedAt })
      return {
        kind: "httpError",
        response: isContentFilteredStop(terminalMetadata)
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
      return { kind: "httpError", response: rateLimitResponse(res, parsed) }
    }
    if (parsed.kind === "timeout") {
      await source.cancel()
      kiroDebug(debug, "response.timed_out", { eventType: event.eventType })
      return { kind: "httpError", response: anthropicErrorResponse(504, "api_error", parsed.message) }
    }
    if (parsed.kind === "streamError") {
      kiroDebug(debug, "response.error_passthrough", { eventType: event.eventType })
      return { kind: "stream", buffered }
    }
    if (!beginsAssistantOutput(parsed)) continue

    kiroDebug(debug, "response.output_detected", {
      eventType: event.eventType,
      ...source.stats(),
      preflightMs: Date.now() - startedAt,
    })
    return { kind: "stream", buffered }
  }
}

/* --------------------------------- stream ---------------------------------- */

function anthropicStreamResponse(
  source: KiroEventSource,
  buffered: DecodedKiroEvent[],
  opts: KiroResponseOptions,
  debug: KiroDebugContext,
): Response {
  const textEncoder = new TextEncoder()
  const encoder = new AnthropicSseEncoder({ model: opts.model, contextLimit: opts.contextLimit })
  let outputCancelled = false

  const pump = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    const send = (events: AnthropicSseEvent[]): void => {
      for (const event of events) controller.enqueue(textEncoder.encode(serializeSse(event)))
    }
    const snapshot = () => ({ ...source.stats(), ...encoder.debugState() })
    let sequence = 0
    /** Feed one event to the encoder; true when the encoder emitted its terminal error. */
    const sendEvent = (entry: DecodedKiroEvent): boolean => {
      sequence += 1
      if (debug.enabled) {
        kiroDebug(debug, "sse.event", { sequence, eventType: entry.event.eventType, ...kiroEventShape(entry.event) })
      }
      send(encoder.onEvent(entry.parsed))
      if (!encoder.terminated) return false

      kiroDebug(debug, "sse.error", {
        name: entry.parsed.kind,
        message: "message" in entry.parsed ? entry.parsed.message : undefined,
        ...snapshot(),
      })
      return true
    }
    /** The preflight prefix, then the live source: one sequence with one terminal path. */
    async function* reads(): AsyncGenerator<KiroEventSourceRead> {
      for (const entry of buffered) yield { kind: "event", entry }
      while (true) yield await source.next()
    }

    try {
      send(encoder.begin())
      kiroDebug(debug, "sse.start", { model: opts.model, contextLimit: opts.contextLimit })

      for await (const next of reads()) {
        if (outputCancelled) return
        if (next.kind === "aborted") {
          // The caller is gone; mirror a native fetch body and error the stream with its reason.
          kiroDebug(debug, "sse.aborted", snapshot())
          controller.error(next.reason)
          void source.cancel(next.reason)
          return
        }
        if (next.kind === "readError") throw next.error
        if (next.kind === "eof") {
          send(encoder.onEof())
          kiroDebug(debug, encoder.terminated ? "sse.empty_eof" : "sse.complete", snapshot())
          return
        }
        if (sendEvent(next.entry)) {
          void source.cancel()
          return
        }
      }
    } catch (error) {
      if (outputCancelled) return
      const failureEvents = encoder.onEvent({ kind: "streamError", message: String(error) })
      kiroDebug(debug, "sse.error", { ...kiroDebugError(error), ...snapshot() })
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
        // A cancelled or errored output stream is already closed.
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

/* --------------------------------- the seam -------------------------------- */

/**
 * The one seam between an upstream Kiro Response and what opencode consumes (D6):
 * a non-2xx status becomes a mapped Anthropic error; a 200 whose event stream fails before any
 * output becomes a clean HTTP error; anything else becomes an Anthropic SSE stream.
 */
export async function kiroResponseToAnthropic(res: Response, opts: KiroResponseOptions): Promise<Response> {
  const debug = opts.debug ?? createKiroDebugContext()
  if (!res.ok) return kiroHttpErrorResponse(res, opts.signal, debug)

  const preflightStartedAt = Date.now()
  kiroDebug(debug, "response.preflight_start", { status: res.status, hasBody: Boolean(res.body) })
  const body = res.body
  if (!body) {
    kiroDebug(debug, "response.body_missing", { status: res.status })
    const response = anthropicErrorResponse(502, "api_error", "Kiro returned a response without an event stream.")
    kiroDebug(debug, "response.preflight_error", { status: response.status })
    return response
  }

  const source = createKiroEventSource(body, debug, opts.signal)
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
  return anthropicStreamResponse(source, preflight.buffered, opts, debug)
}

function contentFilteredMessage(metadata: MetadataEvent): string {
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
