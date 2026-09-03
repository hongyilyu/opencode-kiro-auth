import { expect } from "bun:test"
import { kiroResponseToAnthropic, type KiroResponseOptions } from "../../src/response"
import { chunkedResponse } from "./eventstream-fixtures"

/**
 * Harness for driving `kiroResponseToAnthropic` with synthetic Kiro streams: converters over a
 * frame list, an SSE parser, the shared shape assertions, and a step-scripted upstream body for
 * exercising read/cancel/abort ordering.
 */

/** Run one upstream Response through the response seam with the default model and context limit. */
export function convert(response: Response, overrides: Partial<KiroResponseOptions> = {}): Promise<Response> {
  return kiroResponseToAnthropic(response, { model: "claude-sonnet-4.6", contextLimit: 1_000_000, ...overrides })
}

/** Convert a synthetic Kiro event stream built from the given frames. */
export function preflight(...frames: Uint8Array[]): Promise<Response> {
  return convert(chunkedResponse(...frames))
}

/** Convert synthetic Kiro frames to the Anthropic SSE text a client would receive. */
export async function streamedSse(model: string, ...frames: Uint8Array[]): Promise<string> {
  const response = await convert(chunkedResponse(...frames), { model })
  return response.text()
}

export async function errorBody(res: Response): Promise<{ error?: { type?: string; message?: string } }> {
  return (await res.json()) as { error?: { type?: string; message?: string } }
}

export type ParsedSseFrame = { event: string; data: Record<string, any> }

export function parseSse(value: string): ParsedSseFrame[] {
  return value
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n")
      return {
        event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "",
        data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}"),
      }
    })
}

export function expectEventStream(response: Response): void {
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/event-stream")
}

export function expectTerminalError(frames: ParsedSseFrame[]): void {
  expect(frames.filter((frame) => frame.event === "error")).toHaveLength(1)
  expect(frames.some((frame) => frame.data.type === "message_stop")).toBe(false)
}

/** Read SSE chunks until the decoded text contains `marker`; a premature EOF is a failure. */
export async function readUntil(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes(marker)) {
    const next = await reader.read()
    if (next.done) throw new Error(`SSE body ended before ${marker} arrived`)
    text += decoder.decode(next.value, { stream: true })
  }
  return text
}

/**
 * One scripted upstream read: a chunk is delivered, an Error is thrown, "wait" parks the read until
 * cancel (or abort), "wait-error" parks it until cancel rejects it, and "eof" ends the stream.
 */
export type ReaderStep = Uint8Array | Error | "wait" | "wait-error" | "eof"

/**
 * A 200 eventstream Response whose body reader replays `steps` one read at a time (past the last
 * step every read is "eof") and counts reads, cancels, and lock releases. With `options.signal` the
 * reader is wired the way a fetch body is: once the signal aborts, a pending "wait" read rejects
 * with `signal.reason`, and every later read rejects too.
 */
export function steppedResponse(steps: ReaderStep[], options: { signal?: AbortSignal } = {}) {
  const queue = [...steps]
  const signal = options.signal
  let reads = 0
  let cancels = 0
  let releases = 0
  let cancelReason: unknown
  let finishPendingRead: (() => void) | undefined
  let failPendingRead: (() => void) | undefined
  let abortPendingRead: ((reason: unknown) => void) | undefined
  let cancelWait: Promise<void> | undefined
  let resolveReleased!: () => void
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve
  })
  const clearPendingRead = () => {
    finishPendingRead = undefined
    failPendingRead = undefined
    abortPendingRead = undefined
  }

  signal?.addEventListener(
    "abort",
    () => {
      const abort = abortPendingRead
      clearPendingRead()
      abort?.(signal.reason)
    },
    { once: true },
  )

  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      reads += 1
      if (signal?.aborted) throw signal.reason
      const step = queue.shift() ?? "eof"
      if (step instanceof Error) throw step
      if (step === "wait" || step === "wait-error") {
        return new Promise((resolve, reject) => {
          finishPendingRead = () => resolve({ done: true })
          abortPendingRead = reject
          if (step === "wait-error") failPendingRead = () => reject(new Error("read aborted"))
        })
      }
      if (step === "eof") return { done: true }
      return { done: false, value: step }
    },
    async cancel(reason?: unknown): Promise<void> {
      cancels += 1
      cancelReason = reason
      if (failPendingRead) failPendingRead()
      else finishPendingRead?.()
      clearPendingRead()
      await cancelWait
    },
    releaseLock(): void {
      releases += 1
      resolveReleased()
    },
  }

  return {
    response: {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/vnd.amazon.eventstream" }),
      body: { getReader: () => reader },
    } as unknown as Response,
    stats: () => ({ reads, cancels, releases, cancelReason, remainingSteps: queue.length }),
    released,
    holdCancellation: () => {
      cancelWait = new Promise(() => {})
    },
  }
}
