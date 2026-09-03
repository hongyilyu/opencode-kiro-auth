import { describe, expect, it } from "bun:test"
import { createAsyncMemo } from "../src/memo"

/** A load whose settlement the test controls, plus how many times the memo invoked it. */
function scriptedLoad<V>() {
  let calls = 0
  const pending: Array<{ resolve: (value: V) => void; reject: (error: unknown) => void }> = []
  const load = () => {
    calls++
    return new Promise<V>((resolve, reject) => {
      pending.push({ resolve, reject })
    })
  }
  return { load, calls: () => calls, pending }
}

/** A load that resolves immediately and records its call count. */
function countingLoad<V>(value: (key: string) => V) {
  let calls = 0
  return {
    load: (key: string) => async () => {
      calls++
      return value(key)
    },
    calls: () => calls,
  }
}

describe("createAsyncMemo", () => {
  it("rejects a limit that is not a positive integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => createAsyncMemo<object, string>({ limit })).toThrow(RangeError)
    }
  })

  it("a resolved value is served from the memo without reloading", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 4 })
    const scope = {}
    const { load, calls } = countingLoad((key) => `value:${key}`)
    expect(await memo.resolve(scope, "a", load("a"))).toBe("value:a")
    expect(await memo.resolve(scope, "a", load("a"))).toBe("value:a")
    expect(calls()).toBe(1)
  })

  it("concurrent callers share one in-flight load", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 4 })
    const scope = {}
    const { load, calls, pending } = scriptedLoad<string>()
    const first = memo.resolve(scope, "a", load)
    const second = memo.resolve(scope, "a", load)
    expect(calls()).toBe(1)
    pending[0]!.resolve("shared")
    expect(await Promise.all([first, second])).toEqual(["shared", "shared"])
  })

  it("evicts the least-recently-used key when the limit is reached", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 2 })
    const scope = {}
    const { load, calls } = countingLoad((key) => key)
    await memo.resolve(scope, "a", load("a"))
    await memo.resolve(scope, "b", load("b"))
    await memo.resolve(scope, "c", load("c")) // evicts a
    expect(calls()).toBe(3)
    await memo.resolve(scope, "b", load("b")) // still cached
    expect(calls()).toBe(3)
    await memo.resolve(scope, "a", load("a")) // reloaded
    expect(calls()).toBe(4)
  })

  it("a hit refreshes recency so the untouched key is evicted instead", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 2 })
    const scope = {}
    const { load, calls } = countingLoad((key) => key)
    await memo.resolve(scope, "a", load("a"))
    await memo.resolve(scope, "b", load("b"))
    await memo.resolve(scope, "a", load("a")) // hit: a is now most recent
    await memo.resolve(scope, "c", load("c")) // evicts b, not a
    expect(calls()).toBe(3)
    await memo.resolve(scope, "a", load("a"))
    expect(calls()).toBe(3)
    await memo.resolve(scope, "b", load("b"))
    expect(calls()).toBe(4)
  })

  it("a rejected load is evicted so the next call retries", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 4 })
    const scope = {}
    let calls = 0
    const load = async () => {
      calls++
      if (calls === 1) throw new Error("first load fails")
      return "recovered"
    }
    await expect(memo.resolve(scope, "a", load)).rejects.toThrow("first load fails")
    expect(await memo.resolve(scope, "a", load)).toBe("recovered")
    expect(calls).toBe(2)
  })

  it("an old rejection never evicts a newer load for the same key", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 1 })
    const scope = {}
    const { load, calls, pending } = scriptedLoad<string>()

    const stale = memo.resolve(scope, "a", load)
    stale.catch(() => {})
    // Inserting another key at limit 1 evicts the still-pending "a".
    await memo.resolve(scope, "b", async () => "b")
    // A fresh load for "a" becomes the current entry.
    const fresh = memo.resolve(scope, "a", load)
    expect(calls()).toBe(2)

    pending[0]!.reject(new Error("stale failure"))
    await stale.catch(() => {})
    pending[1]!.resolve("fresh")
    expect(await fresh).toBe("fresh")

    // The stale rejection did not knock out the fresh entry: no third load.
    expect(await memo.resolve(scope, "a", load)).toBe("fresh")
    expect(calls()).toBe(2)
  })

  it("scopes are isolated: the same key loads separately per scope", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 4 })
    const scopeA = {}
    const scopeB = {}
    expect(await memo.resolve(scopeA, "k", async () => "from A")).toBe("from A")
    expect(await memo.resolve(scopeB, "k", async () => "from B")).toBe("from B")
    expect(await memo.resolve(scopeA, "k", async () => "reloaded A")).toBe("from A")
    expect(await memo.resolve(scopeB, "k", async () => "reloaded B")).toBe("from B")
  })

  it("eviction in one scope does not touch another scope", async () => {
    const memo = createAsyncMemo<object, string>({ limit: 1 })
    const scopeA = {}
    const scopeB = {}
    const { load, calls } = countingLoad((key) => key)
    await memo.resolve(scopeA, "k", load("k"))
    await memo.resolve(scopeB, "k", load("k"))
    await memo.resolve(scopeB, "other", load("other")) // evicts B's k only
    expect(calls()).toBe(3)
    await memo.resolve(scopeA, "k", load("k"))
    expect(calls()).toBe(3)
  })
})
