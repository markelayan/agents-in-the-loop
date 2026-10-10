// Validate the exact call selection against the current host registry.
// No configured model pins, allowlist snapshots, or provider substitutions.
export async function resolveSpawnModel(args, llm) {
  const provider = typeof args?.provider === 'string' ? args.provider.trim() : ''
  const model = typeof args?.model === 'string' ? args.model.trim() : ''
  if (!provider || !model) throw new Error('provider and model are required; choose registered IDs from the system model catalog')
  if (typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') throw new Error('model registry unavailable; spawn refused')
  let providers
  try { providers = await llm.listProviders(); if (!Array.isArray(providers)) throw new Error() }
  catch { throw new Error('provider registry unavailable; spawn refused') }
  if (!providers.some((p) => p.id === provider)) throw new Error(`provider "${provider}" is not registered`)
  let models
  try { models = await llm.listModels(provider); if (!Array.isArray(models)) throw new Error() }
  catch { throw new Error('selected provider model registry unavailable; spawn refused') }
  const entry = models.find((m) => m.id === model)
  if (!entry) throw new Error(`model "${model}" is not registered under provider "${provider}"`)
  let reasoningEffort
  if (args.reasoningEffort !== undefined) {
    if (typeof args.reasoningEffort !== 'string' || !args.reasoningEffort.trim()) throw new Error('reasoningEffort must be a supported effort ID')
    reasoningEffort = args.reasoningEffort.trim()
    let metadata
    try { metadata = typeof llm.resolveModelInfo === 'function' ? await llm.resolveModelInfo(provider, model)
      : typeof llm.resolveModel === 'function' ? await llm.resolveModel(provider, model) : entry }
    catch { throw new Error('selected model reasoning metadata unavailable; spawn refused') }
    if (!metadata?.reasoning?.efforts?.some((e) => e.id === reasoningEffort)) throw new Error(`reasoning effort "${reasoningEffort}" is not supported by the selected model`)
  }
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}
