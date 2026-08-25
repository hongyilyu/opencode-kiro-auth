# CONTEXT.md — domain glossary for opencode-kiro-auth

Vocabulary used by code, tests, and architecture discussions in this repo. Terms are
load-bearing: use them exactly.

## Wire and transport

- **Kiro wire frame** — one AWS `application/vnd.amazon.eventstream` binary frame.
  Decoded by `src/eventstream.ts` into a **KiroEvent** `{ eventType, payload }` —
  framing only, no interpretation.
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
  SSE error frame.

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
  `content_block_stop`) when their stop arrives. A tool block with incomplete or
  empty arguments is unrepresentable: a truncated stream emits nothing and falls
  through to the empty-turn error instead of a `{}`-args tool call.
- **Terminal error** — once the encoder emits an SSE `error` frame, the stream is
  over: open blocks close, no further frames, never a `message_stop` after an error.
  The stream driver routes transport read failures through the encoder, so this
  contract holds on every failure path. Failures after completion emit nothing.
  Matches real Anthropic behavior (error event, then the stream just ends).
- **Empty-turn error** — the SSE error emitted at EOF when nothing completed the
  turn ("Kiro closed the response stream without assistant output"), so opencode
  retries rather than recording a poisoned turn.
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
  the credential is self-contained.

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
- **D6** The response pipeline has one seam (`kiroResponseToAnthropic`): events are
  decoded exactly once, and reader ownership lives in exactly one function. Byte
  replay was deleted because it existed only to decouple two halves of one pipeline.
