/**
 * TEST-ONLY eventstream frame builders. Both CRC fields are zeroed, so the output is NOT
 * wire-conformant framing: any consumer that validates CRCs rejects these frames. Never send them
 * to Kiro. They exist for deterministic synthetic streams and work only because the production
 * decoder deliberately ignores CRCs; if the decoder ever starts validating them, every stream
 * test fails here first.
 */

/** One eventstream header: a spec type byte plus its encoded value bytes (length prefix included). */
export type WireHeader = { name: string; type: number; value: Buffer }

/** String header (type 7). */
export const str = (name: string, value: string): WireHeader => {
  const bytes = Buffer.from(value)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(bytes.length)
  return { name, type: 7, value: Buffer.concat([length, bytes]) }
}

/** Boolean header (types 0 and 1 carry no value bytes). */
export const bool = (name: string, value: boolean): WireHeader => ({
  name,
  type: value ? 0 : 1,
  value: Buffer.alloc(0),
})

/** Fixed-size header (byte, short, int, long, timestamp, uuid); `bytes` must already be the spec size. */
export const fixed = (name: string, type: 2 | 3 | 4 | 5 | 8 | 9, bytes: Buffer): WireHeader => ({
  name,
  type,
  value: bytes,
})

/** Byte-array header (type 6, u16 length prefix). */
export const bytes = (name: string, value: Buffer): WireHeader => {
  const length = Buffer.alloc(2)
  length.writeUInt16BE(value.length)
  return { name, type: 6, value: Buffer.concat([length, value]) }
}

/** Encode one frame from typed headers and an optional JSON payload (omitted -> empty body). */
export function encodeKiroFrame(headers: WireHeader[], payload?: unknown): Buffer {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload))
  const headerBlock = Buffer.concat(
    headers.map((header) => {
      const name = Buffer.from(header.name)
      return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([header.type]), header.value])
    }),
  )

  const total = 12 + headerBlock.length + body.length + 4
  const frame = Buffer.alloc(total)
  frame.writeUInt32BE(total, 0)
  frame.writeUInt32BE(headerBlock.length, 4)
  frame.writeUInt32BE(0, 8)
  headerBlock.copy(frame, 12)
  body.copy(frame, 12 + headerBlock.length)
  frame.writeUInt32BE(0, total - 4)
  return frame
}

/** Encode one Kiro event frame with a single string header naming the event (or exception) type. */
export function encodeKiroEvent(eventType: string, payload: unknown, headerName = ":event-type"): Buffer {
  return encodeKiroFrame([str(headerName, eventType)], payload)
}

/** Wrap raw event-stream chunks in a Response whose body enqueues each chunk separately. */
export function chunkedResponse(...chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  )
}
