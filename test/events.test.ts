import { describe, expect, it } from "bun:test"
import {
  KTR_MARKER,
  beginsAssistantOutput,
  completesAssistantTurn,
  parseKiroEvent,
  resolveRetryAfter,
  type KiroStreamEvent,
} from "../src/events"
import type { KiroEvent } from "../src/eventstream"
import { isolateEnv } from "./support/isolation"

const wireEvent = (eventType: string, payload: Record<string, unknown>): KiroEvent => ({
  eventType,
  payload,
})

describe("parseKiroEvent", () => {
  it("parses text, reasoning, context usage, and metadata", () => {
    expect(parseKiroEvent(wireEvent("assistantResponseEvent", { content: "hello" }))).toEqual({
      kind: "text",
      content: "hello",
    })
    expect(parseKiroEvent(wireEvent("reasoningContentEvent", { text: "working" }))).toEqual({
      kind: "reasoning",
      text: "working",
    })
    expect(parseKiroEvent(wireEvent("reasoningContentEvent", { signature: "sig_plain" }))).toEqual({
      kind: "reasoning",
      signature: "sig_plain",
    })
    expect(
      parseKiroEvent(wireEvent("contextUsageEvent", { contextUsagePercentage: 12.5 })),
    ).toEqual({ kind: "contextUsage", percent: 12.5 })
    expect(
      parseKiroEvent(
        wireEvent("metadataEvent", {
          stopReason: "CONTENT_FILTERED",
          stopDetails: {
            refusal: { category: "POLICY", explanation: "Not available." },
          },
        }),
      ),
    ).toEqual({
      kind: "metadata",
      stopReason: "CONTENT_FILTERED",
      refusal: { category: "POLICY", explanation: "Not available." },
    })
    expect(parseKiroEvent(wireEvent("metadataEvent", { stopReason: "END_TURN" }))).toEqual({
      kind: "metadata",
      stopReason: "END_TURN",
    })
  })

  it("accepts only redacted reasoning with a KTR envelope", () => {
    const signature = `${KTR_MARKER}sig`
    expect(
      parseKiroEvent(
        wireEvent("reasoningContentEvent", {
          redactedContent: Buffer.from(signature).toString("base64"),
        }),
      ),
    ).toEqual({ kind: "reasoning", text: "...", signature })

    const opaque = parseKiroEvent(
      wireEvent("reasoningContentEvent", {
        redactedContent: Buffer.from("opaque").toString("base64"),
      }),
    )
    expect(opaque.kind).toBe("unknown")
  })

  it("parses all supported tool frame shapes", () => {
    expect(parseKiroEvent(wireEvent("toolUseEvent", { toolUseId: "tool", name: "bash" }))).toEqual({
      kind: "toolUse",
      id: "tool",
      name: "bash",
      stop: false,
    })
    expect(parseKiroEvent(wireEvent("toolUseEvent", { toolUseId: "tool", input: '{"x":' }))).toEqual({
      kind: "toolUse",
      id: "tool",
      input: '{"x":',
      stop: false,
    })
    expect(parseKiroEvent(wireEvent("toolUseEvent", { toolUseId: "tool", stop: true }))).toEqual({
      kind: "toolUse",
      id: "tool",
      stop: true,
    })
    expect(
      parseKiroEvent(
        wireEvent("toolUseEvent", {
          toolUseId: "single",
          name: "bash",
          input: '{"command":"ls"}',
          stop: true,
        }),
      ),
    ).toEqual({
      kind: "toolUse",
      id: "single",
      name: "bash",
      input: '{"command":"ls"}',
      stop: true,
    })
  })

  it("coerces object and array tool input but treats scalar input as absent", () => {
    expect(
      parseKiroEvent(
        wireEvent("toolUseEvent", {
          toolUseId: "object",
          input: { command: "ls", flags: ["-a"] },
          stop: true,
        }),
      ),
    ).toEqual({
      kind: "toolUse",
      id: "object",
      input: '{"command":"ls","flags":["-a"]}',
      stop: true,
    })
    expect(
      parseKiroEvent(wireEvent("toolUseEvent", { toolUseId: "array", input: [1, 2], stop: true })),
    ).toEqual({ kind: "toolUse", id: "array", input: "[1,2]", stop: true })
    expect(
      parseKiroEvent(wireEvent("toolUseEvent", { toolUseId: "numeric", input: 42 })),
    ).toEqual({ kind: "toolUse", id: "numeric", stop: false })
    expect(
      parseKiroEvent(wireEvent("toolUseEvent", { toolUseId: "boolean", input: false })),
    ).toEqual({ kind: "toolUse", id: "boolean", stop: false })
    expect(
      parseKiroEvent(wireEvent("toolUseEvent", { toolUseId: "null", input: null })),
    ).toEqual({ kind: "toolUse", id: "null", stop: false })
  })

  it("maps malformed known events and novel events to unknown", () => {
    for (const event of [
      wireEvent("assistantResponseEvent", { content: "" }),
      wireEvent("assistantResponseEvent", { content: 1 }),
      wireEvent("reasoningContentEvent", {}),
      wireEvent("toolUseEvent", { toolUseId: "" }),
      wireEvent("toolUseEvent", { name: "bash" }),
      wireEvent("contextUsageEvent", { contextUsagePercentage: "5" }),
      wireEvent("contextUsageEvent", { contextUsagePercentage: Number.NaN }),
      wireEvent("metadataEvent", { stopReason: 1 }),
      wireEvent("futureProviderEvent", { newField: true }),
    ]) {
      expect(parseKiroEvent(event).kind).toBe("unknown")
    }
  })

  it("preserves error spelling precedence and redacts messages", () => {
    const rows: Array<[string, Record<string, unknown>, KiroStreamEvent["kind"]]> = [
      ["ThrottlingException", { message: "Request throttled ksk_rate" }, "rateLimit"],
      ["error", { message: "Too many requests ksk_many" }, "rateLimit"],
      ["error", { message: "rate_limit_exceeded ksk_limit" }, "rateLimit"],
      ["error", { message: "Rejected ksk_status", statusCode: 429 }, "rateLimit"],
      ["TimeoutException", { message: "Request failed ksk_timeout" }, "timeout"],
      ["error", { message: "The operation timed out ksk_timedout" }, "timeout"],
      ["InternalServerException", { Message: "Internal failure ksk_internal" }, "streamError"],
      ["error", { errorMessage: "Bare failure ksk_bare" }, "streamError"],
    ]

    for (const [eventType, payload, kind] of rows) {
      const parsed = parseKiroEvent(wireEvent(eventType, payload))
      expect(parsed.kind).toBe(kind)
      if (parsed.kind === "rateLimit" || parsed.kind === "timeout" || parsed.kind === "streamError") {
        const secret = JSON.stringify(payload).match(/ksk_[A-Za-z0-9]+/)?.[0]
        expect(parsed.message).toContain("<redacted>")
        expect(secret).toBeDefined()
        expect(parsed.message).not.toContain(secret!)
      }
    }
  })

  it("extracts numeric retry-after forms from rate-limit events", () => {
    expect(
      parseKiroEvent(
        wireEvent("ThrottlingException", { message: "throttled", retryAfterSeconds: 2.5 }),
      ),
    ).toEqual({ kind: "rateLimit", message: "throttled", retryAfterSeconds: "2.5" })
    expect(
      parseKiroEvent(
        wireEvent("ThrottlingException", { message: "throttled", retryAfter: "3.25" }),
      ),
    ).toEqual({ kind: "rateLimit", message: "throttled", retryAfterSeconds: "3.25" })
  })

  it("never throws for garbage payloads", () => {
    const garbage: unknown[] = [undefined, null, true, 1, "payload", [], [1], Symbol("payload")]
    for (const payload of garbage) {
      expect(() =>
        parseKiroEvent({ eventType: "assistantResponseEvent", payload } as unknown as KiroEvent),
      ).not.toThrow()
    }
    expect(() => parseKiroEvent(null as unknown as KiroEvent)).not.toThrow()
    expect(() =>
      parseKiroEvent(
        Object.defineProperty({}, "eventType", {
          get() {
            throw new Error("hostile getter")
          },
        }) as KiroEvent,
      ),
    ).not.toThrow()
  })
})

