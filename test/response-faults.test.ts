import { describe, expect, it } from "bun:test"
import { encodeKiroEvent } from "./support/eventstream-fixtures"
import {
  convert,
  errorBody,
  expectEventStream,
  expectTerminalError,
  parseSse,
  preflight,
  readUntil,
  steppedResponse,
} from "./support/response-fixtures"

// eventstream has no resync marker: a lying prelude makes every later byte garbage, so the
// driver delivers what decoded, then fails for good on the same channel as a transport error.
describe("framing faults", () => {
  const corruptFrame = () => {
    const frame = encodeKiroEvent("assistantResponseEvent", { content: "garbage" })
    frame.writeUInt32BE(0xffff, 4)
    return frame
  }

  it("a pre-output framing fault is a 502, never a timeout", async () => {
    const upstream = steppedResponse([
      Buffer.concat([encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }), corruptFrame()]),
      encodeKiroEvent("assistantResponseEvent", { content: "never read" }),
      "eof",
    ])
    const res = await convert(upstream.response)

    expect(res.status).toBe(502)
    const body = await errorBody(res)
    expect(body.error?.type).toBe("api_error")
    expect(body.error?.message).toMatch(/framing/i)
    expect(body.error?.message).not.toMatch(/timeout|timed out/i)
    expect(upstream.stats()).toMatchObject({ reads: 1, cancels: 1, releases: 1, remainingSteps: 2 })
  })

  it("frames decoded before a pre-output fault still drive the verdict", async () => {
    const throttled = encodeKiroEvent("ThrottlingException", { message: "Rate exceeded" }, ":exception-type")
    const res = await preflight(Buffer.concat([throttled, corruptFrame()]))

    expect(res.status).toBe(429)
    expect((await errorBody(res)).error?.type).toBe("rate_limit_error")
  })

  it("stops reading after a framing fault", async () => {
    const upstream = steppedResponse([
      Buffer.concat([encodeKiroEvent("assistantResponseEvent", { content: "before" }), corruptFrame()]),
      encodeKiroEvent("assistantResponseEvent", { content: "after" }),
      "eof",
    ])
    const response = await convert(upstream.response)
    const frames = parseSse(await response.text())

    expectEventStream(response)
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ])
    expect(frames.some((frame) => frame.data.delta?.text === "after")).toBe(false)
    const message: string = frames.at(-1)?.data.error.message
    expect(message).toMatch(/framing/i)
    expect(message).not.toMatch(/timeout|timed out/i)
    expectTerminalError(frames)

    const stats = upstream.stats()
    expect(stats).toMatchObject({ reads: 1, cancels: 1, releases: 1, remainingSteps: 2 })
    expect(String(stats.cancelReason)).toMatch(/framing/i)
  })

  // Kiro closing the socket inside a frame is not a completed turn (D3): the bytes that never
  // arrived may have been the tool stop or the rest of the text.
  it("a stream that ends inside a frame after output is a terminal error, not a completed turn", async () => {
    const secondFrame = encodeKiroEvent("assistantResponseEvent", { content: "never finished" })
    const response = await preflight(
      encodeKiroEvent("assistantResponseEvent", { content: "before" }),
      secondFrame.subarray(0, 20),
    )
    const frames = parseSse(await response.text())

    expectEventStream(response)
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ])
    expect(frames.some((frame) => frame.data.delta?.text === "never finished")).toBe(false)
    const message: string = frames.at(-1)?.data.error.message
    expect(message).toMatch(/truncated-frame|framing/i)
    expect(message).not.toMatch(/timeout|timed out/i)
    expectTerminalError(frames)
  })

  it("a stream that ends inside a frame before output is a 502", async () => {
    const frame = encodeKiroEvent("assistantResponseEvent", { content: "never finished" })
    const res = await preflight(frame.subarray(0, 20))

    expect(res.status).toBe(502)
    const body = await errorBody(res)
    expect(body.error?.type).toBe("api_error")
    expect(body.error?.message).toMatch(/framing/i)
    expect(body.error?.message).not.toMatch(/timeout|timed out/i)
  })

  // A prelude claiming a 2 GiB frame is a lie the decoder can reject from the 12 prelude bytes
  // alone. Waiting for the frame to "complete" would silently swallow every later event.
  it("a lying prelude cannot swallow the rest of the stream", async () => {
    const lyingPrelude = Buffer.alloc(12)
    lyingPrelude.writeUInt32BE(0x7fffffff, 0)
    lyingPrelude.writeUInt32BE(0xffffffff, 4)
    const response = await preflight(
      encodeKiroEvent("assistantResponseEvent", { content: "first half" }),
      lyingPrelude,
      encodeKiroEvent("assistantResponseEvent", { content: " second half" }),
      encodeKiroEvent("toolUseEvent", { toolUseId: "swallowed", name: "bash", input: '{"command":"ls"}', stop: true }),
    )
    const sse = await response.text()
    const frames = parseSse(sse)

    expectEventStream(response)
    expect(sse).toContain('"text":"first half"')
    expect(sse).not.toContain("second half")
    expect(sse).not.toContain('"type":"tool_use"')
    expect(frames.at(-1)?.data.error.message).toMatch(/framing/i)
    expectTerminalError(frames)
  })
})

