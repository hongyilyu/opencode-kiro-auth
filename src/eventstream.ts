/**
 * Decoder for the AWS `application/vnd.amazon.eventstream` framing that Kiro (CodeWhisperer
 * streaming) returns. Each frame:
 *   [total_len u32][headers_len u32][prelude_crc u32][headers...][payload...][msg_crc u32]
 *
 * The decoder is total: it never throws and never spins. Wire lengths are validated before
 * every read, and framing corruption becomes a `fault` value the caller treats as terminal
 * (eventstream has no resync marker, so every byte after a bad prelude is garbage). CRCs are
 * deliberately not validated. The spec's three message types (`event`, `exception`, `error`)
 * all collapse into one KiroEvent shape. Only string-typed (7) header values are recorded;
 * the other spec types are skipped by their fixed or length-prefixed size.
 *
 * The TEST-ONLY frame encoder lives in test/support/eventstream-fixtures.ts, so this module
 * ships nothing that could produce non-conformant frames.
 */
export type KiroEvent = {
  eventType: string
  payload: Record<string, unknown>
}

/** Why the byte stream can no longer be framed. Terminal: every later byte is garbage. */
export type KiroFramingFault = {
  reason:
    | "frame-too-short"
    | "frame-too-long"
    | "headers-exceed-frame"
    | "header-overrun"
    | "unknown-header-type"
    | "truncated-frame"
  /** Byte offset of the frame whose prelude or header block lied. */
  offset: number
  totalLength: number
  headersLength: number
}

export type KiroFrameDrain = {
  /** Frames decoded before any fault, in order. */
  events: KiroEvent[]
  /** A partial frame awaiting more bytes, or empty after a fault. */
  rest: Buffer
  /** Present when framing broke at `offset`. */
  fault?: KiroFramingFault
}

/** Minimum frame: 12-byte prelude + 4-byte message CRC, no headers, no payload. */
const MIN_FRAME_LENGTH = 16
/** Spec maximum: 16 MiB payload + 128 KiB headers + prelude and CRC. A larger total_len is a lie. */
const MAX_FRAME_LENGTH = 16 * 1024 * 1024 + 128 * 1024 + MIN_FRAME_LENGTH
const PRELUDE_LENGTH = 12
const MESSAGE_CRC_LENGTH = 4
const STRING_HEADER = 7
const BYTE_ARRAY_HEADER = 6

/** Fixed value sizes per header type; 6 and 7 are u16-length-prefixed and handled inline. */
const FIXED_HEADER_VALUE_SIZE: Record<number, number> = {
  0: 0, // bool true
  1: 0, // bool false
  2: 1, // byte
  3: 2, // short
  4: 4, // int
  5: 8, // long
  8: 8, // timestamp
  9: 16, // uuid
}

const ERROR_MESSAGE_FALLBACK = "Kiro stream error"

type HeaderParse =
  | { headers: Record<string, string> }
  | { fault: "header-overrun" | "unknown-header-type" }

/** Walk one header block, bounds-checking every read against `end`. */
function parseHeaders(buf: Buffer, start: number, end: number): HeaderParse {
  const headers: Record<string, string> = {}
  let h = start
  const fits = (length: number) => h + length <= end
  while (h < end) {
    if (!fits(1)) return { fault: "header-overrun" }
    const nameLength = buf.readUInt8(h)
    h += 1
    if (!fits(nameLength + 1)) return { fault: "header-overrun" }
    const name = buf.toString("utf8", h, h + nameLength)
    h += nameLength
    const type = buf.readUInt8(h)
    h += 1

    if (type === STRING_HEADER || type === BYTE_ARRAY_HEADER) {
      if (!fits(2)) return { fault: "header-overrun" }
      const valueLength = buf.readUInt16BE(h)
      h += 2
      if (!fits(valueLength)) return { fault: "header-overrun" }
      if (type === STRING_HEADER) headers[name] = buf.toString("utf8", h, h + valueLength)
      h += valueLength
      continue
    }

    const size = FIXED_HEADER_VALUE_SIZE[type]
    if (size === undefined) return { fault: "unknown-header-type" }
    if (!fits(size)) return { fault: "header-overrun" }
    h += size
  }
  return { headers }
}

/**
 * Decode complete frames present in `buf`. A partial trailing frame is returned in `rest`
 * (not a fault: bytes may still arrive). A prelude whose lengths are self-inconsistent faults
 * as soon as the 12 prelude bytes are present, without waiting for the frame; a header block
 * that lies about its lengths faults once the frame is complete. Frames decoded before a fault
 * are still returned and `rest` is empty. The decoder cannot know when the stream is over, so a
 * stream that ENDS with bytes left in `rest` is reported by the caller via `truncatedFrameFault`.
 */
export function drainKiroEvents(buf: Buffer): KiroFrameDrain {
  const events: KiroEvent[] = []
  let off = 0
  const fault = (
    reason: KiroFramingFault["reason"],
    totalLength: number,
    headersLength: number,
  ): KiroFrameDrain => ({ events, rest: Buffer.alloc(0), fault: { reason, offset: off, totalLength, headersLength } })

  while (off + PRELUDE_LENGTH <= buf.length) {
    const total = buf.readUInt32BE(off)
    const headersLength = buf.readUInt32BE(off + 4)
    if (total < MIN_FRAME_LENGTH) return fault("frame-too-short", total, headersLength)
    if (total > MAX_FRAME_LENGTH) return fault("frame-too-long", total, headersLength)
    if (headersLength > total - MIN_FRAME_LENGTH) return fault("headers-exceed-frame", total, headersLength)
    if (off + total > buf.length) break

    const headersStart = off + PRELUDE_LENGTH
    const headersEnd = headersStart + headersLength
    const parsed = parseHeaders(buf, headersStart, headersEnd)
    if ("fault" in parsed) return fault(parsed.fault, total, headersLength)
    const headers = parsed.headers

    const raw = buf.toString("utf8", headersEnd, off + total - MESSAGE_CRC_LENGTH)
    let payload: Record<string, unknown> = {}
    if (raw.length > 0) {
      try {
        const value: unknown = JSON.parse(raw)
        payload = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { raw }
      } catch {
        payload = { raw }
      }
    }

    let eventType: string
    if (headers[":message-type"] === "error") {
      // Spec-level error frames carry their detail in headers and (usually) an empty body. Fold
      // them into the existing `error` event shape so parseKiroEvent's heuristics classify them.
      // The headers are authoritative; a body only fills in what the headers did not say.
      const code = headers[":error-code"]
      const message = headers[":error-message"]
      const bodyMessage = typeof payload.message === "string" ? payload.message : ""
      eventType = "error"
      payload = {
        ...payload,
        ...(code ? { errorCode: code } : {}),
        message: message || code || bodyMessage || ERROR_MESSAGE_FALLBACK,
      }
    } else {
      eventType = headers[":event-type"] ?? headers[":exception-type"] ?? "unknown"
    }

    events.push({ eventType, payload })
    off += total
  }
  return { events, rest: buf.subarray(off) }
}

/** The fault for a stream that ended with `rest` bytes still buffered: an unfinished frame. */
export function truncatedFrameFault(rest: Buffer): KiroFramingFault {
  return {
    reason: "truncated-frame",
    offset: 0,
    totalLength: rest.length >= 4 ? rest.readUInt32BE(0) : 0,
    headersLength: rest.length >= 8 ? rest.readUInt32BE(4) : 0,
  }
}
