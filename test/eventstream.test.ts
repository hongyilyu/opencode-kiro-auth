import { describe, expect, it } from "bun:test"
import { drainKiroEvents } from "../src/eventstream"
import { bool, bytes, encodeKiroEvent, encodeKiroFrame, fixed, str } from "./support/eventstream-fixtures"

/**
 * Frame layout produced by `encodeKiroFrame([str(":event-type", ...)], ...)`:
 *   0..3 total_len, 4..7 headers_len, 8..11 prelude crc,
 *   12 name length (11), 13..23 ":event-type", 24 header type (7), 25..26 value length, 27.. value
 */
const HEADER_NAME_LENGTH_OFFSET = 12
const HEADER_TYPE_OFFSET = 24
const HEADER_VALUE_LENGTH_OFFSET = 25

/** Copy a frame and let the caller corrupt specific bytes. */
function corrupted(frame: Buffer, mutate: (copy: Buffer) => void): Buffer {
  const copy = Buffer.from(frame)
  mutate(copy)
  return copy
}

const textFrame = (content: string) => encodeKiroEvent("assistantResponseEvent", { content })

/** Just the 12 prelude prelude of a frame that claims the given lengths; no headers or body follow. */
function prelude(totalLength: number, headersLength: number): Buffer {
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(totalLength, 0)
  prelude.writeUInt32BE(headersLength, 4)
  return prelude
}

describe("drainKiroEvents framing", () => {
  it("decodes complete frames in order and keeps a partial trailing frame without a fault", () => {
    const first = textFrame("one")
    const second = textFrame("two")
    const partial = textFrame("three").subarray(0, 20)
    const drained = drainKiroEvents(Buffer.concat([first, second, partial]))

    expect(drained.events.map((event) => event.payload.content)).toEqual(["one", "two"])
    expect(drained.rest.equals(partial)).toBe(true)
    expect(drained.fault).toBeUndefined()
  })

  it("keeps a buffer shorter than a prelude in rest", () => {
    const drained = drainKiroEvents(Buffer.from([0, 0, 0, 40, 0, 0]))
    expect(drained.events).toEqual([])
    expect(drained.rest).toHaveLength(6)
    expect(drained.fault).toBeUndefined()
  })

  it(
    "a prelude shorter than the minimum frame is a fault instead of a spin",
    () => {
      for (const total of [0, 8, 15]) {
        const frame = corrupted(textFrame("x"), (copy) => copy.writeUInt32BE(total, 0))
        const drained = drainKiroEvents(frame)
        expect(drained.fault?.reason).toBe("frame-too-short")
        expect(drained.fault?.totalLength).toBe(total)
        expect(drained.events).toEqual([])
        expect(drained.rest).toHaveLength(0)
      }
    },
    1_000,
  )

  it("an impossible headers_len faults before the frame is complete", () => {
    // Only the 12 prelude bytes are present; a headers_len that cannot fit in total_len is a
    // lie no further bytes can repair, so the decoder does not wait for the rest of the frame.
    const drained = drainKiroEvents(prelude(1000, 999))

    expect(drained.fault).toEqual({ reason: "headers-exceed-frame", offset: 0, totalLength: 1000, headersLength: 999 })
    expect(drained.events).toEqual([])
    expect(drained.rest).toHaveLength(0)
  })

  it("a total_len above the spec maximum is a fault", () => {
    const drained = drainKiroEvents(prelude(0x7fffffff, 0))

    expect(drained.fault?.reason).toBe("frame-too-long")
    expect(drained.fault?.totalLength).toBe(0x7fffffff)
    expect(drained.events).toEqual([])
    expect(drained.rest).toHaveLength(0)
  })

  it("a header block larger than the frame is a fault", () => {
    const frame = corrupted(textFrame("x"), (copy) => copy.writeUInt32BE(0xffff, 4))
    const drained = drainKiroEvents(frame)

    expect(drained.fault).toEqual({
      reason: "headers-exceed-frame",
      offset: 0,
      totalLength: frame.length,
      headersLength: 0xffff,
    })
    expect(drained.events).toEqual([])
    expect(drained.rest).toHaveLength(0)
  })

  it("a header block that exactly fills a bodyless frame decodes to an empty payload", () => {
    const frame = encodeKiroFrame([str(":event-type", "ping")])
    expect(frame.readUInt32BE(4)).toBe(frame.length - 16)

    const drained = drainKiroEvents(frame)
    expect(drained.events).toEqual([{ eventType: "ping", payload: {} }])
    expect(drained.fault).toBeUndefined()
  })

  it("a header name that runs past the header block is a fault", () => {
    const frame = corrupted(textFrame("x"), (copy) => copy.writeUInt8(200, HEADER_NAME_LENGTH_OFFSET))
    const drained = drainKiroEvents(frame)

    expect(drained.fault?.reason).toBe("header-overrun")
    expect(drained.events).toEqual([])
    expect(drained.rest).toHaveLength(0)
  })

  it("a string header value that runs past the header block is a fault", () => {
    const frame = corrupted(textFrame("x"), (copy) => copy.writeUInt16BE(0xffff, HEADER_VALUE_LENGTH_OFFSET))
    const drained = drainKiroEvents(frame)

    expect(drained.fault?.reason).toBe("header-overrun")
    expect(drained.events).toEqual([])
  })

  it("a header type above the spec range is a fault", () => {
    for (const type of [10, 127, 255]) {
      const frame = corrupted(textFrame("x"), (copy) => copy.writeUInt8(type, HEADER_TYPE_OFFSET))
      const drained = drainKiroEvents(frame)
      expect(drained.fault?.reason).toBe("unknown-header-type")
      expect(drained.events).toEqual([])
    }
  })

  it("delivers the frames decoded before a fault and discards everything after it", () => {
    const good = textFrame("before")
    const bad = corrupted(textFrame("broken"), (copy) => copy.writeUInt32BE(0xffff, 4))
    const drained = drainKiroEvents(Buffer.concat([good, bad, textFrame("after")]))

    expect(drained.events.map((event) => event.payload.content)).toEqual(["before"])
    expect(drained.fault?.reason).toBe("headers-exceed-frame")
    expect(drained.fault?.offset).toBe(good.length)
    expect(drained.rest).toHaveLength(0)
  })
})

