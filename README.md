# @hongyilyu/opencode-kiro-auth

> **Fork** of [toandev95/opencode-kiro-auth](https://github.com/toandev95/opencode-kiro-auth)
> by Toan Doan, published to npm because the upstream repo has fork pull requests
> disabled. All upstream credit remains with the original author.

> **Disclaimer — use at your own risk.** This is an unofficial tool, not affiliated
> with Kiro/Amazon/AWS. Using a Kiro subscription outside its official client may
> violate the provider's Terms of Service and **could get your account suspended or
> banned**. It is intended for personal, local use only. You assume all risk.

Use Kiro models as opencode providers with AWS SSO OIDC or API-key authentication.
Both providers can be configured together and selected per request:

| Provider | Credential | Use with |
| --- | --- | --- |
| `kiro` | AWS Builder ID or IAM Identity Center device flow | `--model kiro/claude-sonnet-4.6` |
| `kiro-api` | API key | `--model kiro-api/claude-sonnet-4.6` |

The device flows register their own OAuth client and store the credential in
OpenCode's credential store. kiro-cli is never read and does not need to be installed.

## Setup

1. Add the plugin and the `provider` block to `~/.config/opencode/opencode.json`
   (see `opencode.example.jsonc`). Pick one plugin spec form:
   - npm: `"@hongyilyu/opencode-kiro-auth@latest"`
   - Git: `"github:hongyilyu/opencode-kiro-auth"` (optionally `#<tag>` to pin)
   - Local folder: `"file:///ABSOLUTE/PATH/TO/opencode-kiro-auth"`
2. Connect: `opencode auth login --provider kiro`.
3. Choose **AWS Builder ID** or **IAM Identity Center**. Identity Center also asks for
   your start URL and AWS region.
4. Open the displayed URL and approve the device code.
5. Run: `opencode run "hello" --model kiro/claude-sonnet-4.6`

From a source checkout, `bun run check-auth` verifies the configured credential end to
end and `bun run list-models` prints the resolved Kiro model catalog.

Upgrading from `1.x`: run `opencode auth login --provider kiro` once — 1.x credentials
contain no refresh material and cannot be migrated. Credentials are sensitive; do not
share or commit OpenCode's auth data.

## Models and effort

Model ids must match Kiro's `ListAvailableModels` exactly. Recent additions include
`claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, and `gpt-5.6-sol` /
`gpt-5.6-terra` / `gpt-5.6-luna`.

Effort is selected through opencode's variant picker (or `--variant <level>`). The
plugin forwards the chosen variant name to Kiro's `additionalModelRequestFields`:
`output_config.effort` for Claude models, `reasoning.effort` for GPT models. Without a
variant, no effort field is sent.

## How it works

- `auth.ts` — AWS SSO OIDC client registration, device authorization, and refresh,
  using OpenCode-owned credentials.
- `client.ts` — the single Kiro transport; every request (chat, web search, profile
  lookups) is built and sent through one injectable wire client.
- `request.ts` — maps the Anthropic Messages request opencode sends into Kiro's
  CodeWhisperer `GenerateAssistantResponse` payload (text, tool calls, images).
- `response.ts` — converts the AWS event stream back into an Anthropic SSE stream.
  Pre-output failures become clean HTTP errors — 429 for throttling, 504 for timeouts,
  502 for empty streams — so opencode retries instead of recording an empty assistant
  turn; a terminal `CONTENT_FILTERED` becomes a non-retryable 400 carrying Kiro's
  refusal category.
- `plugin.ts` — registers the provider auth hooks and the intercepting fetch.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `KIRO_RATE_LIMIT_RETRY_SECONDS` | Unset | Positive integer overriding the retry interval for HTTP 429 and pre-output throttling. Otherwise upstream `Retry-After` and opencode's backoff apply. |
| `KIRO_KEEP_IMAGE_TURNS` | `2` | Number of recent image-bearing turns whose images are kept in requests. `0` strips all images. |
| `KIRO_DEBUG` | Unset | Set to `1` for correlated request/event-stream diagnostics on stderr. Logs contain shapes and byte counts — never prompt text, tool output, or credentials. |

For a failing session, rerun with `KIRO_DEBUG=1` and capture stderr: every attempt
shares its trace UUID with the AWS SDK invocation id, so retries and Kiro request ids
correlate directly.

## Large images and long sessions

Kiro rejects requests whose total size (history plus images) exceeds its cap with a 400
`CONTENT_LENGTH_EXCEEDS_THRESHOLD`, and opencode resends the full history — so
image-heavy sessions can hit the limit even at modest token counts. The plugin keeps
images (top-level and inside tool results) only on the most recent
`KIRO_KEEP_IMAGE_TURNS` image-bearing turns and replaces older ones with an
`[image omitted]` marker. A request that still overflows surfaces as a context-overflow
error, so opencode suggests `/compact` or a new session.

## Web search

The plugin registers a `web_search` tool backed by Kiro's server-side web search (the
same one kiro-cli uses, via the CodeWhisperer `InvokeMCP` operation), authenticated
with the credential of the active model. It returns titles, URLs, and snippets with
inline citation hints. Verify end to end (prints no token):
`bun run test-websearch "latest Node.js LTS version"`

## Credits

Original author: Toan Doan
([toandev95/opencode-kiro-auth](https://github.com/toandev95/opencode-kiro-auth)).
Fork maintainer: Hongyi Lyu.
