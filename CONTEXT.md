# CONTEXT.md — domain glossary for opencode-kiro-auth

Vocabulary used by code, tests, and architecture discussions in this repo. Terms are
load-bearing: use them exactly.

## Wire and transport

- **Kiro wire frame** — one AWS `application/vnd.amazon.eventstream` binary frame.
  Decoded by `src/eventstream.ts` into a **KiroEvent** `{ eventType, payload }` —
  framing only, no interpretation. The decoder is total: it never throws or spins on
  garbage. The spec's three message types collapse into one shape (`:event-type`,
  `:exception-type`, and `:message-type: error` frames, whose `:error-code` /
  `:error-message` headers fold into an `error` event payload). Non-string header
  types are skipped by their spec size; only the 0–9 spec types exist, so a type above
  9 is treated as corruption (escape hatch if Kiro ever emits a vendor type: skip
  instead of fault, behind the same bounds checks).
- **Framing fault** — a prelude or header block that lies about its lengths (too short,
  above the spec maximum, or headers larger than the frame), or a stream that ends
  inside a frame. Terminal: eventstream has no resync marker, so frames decoded before
  the fault are delivered and everything after is discarded. The response driver turns
  it into the same channel as a transport read failure (502 before output, terminal
  SSE error after), so a truncated turn is never recorded as success.
- **KiroStreamEvent** — the *interpreted* form of a KiroEvent: a discriminated union
  produced by `parseKiroEvent` (src/events.ts). Kinds name the behavior we take, not
  Kiro's event namespace: `text`, `reasoning`, `toolUse`, `contextUsage`, `metadata`,
  `rateLimit`, `timeout`, `streamError`, `unknown`.
- **Open-world parse** — `parseKiroEvent` is total: it never throws; any unrecognized
  or malformed event maps to `unknown` and is skipped by consumers (counted in
  `KIRO_DEBUG` output). Kiro may add event types freely without breaking us.