describe("output predicates", () => {
  it("pins preflight and completed-turn asymmetries", () => {
    const text: KiroStreamEvent = { kind: "text", content: "done" }
    const announcement: KiroStreamEvent = {
      kind: "toolUse",
      id: "tool",
      name: "bash",
      stop: false,
    }
    const singleFrame: KiroStreamEvent = {
      kind: "toolUse",
      id: "tool",
      input: "{}",
      stop: true,
    }
    const bareStop: KiroStreamEvent = { kind: "toolUse", id: "tool", stop: true }
    const emptyInput: KiroStreamEvent = { kind: "toolUse", id: "tool", input: "", stop: true }
    const reasoningText: KiroStreamEvent = { kind: "reasoning", text: "working" }
    const ktrSignature: KiroStreamEvent = { kind: "reasoning", signature: `${KTR_MARKER}sig` }
    const plainSignature: KiroStreamEvent = { kind: "reasoning", signature: "sig_plain" }

    expect(beginsAssistantOutput(text)).toBe(true)
    expect(completesAssistantTurn(text)).toBe(true)
    expect(beginsAssistantOutput(announcement)).toBe(true)
    expect(completesAssistantTurn(announcement)).toBe(false)
    expect(beginsAssistantOutput(singleFrame)).toBe(true)
    expect(completesAssistantTurn(singleFrame)).toBe(true)
    expect(beginsAssistantOutput(bareStop)).toBe(false)
    expect(beginsAssistantOutput(emptyInput)).toBe(true)
    expect(beginsAssistantOutput(reasoningText)).toBe(true)
    expect(beginsAssistantOutput(ktrSignature)).toBe(true)
    expect(beginsAssistantOutput(plainSignature)).toBe(false)
    expect(completesAssistantTurn(reasoningText)).toBe(false)
    expect(completesAssistantTurn(ktrSignature)).toBe(false)
    expect(completesAssistantTurn(plainSignature)).toBe(false)
  })
})