describe("drainKiroEvents headers", () => {
  it("skips every non-string header type by its spec size", () => {
    const frame = encodeKiroFrame(
      [
        bool("flag-on", true),
        bool("flag-off", false),
        fixed("byte", 2, Buffer.alloc(1, 0xff)),
        fixed("short", 3, Buffer.alloc(2, 0xff)),
        fixed("int", 4, Buffer.alloc(4, 0xff)),
        fixed("long", 5, Buffer.alloc(8, 0xff)),
        bytes("blob", Buffer.from("opaque bytes")),
        str(":event-type", "assistantResponseEvent"),
        fixed("timestamp", 8, Buffer.alloc(8, 0xff)),
        fixed("uuid", 9, Buffer.alloc(16, 0xff)),
      ],
      { content: "typed headers" },
    )
    const drained = drainKiroEvents(frame)

    expect(drained.fault).toBeUndefined()
    expect(drained.events).toEqual([{ eventType: "assistantResponseEvent", payload: { content: "typed headers" } }])
  })

  it("records only string header values", () => {
    const byteArrayOnly = encodeKiroFrame([bytes(":event-type", Buffer.from("assistantResponseEvent"))], { content: "x" })
    expect(drainKiroEvents(byteArrayOnly).events[0]?.eventType).toBe("unknown")

    const both = encodeKiroFrame(
      [bytes(":event-type", Buffer.from("wrong")), str(":event-type", "right")],
      { content: "x" },
    )
    expect(drainKiroEvents(both).events[0]?.eventType).toBe("right")
  })
})