- **Preflight** — reading a 200 response's event stream up to the first real
  output/error before starting the SSE response. `kiroResponseToAnthropic` buffers
  parsed events and hands them directly to the encoder, so each frame is decoded
  once with no byte replay. Kiro hides failures inside HTTP 200 streams; pre-output
  failures become clean HTTP errors (429/504/502/400) that opencode retries or
  surfaces. A pre-output generic stream error remains a 200 response with a terminal
  SSE error frame. A caller abort (the AI SDK's `signal`) is never mapped to an HTTP
  error on any path: an aborted error-body read or preflight read rethrows the abort
  reason, and an abort mid-stream errors the SSE body without manufacturing an `error`
  frame.

## Request mapping

- **KiroRequestPayload** — the typed wire commitment emitted by `src/request.ts` for
  `GenerateAssistantResponse` and consumed as-is by `generateAssistantResponse` in
  `src/client.ts`. It names only the user and assistant entry shapes we produce, not
  Kiro's full schema. Kiro's tool-result content blocks are text only: a kept image
  inside a `tool_result` is hoisted into the entry's `userInputMessage.images` and
  replaced in the result text by `[image N attached]` (N counts from 1 across the
  turn's top-level images first); text blocks map to one `{ text }` each.
- **History normalizer** — the pure request-side operation over copied Anthropic
  messages. It splits mixed retry turns, folds the system prompt, degrades invalid
  tool pairs, and applies image retention in one internally ordered pass sequence.
- **Image retention policy** — only the most recent configured image-bearing turns
  retain image bytes. A turn counts when images are top-level or inside a structured
  `tool_result`; every older image, at either level, is rewritten to `[image omitted]`
  marker text by the normalizer, so the wire builder never knows whether a turn was
  kept. `KIRO_KEEP_IMAGE_TURNS=0` strips all images; a blank value is unset (default 2).

## Output predicates (deliberately two — intents differ)

- **beginsAssistantOutput(e)** — "safe to stop buffering and start streaming."
  Used by preflight. Reasoning text and KTR signatures count (streaming them
  promptly matters); a bare tool stop frame does not.
- **completesAssistantTurn(e)** — "this turn produced a usable assistant turn."
  Used by the encoder's EOF accounting. Only text and *emitted* tool blocks count;
  reasoning alone never completes a turn, so a reasoning-only stream still errors at
  EOF and opencode retries instead of recording a contentless assistant message.

## SSE encoding

- **Anthropic SSE stream** — the `event:`/`data:` stream opencode's
  `@ai-sdk/anthropic` provider consumes. Produced by the **AnthropicSseEncoder**
  (src/sse.ts), an explicit state machine over KiroStreamEvents.
- **Atomic tool block** — tool calls are buffered (id, name, input fragments) and
  emitted as one complete unit (`content_block_start` + one `input_json_delta` +
  `content_block_stop`) when their stop arrives. A tool block with incomplete
  arguments or no name is unrepresentable: a stream that ends without the stop frame,
  or a call whose name never arrived, emits nothing and falls through to the
  empty-turn error instead of a `{}`-args or nameless tool call. An explicitly stopped
  call with no input fragments is emitted with `partial_json: ""`, Anthropic's wire
  shape for zero-parameter tools.
- **Terminal error** — once the encoder emits an SSE `error` frame, the stream is
  over: open blocks close, no further frames, never a `message_stop` after an error.
  The stream driver routes transport read failures through the encoder, so this
  contract holds on every failure path. Failures after completion emit nothing.
  Matches real Anthropic behavior (error event, then the stream just ends).
- **Empty-turn error** — the SSE error emitted at EOF when nothing completed the
  turn ("Kiro closed the response stream without assistant output"), so opencode
  retries rather than recording a poisoned turn.
- **Refusal stop** — Kiro's `metadataEvent.stopReason === CONTENT_FILTERED`
  (`isContentFilteredStop`, one predicate for both sites). Before output it is a
  non-retryable 400; after output the turn completes normally with
  `stop_reason: "refusal"` and `stop_details { type, category?, explanation? }`, which
  `@ai-sdk/anthropic` maps to a content-filter finish. Otherwise `stop_reason` is
  derived from what was emitted (`tool_use` / `end_turn`), never from Kiro's metadata.
- **Poisoned turn** — an assistant turn recorded as successful with broken content
  (e.g. a tool call with `{}` arguments). Poison persists: opencode resends full
  history, so every later request carries it. The Aug 19 2026 incident recorded
  seven of these (`SchemaError(Missing key ["command"])`).

## Reasoning protocol

- **KTR envelope** — Kiro's redacted-reasoning blob: base64 `redactedContent`
  decoding to a `.KTR~~`-prefixed signature. Replayed opaquely across turns.
- **Omitted-reasoning sentinel** — the single-space thinking delta (`" "`) emitted
  before a signature-only thinking block so opencode keeps the block alive;
  `assistantEntry` maps it back to `""` on replay. Round-trip invariant:
  emit ∘ replay preserves Kiro's original empty form.

## Auth and sessions

- **KiroSession** — the seam consumers use for per-request auth:
  `authHeaders()`, `chatProfileArn()` (undefined for API keys — omitted from chat
  bodies), `mcpProfileArn()` (always resolves). Both adapters (OAuth and API key)
  live in src/session.ts; the Kiro transport client (src/client.ts) is the sole
  consumer of the profileArn methods.
- **RefreshState packing** — the entire OAuth refresh state (refresh token, client
  id/secret, region, method) base64url-packed into opencode's `refresh` credential
  field with the `kiro-oauth-v1:` prefix. opencode's generic storage learns nothing;
  the credential is self-contained. The blob is credential material and is redacted
  by `redactKiroSecrets` like API keys and bearer tokens.
- **Held credential** — `KiroCredentialManager` keeps a refreshed credential in memory
  from the moment OIDC returns it, tagged with the stored `refresh` string it
  replaces. The store stays authoritative (a removed credential still throws; a store
  that moved under us wins), but a failed persist no longer loses the rotated refresh
  token or triggers a second refresh: the write is retried on the next call. Persist
  failures stay loud (fail-closed).
- **Async memo** — `src/memo.ts` is the one bounded, promise-sharing cache behind the
  OAuth profile ARN, the API-key profile ARN, and the opencode context limits. The
  loader owns the policy: resolving (even to a fallback) caches, rejecting evicts so
  the next call retries. A Builder ID 4xx from ListAvailableProfiles is an
  authoritative placeholder answer and is cached; a 5xx or transport failure is not.

## Decisions

- **D1** Two output predicates, not one (see above). Unifying forces either
  buffering all reasoning (TTFB) or accepting reasoning-only turns (poison).
- **D2** Atomic tool blocks over parallel-open blocks (bets on undocumented client
  tolerance) and over reordering (leaks into replay semantics).
- **D3** Mid-stream errors are terminal; a "graceful" stop after an error is either
  ignored by the client or believed — and believing it records a truncated turn as
  success.
- **D4** The parse is open-world (`unknown` variant); error detection keeps its
  battle-tested string heuristics as implementation detail inside src/events.ts.
- **D5** No unified AuthStrategy interface across OAuth and API key: acquisition
  flows are irreducibly different and host-schema-bound; KiroSession is the right
  unification point. Don't re-propose.
- **D6** The response pipeline has one seam (`kiroResponseToAnthropic`): every
  upstream Response, including non-2xx ones, goes through it; events are decoded
  exactly once, and reader ownership lives in exactly one function. Byte replay was
  deleted because it existed only to decouple two halves of one pipeline. HTTP-error
  shaping (body read, redaction, overflow mapping, retry-after policy) lives behind
  the same seam rather than in the fetch interceptor.
- **D7** Request normalization is one pure function over copies; mutation and pass
  ordering are implementation details. The Anthropic input remains loosely typed at
  the boundary, where defensive checks are the validation, while `KiroRequestPayload`
  is the typed output contract.
- **D8** The eventstream decoder returns a framing fault as a value rather than
  throwing: the contract is visible in the return type, frames decoded before the
  fault are not lost, and the response driver decides what a fault means.
- **D9** Persist failure stays fail-closed. Serving silently from memory would hide an
  unwritable auth store until a restart forces re-login; holding the refreshed
  credential fixes the token loss and the OIDC re-hit without hiding the fault.
