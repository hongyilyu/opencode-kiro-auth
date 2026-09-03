/** One recorded call to a scripted fetch. `body` is the parsed JSON when the request body was a JSON string. */
type ScriptedCall = { url: string; init?: RequestInit; body?: unknown }

/**
 * One scripted answer: a ready Response, a thunk that builds one from the call it answers
 * (invoked lazily, so it may route on the request), or an Error that makes the call reject.
 */
type ScriptedResponse = Response | ((call: ScriptedCall) => Response) | Error

type ScriptedFetchOptions = {
  /**
   * What happens once every scripted response has been served: reject the call (default) or keep
   * serving the last entry. A repeated entry must be a thunk so each serve gets a fresh body.
   */
  onExhausted?: "reject" | "repeat-last"
}

type ScriptedFetch = { fetch: typeof globalThis.fetch; calls: ScriptedCall[] }

/**
 * A fetch double that serves `script` in order and records every call it receives. Typed as a
 * real `fetch` at the source, so callers pass `{ fetch }` straight into a dependencies bag.
 */
export function scriptedFetch(...script: ScriptedResponse[]): ScriptedFetch
export function scriptedFetch(...script: [...ScriptedResponse[], ScriptedFetchOptions]): ScriptedFetch
export function scriptedFetch(...script: Array<ScriptedResponse | ScriptedFetchOptions>): ScriptedFetch {
  const options = isOptions(script.at(-1)) ? (script.pop() as ScriptedFetchOptions) : {}
  const responses = script as ScriptedResponse[]
  const calls: ScriptedCall[] = []
  let served = 0

  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call: ScriptedCall = { url: urlOf(input), init, body: parsedBody(init?.body) }
      calls.push(call)
      const next =
        served < responses.length
          ? responses[served++]
          : options.onExhausted === "repeat-last"
            ? responses.at(-1)
            : undefined
      if (next === undefined) throw new Error(`scriptedFetch: unexpected call #${calls.length} to ${call.url}`)
      if (next instanceof Error) throw next
      const response = typeof next === "function" ? next(call) : next
      if (response.bodyUsed) throw new Error("scriptedFetch: a Response serves once; repeat a thunk instead")
      return response
    },
    // Bun's fetch type carries `preconnect`; a no-op keeps the double structurally a real fetch.
    { preconnect() {} },
  )
  return { fetch, calls }
}

function isOptions(value: unknown): value is ScriptedFetchOptions {
  return typeof value === "object" && value !== null && !(value instanceof Response) && !(value instanceof Error)
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

function parsedBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") return undefined
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/** A JSON response; `content-type` defaults to application/json unless `init.headers` sets it. */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const response = new Response(JSON.stringify(body), init)
  if (!response.headers.has("content-type")) response.headers.set("content-type", "application/json")
  return response
}

/** Await a rejection and return the rejection value; throws if the promise resolved instead. */
export function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject, but it resolved")
    },
    (error: unknown) => error,
  )
}

/** The message of a synchronous throw, or undefined when `fn` returned normally. */
export function thrownMessage(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return messageOf(error)
  }
  return undefined
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A scripted fetch that routes on URL prefix and serves each route indefinitely. The shape every
 * multi-endpoint test wants (OIDC, management, chat); an unrouted URL rejects the call.
 */
export function routedFetch(routes: Record<string, () => Response>): ScriptedFetch {
  return scriptedFetch(
    (call) => {
      const route = Object.entries(routes).find(([prefix]) => call.url.startsWith(prefix))
      if (!route) throw new Error(`unrouted fetch in test: ${call.url}`)
      return route[1]()
    },
    { onExhausted: "repeat-last" },
  )
}

export type RoutedFetch = ReturnType<typeof routedFetch>
