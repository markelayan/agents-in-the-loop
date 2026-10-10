// Read-only projections of the host registries. Never return provider config,
// credentials, prompts, or preset contents to the browser.
export async function readCatalog({ agentCtx, wsCtx, wsRegistry }) {
  const result = { ok: true, workspaces: [], models: [], presets: [],
    permissions: [], errors: {} }
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
        return await Promise.all(models.filter((m) => m?.id).map(async (m) => {
          let metadata = m
          try { metadata = typeof llm.resolveModelInfo === 'function' ? await llm.resolveModelInfo(p.id, m.id)
            : typeof llm.resolveModel === 'function' ? await llm.resolveModel(p.id, m.id) : m } catch {}
          return { provider: p.id, model: m.id, label: `${p.name || p.id} / ${m.name || m.id}`,
            reasoningEfforts: (metadata?.reasoning?.efforts || []).map((e) => ({ id: e.id, name: e.name || e.id })) }
        }))
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
  try {
    const service = face('permissionPresets')
    if (typeof service?.catalog !== 'function') throw new Error('Permission registry unavailable')
    const catalog = await service.catalog()
    if (!Array.isArray(catalog?.defaultOptions)) throw new Error('Permission registry unavailable')
    result.permissions = catalog.defaultOptions.filter((p) => p?.value).map((p) => p.value)
  } catch { result.errors.permissions = 'Permission registry unavailable; refresh when the host is ready.' }
  return result
}