describe("drainKiroEvents error frames", () => {
  it("folds a :message-type error frame into an error event carrying the header detail", () => {
    const frame = encodeKiroFrame([
      str(":message-type", "error"),
      str(":error-code", "InternalServerException"),
      str(":error-message", "provider failed"),
    ])
    const drained = drainKiroEvents(frame)

    expect(drained.events).toEqual([
      { eventType: "error", payload: { errorCode: "InternalServerException", message: "provider failed" } },
    ])
  })

  it("an error frame without a message falls back to its code, then to a generic message", () => {
    const codeOnly = encodeKiroFrame([str(":message-type", "error"), str(":error-code", "ThrottlingException")])
    expect(drainKiroEvents(codeOnly).events[0]?.payload).toEqual({
      errorCode: "ThrottlingException",
      message: "ThrottlingException",
    })

    const bare = encodeKiroFrame([str(":message-type", "error")])
    expect(drainKiroEvents(bare).events[0]).toEqual({ eventType: "error", payload: { message: "Kiro stream error" } })
  })

  it("merges an error frame's JSON body into the payload", () => {
    const frame = encodeKiroFrame(
      [str(":message-type", "error"), str(":error-code", "ValidationException"), str(":error-message", "bad input")],
      { reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" },
    )
    expect(drainKiroEvents(frame).events[0]?.payload).toEqual({
      errorCode: "ValidationException",
      message: "bad input",
      reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
    })
  })

  it("header :error-code and :error-message win over conflicting body keys", () => {
    const frame = encodeKiroFrame(
      [str(":message-type", "error"), str(":error-code", "ThrottlingException"), str(":error-message", "slow down")],
      { message: "", errorCode: "Other" },
    )
    const payload = drainKiroEvents(frame).events[0]?.payload

    expect(payload?.errorCode).toBe("ThrottlingException")
    expect(payload?.message).toBe("slow down")
  })

  it("a body-only message survives when the error frame has no detail headers", () => {
    const frame = encodeKiroFrame([str(":message-type", "error")], { message: "from the body" })

    expect(drainKiroEvents(frame).events[0]).toEqual({
      eventType: "error",
      payload: { message: "from the body" },
    })
  })

  it("a :message-type error wins over an :event-type header on the same frame", () => {
    const frame = encodeKiroFrame([
      str(":message-type", "error"),
      str(":event-type", "assistantResponseEvent"),
      str(":error-message", "not text"),
    ])
    expect(drainKiroEvents(frame).events[0]?.eventType).toBe("error")
  })

  it("ordinary :message-type event frames still decode by :event-type", () => {
    const frame = encodeKiroFrame(
      [str(":message-type", "event"), str(":event-type", "assistantResponseEvent"), str(":content-type", "application/json")],
      { content: "hello" },
    )
    expect(drainKiroEvents(frame).events).toEqual([
      { eventType: "assistantResponseEvent", payload: { content: "hello" } },
    ])
  })
})

describe("drainKiroEvents payloads", () => {
  it("wraps non-object and unparseable JSON bodies as raw", () => {
    const cases: Array<[unknown, string]> = [
      [[1, 2], "[1,2]"],
      ["text", '"text"'],
      [42, "42"],
      [null, "null"],
    ]
    for (const [body, raw] of cases) {
      const drained = drainKiroEvents(encodeKiroEvent("assistantResponseEvent", body))
      expect(drained.events[0]?.payload).toEqual({ raw })
    }

    const invalid = encodeKiroFrame([str(":event-type", "assistantResponseEvent")])
    const withGarbage = Buffer.concat([invalid.subarray(0, invalid.length - 4), Buffer.from("{not json"), Buffer.alloc(4)])
    withGarbage.writeUInt32BE(withGarbage.length, 0)
    expect(drainKiroEvents(withGarbage).events[0]?.payload).toEqual({ raw: "{not json" })
  })
})
