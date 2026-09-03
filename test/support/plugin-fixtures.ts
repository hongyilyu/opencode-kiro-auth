import type { PluginInput } from "@opencode-ai/plugin"
import { createKiroFetch } from "../../src/plugin"
import type { KiroSession } from "../../src/session"
import { chunkedResponse } from "./eventstream-fixtures"
import { scriptedFetch } from "./http-fixtures"

export const FAKE_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/TEST"

/** A KiroSession that answers with fixed values; override the token, the profile ARN, or any method. */
export function fakeSession(
  overrides: Partial<KiroSession> & { token?: string; profileArn?: string } = {},
): KiroSession {
  const { token = "test-token", profileArn = FAKE_PROFILE_ARN, ...methods } = overrides
  return {
    async authHeaders() {
      return { authorization: `Bearer ${token}` }
    },
    async chatProfileArn() {
      return profileArn
    },
    async mcpProfileArn() {
      return profileArn
    },
    ...methods,
  }
}

/**
 * A PluginInput for tests. `models` (kiro model id -> context limit) adds a `config.providers`
 * surface; when omitted there is no config surface at all and resolveContextLimit falls back to
 * its default. `client` fields are merged in for tests that need `session.message` or `auth.set`.
 */
export function fakePluginInput(
  options: { models?: Record<string, number>; client?: Record<string, unknown> } = {},
): PluginInput {
  const { models, client = {} } = options
  const config = models
    ? {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "kiro",
                  models: Object.fromEntries(
                    Object.entries(models).map(([id, context]) => [id, { limit: { context } }]),
                  ),
                },
              ],
            },
          }),
        },
      }
    : {}
  return { client: { ...config, ...client } } as unknown as PluginInput
}

/**
 * Drive one chat request through the real plugin pipeline (createKiroFetch over fakeSession and
 * fakePluginInput) against an upstream that answers with the given eventstream chunks. The request
 * declares a single `bash` tool so tool-call frames land on a real tool definition.
 */
export async function fullPipeline(...chunks: Uint8Array[]): Promise<Response> {
  const session = fakeSession()
  const { fetch } = scriptedFetch(() => chunkedResponse(...chunks))
  const input = fakePluginInput({ models: { "claude-fable-5": 200_000 } })
  const kiroFetch = createKiroFetch("kiro", input, async () => session, { fetch })
  return kiroFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-fable-5",
      messages: [{ role: "user", content: "run a command" }],
      tools: [
        {
          name: "bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    }),
  })
}
