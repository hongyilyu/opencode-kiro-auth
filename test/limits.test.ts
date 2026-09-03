import { describe, expect, it } from "bun:test"
import { resolveContextLimit } from "../src/limits"

const DEFAULT_LIMIT = 1_000_000

type ProvidersResponse = unknown

/**
 * A fake opencode client whose config.providers() answers from a script (one entry per call,
 * the last entry repeating) and counts how often it was asked. Each test builds its own client
 * so the module-level memo (keyed weakly by client) starts empty.
 */
function limitsClient(...responses: Array<ProvidersResponse | Error>) {
  let calls = 0
  const client = {
    config: {
      providers: async () => {
        const scripted = responses[Math.min(calls, responses.length - 1)]
        calls++
        if (scripted instanceof Error) throw scripted
        return scripted
      },
    },
  } as any
  return { client, calls: () => calls }
}

const configured = (providerId: string, limits: Record<string, unknown>) => ({
  data: {
    providers: [
      {
        id: providerId,
        models: Object.fromEntries(Object.entries(limits).map(([model, context]) => [model, { limit: { context } }])),
      },
    ],
  },
})

describe("resolveContextLimit", () => {
  it("selects the requested provider's limit from a multi-provider payload", async () => {
    const { client } = limitsClient({
      data: {
        providers: [
          { id: "kiro", models: { model: { limit: { context: 111_111 } } } },
          { id: "kiro-api", models: { model: { limit: { context: 999_999 } } } },
        ],
      },
    })
    expect(await resolveContextLimit(client, "kiro-api", "model")).toBe(999_999)
    expect(await resolveContextLimit(client, "kiro", "model")).toBe(111_111)
  })

  it("providers() is asked once per client and provider", async () => {
    const { client, calls } = limitsClient(configured("kiro", { a: 200_000, b: 400_000 }))
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(200_000)
    expect(await resolveContextLimit(client, "kiro", "b")).toBe(400_000)
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(200_000)
    expect(calls()).toBe(1)
    await resolveContextLimit(client, "kiro-api", "a")
    expect(calls()).toBe(2)
  })

  it("concurrent first calls share one lookup", async () => {
    const { client, calls } = limitsClient(configured("kiro", { a: 200_000 }))
    const results = await Promise.all([
      resolveContextLimit(client, "kiro", "a"),
      resolveContextLimit(client, "kiro", "a"),
      resolveContextLimit(client, "kiro", "missing"),
    ])
    expect(results).toEqual([200_000, 200_000, DEFAULT_LIMIT])
    expect(calls()).toBe(1)
  })

  it("a rejected providers() yields the default and is retried next call", async () => {
    const { client, calls } = limitsClient(new Error("sdk down"), configured("kiro", { a: 200_000 }))
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(200_000)
    expect(calls()).toBe(2)
  })

  it("an SDK error envelope yields the default and is retried next call", async () => {
    const { client, calls } = limitsClient(
      { error: { name: "InternalError" } },
      configured("kiro", { a: 200_000 }),
    )
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(200_000)
    expect(calls()).toBe(2)
  })

  it("a response without a providers array yields the default and is retried next call", async () => {
    const { client, calls } = limitsClient(
      { data: { providers: "not-a-list" } },
      { data: {} },
      configured("kiro", { a: 200_000 }),
    )
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(200_000)
    expect(calls()).toBe(3)
  })

  it("a successful lookup lacking our provider is memoized", async () => {
    const { client, calls } = limitsClient(configured("other", { a: 5 }), configured("kiro", { a: 200_000 }))
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(DEFAULT_LIMIT)
    expect(calls()).toBe(1)
  })

  it("accepts a bare providers body without the data envelope", async () => {
    const { client } = limitsClient({ providers: [{ id: "kiro", models: { a: { limit: { context: 123_456 } } } }] })
    expect(await resolveContextLimit(client, "kiro", "a")).toBe(123_456)
  })

  it("default without a client", async () => {
    expect(await resolveContextLimit(undefined, "kiro", "a")).toBe(DEFAULT_LIMIT)
  })

  it("default for an unconfigured model", async () => {
    const { client } = limitsClient(configured("kiro", { a: 200_000 }))
    expect(await resolveContextLimit(client, "kiro", "b")).toBe(DEFAULT_LIMIT)
  })

  it("default for non-positive or non-numeric limit.context", async () => {
    const { client } = limitsClient(
      configured("kiro", { zero: 0, negative: -5, text: "200000", nan: Number.NaN, ok: 300_000 }),
    )
    expect(await resolveContextLimit(client, "kiro", "zero")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "negative")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "text")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "nan")).toBe(DEFAULT_LIMIT)
    expect(await resolveContextLimit(client, "kiro", "ok")).toBe(300_000)
  })
})
