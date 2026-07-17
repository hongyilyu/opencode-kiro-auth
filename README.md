# @hongyilyu/opencode-kiro-auth

> **Fork.** This is a fork of [toandev95/opencode-kiro-auth](https://github.com/toandev95/opencode-kiro-auth)
> by Toan Doan, published to npm because the upstream repo has fork pull requests
> disabled. It adds Claude Fable 5 / Sonnet 5 and the GPT 5.6 models, wires opencode
> effort variants through to Kiro's `additionalModelRequestFields`, and supports the
> kiro-cli >= 2.13 token cache (`kiro-auth-token-cli.json`). All upstream credit remains
> with the original author.

> **Disclaimer — use at your own risk.** This is an unofficial tool, not affiliated
> with Kiro/Amazon/AWS. Using a Kiro subscription outside its official client may
> violate the provider's Terms of Service and **could get your account suspended or
> banned**. It is intended for personal, local use only. You assume all risk.

Use the credentials `kiro-cli` already stored (AWS SSO / Builder ID) as an opencode
provider. No separate login: opencode keeps only a sentinel marker, and the real
bearer token is read and refreshed live from kiro-cli's own SSO cache
(`~/.aws/sso/cache/kiro-auth-token-cli.json`, or the legacy `kiro-auth-token.json`)
on every request. Requests are shaped to match kiro-cli's wire format.

## Setup

1. Log in with kiro-cli once: `kiro-cli login`
2. Add the plugin and the `provider` block to `~/.config/opencode/opencode.json`
   (see `opencode.example.jsonc`). Pick one plugin spec form:
   - npm: `"@hongyilyu/opencode-kiro-auth@latest"`
   - Git: `"github:hongyilyu/opencode-kiro-auth"` (optionally `#<tag>` to pin)
   - Local folder: `"file:///ABSOLUTE/PATH/TO/opencode-kiro-auth"`
3. Connect: `opencode auth login` -> pick **Kiro** -> "Use existing kiro-cli login".
4. Run: `opencode run "hello" --model kiro/claude-sonnet-4.6`

When working from a source checkout, optional diagnostics are available:
`bun run check-auth` verifies token access, and `bun run list-models` dumps the live
model catalog. Neither command is needed when using the plugin from npm.

## Models and effort

Model ids must match Kiro's `ListAvailableModels` exactly. Recent additions include
`claude-fable-5`, `claude-sonnet-5`, and `gpt-5.6-sol` / `gpt-5.6-terra` /
`gpt-5.6-luna`.

Effort is selected through opencode's variant picker (or `--variant <level>`). The
plugin forwards the chosen variant name to Kiro's `additionalModelRequestFields`:
`output_config.effort` for Claude models, `reasoning.effort` for GPT models. Models
without a variant selected send no effort field, leaving behavior unchanged.

## How it works

- `auth.ts` reads/refreshes kiro-cli''s SSO token in place (shared cache).
- `profile.ts` resolves the profileArn like kiro-cli: real ARN for accounts that
  have one, else the fixed Builder-ID placeholder.
- `transform.ts` maps the Anthropic Messages request opencode sends into Kiro''s
  CodeWhisperer `GenerateAssistantResponse` request (text, tool calls, images), and
  converts the AWS event-stream response back into an Anthropic SSE stream.
- `plugin.ts` registers the opencode `auth` hook whose loader returns the
  intercepting `fetch`.

## Large images and long sessions

Kiro caps the total size of a request (history plus images), returning a 400
`CONTENT_LENGTH_EXCEEDS_THRESHOLD` when exceeded. Because opencode resends the full
history — including every prior image — image-heavy sessions can hit this limit even
when the token count looks small. To avoid it, the plugin keeps images only on the most
recent image-bearing turns and replaces older ones with an `[image omitted]` marker.

- Tune with `KIRO_KEEP_IMAGE_TURNS` (default `2`; `0` strips all images).
- If a request still overflows, the error is surfaced as a context-overflow message, so
  opencode suggests starting a new session or running `/compact`.

## Web search (no API key)

The plugin also registers a `web_search` tool backed by Kiro''s built-in web search,
the same one kiro-cli uses. It runs server-side on Kiro''s backend through the
CodeWhisperer `InvokeMCP` operation, authenticated with your existing kiro-cli login,
so it needs no third-party search API key.

- `mcp.ts` calls `InvokeMCP` (JSON-RPC `tools/call` for `web_search`) and parses the
  `{ "results": [...] }` payload.
- `tools.ts` exposes it to opencode as the `web_search` tool, returning titles, URLs,
  and snippets with inline citation hints.

Verify it end to end (uses your live login, prints no token):
`bun run script/test-websearch.ts "latest Node.js LTS version"`

## Credits

Original author: Toan Doan <toandev.95@gmail.com>
([toandev95/opencode-kiro-auth](https://github.com/toandev95/opencode-kiro-auth)).

Fork maintainer: Hongyi Lyu.
