import type { PluginInput } from "@opencode-ai/plugin"

const DEFAULT_CONTEXT_LIMIT = 1_000_000

type Client = PluginInput["client"]

const limitsByClient = new WeakMap<Client, Map<string, Promise<Record<string, number>>>>()

async function loadConfiguredLimits(client: Client, providerId: string): Promise<Record<string, number>> {
  const res = (await client.config.providers()) as any
  const body = res?.data ?? res
  const providers: any[] = Array.isArray(body?.providers) ? body.providers : []
  const provider = providers.find((p) => p?.id === providerId)
  const out: Record<string, number> = {}
  for (const [id, model] of Object.entries<any>(provider?.models ?? {})) {
    const ctx = model?.limit?.context
    if (typeof ctx === "number" && ctx > 0) out[id] = ctx
  }
  return out
}

/** Resolve the context window for `model` from opencode config; defaults if unavailable. Never throws. */
export async function resolveContextLimit(
  client: Client | undefined,
  providerId: string,
  model: string,
): Promise<number> {
  if (!client) return DEFAULT_CONTEXT_LIMIT
  let byProvider = limitsByClient.get(client)
  if (!byProvider) {
    byProvider = new Map()
    limitsByClient.set(client, byProvider)
  }
  let limitsPromise = byProvider.get(providerId)
  if (!limitsPromise) {
    limitsPromise = loadConfiguredLimits(client, providerId).catch(() => ({}))
    byProvider.set(providerId, limitsPromise)
  }
  const configured = await limitsPromise
  return configured[model] ?? DEFAULT_CONTEXT_LIMIT
}
