import type { PluginInput } from "@opencode-ai/plugin"
import { createAsyncMemo } from "./memo"

const DEFAULT_CONTEXT_LIMIT = 1_000_000

type Client = PluginInput["client"]

const configuredLimits = createAsyncMemo<Client, Record<string, number>>({ limit: 8 })

/**
 * Unwrap an opencode SDK result. The client is created without throwOnError, so failures arrive
 * as an `{ error }` envelope (-> undefined) and successes as `{ data }`; older shapes return the
 * body directly.
 */
export function sdkData(response: unknown): unknown {
  if (sdkFailed(response)) return undefined
  const envelope = response as { data?: unknown } | null | undefined
  return envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : response
}

/** Whether an opencode SDK result is the non-throwing `{ error }` envelope. */
export function sdkFailed(response: unknown): boolean {
  return Boolean(response && typeof response === "object" && (response as { error?: unknown }).error)
}

/**
 * Load the configured context windows for one provider. Throws when the lookup itself failed
 * (a rejected call, or the SDK's non-throwing error envelope) so the failure is not memoized;
 * resolves `{}` for a provider that is genuinely absent or has no limits configured.
 */
async function loadConfiguredLimits(client: Client, providerId: string): Promise<Record<string, number>> {
  const body = sdkData(await client.config.providers()) as any
  if (!Array.isArray(body?.providers)) throw new Error("opencode config.providers() returned no providers")
  const provider = body.providers.find((p: any) => p?.id === providerId)
  const out: Record<string, number> = {}
  for (const [id, model] of Object.entries<any>(provider?.models ?? {})) {
    const ctx = model?.limit?.context
    if (typeof ctx === "number" && ctx > 0) out[id] = ctx
  }
  return out
}

/**
 * Resolve the context window for `model` from opencode config; the default if unavailable.
 * Never throws. A failed lookup yields the default for this call and is retried next time.
 */
export async function resolveContextLimit(
  client: Client | undefined,
  providerId: string,
  model: string,
): Promise<number> {
  if (!client) return DEFAULT_CONTEXT_LIMIT
  const configured = await configuredLimits
    .resolve(client, providerId, () => loadConfiguredLimits(client, providerId))
    .catch(() => ({}) as Record<string, number>)
  return configured[model] ?? DEFAULT_CONTEXT_LIMIT
}