// The AI SDK's abort is the caller leaving, not an upstream failure: never map it to 502/504.
describe("caller aborts", () => {
  it(
    "an abort during preflight rejects with the signal's reason",
    async () => {
      const controller = new AbortController()
      const reason = new Error("user cancelled")
      const upstream = steppedResponse(["wait"], { signal: controller.signal })
      const pending = convert(upstream.response, { signal: controller.signal })
      controller.abort(reason)

      await expect(pending).rejects.toBe(reason)
      await upstream.released
      expect(upstream.stats()).toMatchObject({ reads: 1, cancels: 1, releases: 1 })
    },
    1_000,
  )

  it(
    "a read that fails under an already-aborted signal rejects with its reason",
    async () => {
      const controller = new AbortController()
      controller.abort(new DOMException("The user aborted a request.", "AbortError"))
      const upstream = steppedResponse(["wait"], { signal: controller.signal })

      await expect(convert(upstream.response, { signal: controller.signal })).rejects.toBe(controller.signal.reason)
      await upstream.released
      expect(upstream.stats()).toMatchObject({ reads: 1, cancels: 1, releases: 1 })
    },
    1_000,
  )

  it(
    "an abort mid-stream errors the SSE body without manufacturing an error frame",
    async () => {
      const controller = new AbortController()
      const reason = new Error("user cancelled")
      const upstream = steppedResponse(
        [encodeKiroEvent("assistantResponseEvent", { content: "before" }), "wait"],
        { signal: controller.signal },
      )
      const response = await convert(upstream.response, { signal: controller.signal })
      const reader = response.body!.getReader()
      const sse = await readUntil(reader, '"text":"before"')

      controller.abort(reason)
      await expect(reader.read()).rejects.toBe(reason)
      await upstream.released

      expect(sse).not.toContain("event: error")
      expect(sse).not.toContain("message_stop")
      expect(upstream.stats()).toMatchObject({ reads: 2, releases: 1, remainingSteps: 0 })
    },
    1_000,
  )

  // The error body of a non-2xx upstream response is read behind the same seam; the caller
  // leaving mid-read is still the caller leaving, not a synthetic "Kiro request failed".
  it(
    "an abort while reading a non-2xx body rejects with the signal's reason",
    async () => {
      const controller = new AbortController()
      const reason = new Error("user cancelled")
      const neverEndingBody = new ReadableStream<Uint8Array>({
        pull() {
          // A fetch body rejects its pending read with the signal's reason once the request aborts.
          return new Promise<void>((_, reject) => {
            if (controller.signal.aborted) return reject(controller.signal.reason)
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
          })
        },
      })
      const pending = convert(new Response(neverEndingBody, { status: 503 }), { signal: controller.signal })
      controller.abort(reason)

      await expect(pending).rejects.toBe(reason)
    },
    1_000,
  )
})
