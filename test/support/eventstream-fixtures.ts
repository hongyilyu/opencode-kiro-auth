export { encodeKiroEvent } from "../../src/eventstream"

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
