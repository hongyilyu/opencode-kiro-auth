/**
 * Minimal decoder for the AWS `application/vnd.amazon.eventstream` framing that
 * Kiro (CodeWhisperer streaming) returns. Each frame:
 *   [total_len u32][headers_len u32][prelude_crc u32][headers...][payload...][msg_crc u32]
 * We only read string-typed headers (type 7), which is all Kiro uses.
 */
export type KiroEvent = {
  eventType: string
  payload: Record<string, unknown>
}

/**
 * Encode one Kiro event frame, mirroring the decoder below. TEST-ONLY: both CRC fields are
 * zeroed, so the output is NOT wire-conformant eventstream framing — any consumer that validates
 * CRCs will reject these frames. Never send them to Kiro. They exist for deterministic synthetic
 * streams in tests and work only because the decoder below deliberately ignores CRCs; if the
 * decoder ever starts validating them, every stream test fails here first.
 */
export function encodeKiroEvent(eventType: string, payload: unknown, headerName = ":event-type"): Buffer {
  const body = Buffer.from(JSON.stringify(payload))
  const name = Buffer.from(headerName)
  const value = Buffer.from(eventType)

  const valueLength = Buffer.alloc(2)
  valueLength.writeUInt16BE(value.length)
  const headers = Buffer.concat([
    Buffer.from([name.length]),
    name,
    Buffer.from([7]),
    valueLength,
    value,
  ])

  const total = 12 + headers.length + body.length + 4
  const frame = Buffer.alloc(total)
  let offset = 0
  frame.writeUInt32BE(total, offset)
  offset += 4
  frame.writeUInt32BE(headers.length, offset)
  offset += 4
  frame.writeUInt32BE(0, offset)
  offset += 4
  headers.copy(frame, offset)
  offset += headers.length
  body.copy(frame, offset)
  offset += body.length
  frame.writeUInt32BE(0, offset)
  return frame
}

function parseHeaders(buf: Buffer, start: number, end: number): Record<string, string> {
  const headers: Record<string, string> = {}
  let h = start
  while (h < end) {
    const nameLen = buf.readUInt8(h)
    h += 1
    const name = buf.toString("utf8", h, h + nameLen)
    h += nameLen
    const type = buf.readUInt8(h)
    h += 1
    // Kiro only emits string (7) headers. Bail defensively on anything else.
    if (type !== 7) break
    const valLen = buf.readUInt16BE(h)
    h += 2
    headers[name] = buf.toString("utf8", h, h + valLen)
    h += valLen
  }
  return headers
}

/** Decode complete frames present in `buf`; returns parsed events and any trailing bytes. */
export function drainKiroEvents(buf: Buffer): { events: KiroEvent[]; rest: Buffer } {
  const events: KiroEvent[] = []
  let off = 0
  while (off + 12 <= buf.length) {
    const total = buf.readUInt32BE(off)
    if (off + total > buf.length) break
    const headerLen = buf.readUInt32BE(off + 4)
    const headersEnd = off + 12 + headerLen
    const headers = parseHeaders(buf, off + 12, headersEnd)
    const raw = buf.toString("utf8", headersEnd, off + total - 4)
    const eventType = headers[":event-type"] ?? headers[":exception-type"] ?? "unknown"
    let payload: Record<string, unknown> = {}
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = { raw }
      }
    }
    events.push({ eventType, payload })
    off += total
  }
  return { events, rest: buf.subarray(off) }
}

/** Stream Kiro events from a fetch Response body as they arrive. */
export async function* readKiroEvents(res: Response): AsyncGenerator<KiroEvent> {
  if (!res.body) return
  const reader = res.body.getReader()
  let buf = Buffer.alloc(0)
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        complete = true
        break
      }
      buf = Buffer.concat([buf, Buffer.from(value)])
      const { events, rest } = drainKiroEvents(buf)
      buf = Buffer.from(rest)
      for (const event of events) yield event
    }
  } finally {
    // Consumers may stop after an error event; release the upstream body promptly.
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
