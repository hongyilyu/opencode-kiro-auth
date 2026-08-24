/**
 * Test-side encoder for the AWS `application/vnd.amazon.eventstream` framing.
 *
 * This is the documented inverse of src/eventstream.ts's decoder and is kept adjacent to the
 * tests so encode/decode drift stays visible: each frame is
 *   [total_len u32][headers_len u32][prelude_crc u32][headers...][payload...][msg_crc u32]
 * with a single string-typed (type 7) header carrying the event type.
 *
 * NOTE: both CRC fields are written as zero. The production decoder deliberately ignores CRCs
 * (it only reads the length prelude and headers), and these fixtures silently rely on that.
 * If the decoder ever starts validating CRCs, every stream test will fail here first.
 */
export function encodeKiroEvent(eventType: string, payload: unknown, headerName = ":event-type"): Buffer {
  const body = Buffer.from(JSON.stringify(payload))
  const name = Buffer.from(headerName)
  const value = Buffer.from(eventType)

  const valueLength = Buffer.alloc(2)
  valueLength.writeUInt16BE(value.length)
  // [name_len u8][name][header_type u8 = 7 (string)][value_len u16][value]
  const headers = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), valueLength, value])

  const total = 12 + headers.length + body.length + 4
  const frame = Buffer.alloc(total)
  let offset = 0
  frame.writeUInt32BE(total, offset)
  offset += 4
  frame.writeUInt32BE(headers.length, offset)
  offset += 4
  frame.writeUInt32BE(0, offset) // prelude CRC, zeroed (see note above)
  offset += 4
  headers.copy(frame, offset)
  offset += headers.length
  body.copy(frame, offset)
  offset += body.length
  frame.writeUInt32BE(0, offset) // message CRC, zeroed (see note above)
  return frame
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
