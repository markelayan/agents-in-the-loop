// Read-only projections of the host registries. Never return provider config,
// credentials, prompts, or preset contents to the browser.
export async function readCatalog({ agentCtx, wsCtx, wsRegistry }) {
  const result = { ok: true, workspaces: [], models: [], presets: [],
    permissions: ['read-only', 'workspace-write', 'danger-full-access'], errors: {} }
  const face = (name) => agentCtx?.get?.(name) ?? wsCtx?.get?.(name)
  try {
    if (typeof wsRegistry?.list !== 'function') throw new Error('Workspace registry unavailable')
    result.workspaces = (await wsRegistry.list()).filter((w) => w?.id)
      .map((w) => ({ id: w.id, title: w.title ?? w.name ?? '', path: w.path ?? '' }))
  } catch { result.errors.workspaces = 'Workspace registry unavailable; refresh when the host is ready.' }
  try {
    const llm = face('llm')
    if (typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') {
      throw new Error('Model registry unavailable')
    }
    const providers = await llm.listProviders()
    const lists = await Promise.all(providers.map(async (p) => {
      try {
        const models = await llm.listModels(p.id)
        return models.filter((m) => m?.id).map((m) => ({ provider: p.id, model: m.id,
          label: `${p.name || p.id} / ${m.name || m.id}` }))
      } catch {
        result.errors.models = 'Some provider model lists are unavailable; refresh to retry.'
        return []
      }
    }))
    result.models = lists.flat()
  } catch { result.errors.models = 'Model registry unavailable; refresh when the host is ready.' }
  try {
    const presets = face('agentPresets')
    if (typeof presets?.list !== 'function') throw new Error('Preset registry unavailable')
    const raw = await presets.list()
    const list = Array.isArray(raw) ? raw : raw?.ok === true ? raw.value?.presets : undefined
    if (!Array.isArray(list)) throw new Error('Preset list unavailable')
    result.presets = list.filter((p) => p?.id).map((p) => ({ id: p.id, title: p.name || p.id }))
  } catch { result.errors.presets = 'Preset registry unavailable; refresh when the host is ready.' }
  return result
}