describe("resolveRetryAfter", () => {
  isolateEnv("KIRO_RATE_LIMIT_RETRY_SECONDS")

  const rateLimit = (retryAfterSeconds?: string): KiroStreamEvent => ({
    kind: "rateLimit",
    message: "slow down",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  })

  it("prefers the HTTP header over event payload", () => {
    delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
    expect(resolveRetryAfter({ header: "7", event: rateLimit("3") })).toBe("7")
  })

  it("uses validated numeric event payloads", () => {
    delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
    const numeric = parseKiroEvent(
      wireEvent("ThrottlingException", { message: "throttled", retryAfterSeconds: 2 }),
    )
    const numericString = parseKiroEvent(
      wireEvent("ThrottlingException", { message: "throttled", retryAfter: "2.5" }),
    )
    expect(resolveRetryAfter({ event: numeric })).toBe("2")
    expect(resolveRetryAfter({ event: numericString })).toBe("2.5")
  })

  it("lets a valid environment override beat both sources", () => {
    process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = " 10 "
    expect(resolveRetryAfter({ header: "7", event: rateLimit("3") })).toBe("10")
  })

  it("falls through invalid environment overrides", () => {
    for (const value of ["0", "-1", "1.5", "not-a-number"]) {
      process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = value
      expect(resolveRetryAfter({ header: "7", event: rateLimit("3") })).toBe("7")
    }
    expect(resolveRetryAfter({})).toBeUndefined()
  })
})
