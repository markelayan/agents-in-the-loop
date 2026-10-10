// spawner — spawn persistent dsh sessions IN-PROCESS via the host registry
// (v1.8.0). No child process, no ~/.dsh/new-session.mjs, no token scanning:
// the same faces dsh-taskboard uses for scheduled executions
// (dsh-taskboard/src/host/execution.ts AgentsFace + src/index.ts composeAgent):
//   agentCtx.get('agentPresets')  → resolve(id) → meta.agentPreset, mount() → setup
//   agentCtx.get('workspaces')    → get(id) → { path } → meta.cwd, attach()
//   agentCtx.agents.create()      → meta { cwd, agentPreset } + agentOptions { provider, model, reasoningEffort }
//   agentCtx.get('sessions') + get('sessionTitle') → best-effort rename
//   agentCtx.get('permissionPresets') + get('sessions') → best-effort permission
// Every face is capability-detected: a missing face degrades (or refuses
// when it would silently change semantics) — never a bare default shell.

import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

function expand(p) {
  return typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

// ── config ──────────────────────────────────────────────────────────────
export function resolveSpawnConfig(config) {
  const s = config?.spawn ?? {}
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [])
  return {
    enabled: s.enabled === true, // master switch — OFF unless explicitly enabled
    maxSessions: Number.isInteger(s.maxSessions) && s.maxSessions > 0 ? s.maxSessions : 9,
    preset: typeof s.preset === 'string' && s.preset ? s.preset : '',
    allowedPresets: strArr(s.allowedPresets), // empty = any resolvable preset
    provider: typeof s.provider === 'string' && s.provider ? s.provider : 'zai-coding-cn',
    model: typeof s.model === 'string' && s.model ? s.model : 'glm-5.3-flash',
    reasoningEffort: typeof s.reasoningEffort === 'string' && s.reasoningEffort ? s.reasoningEffort : undefined,
    allowedModels: strArr(s.allowedModels), // 'provider/model' entries; empty = any
    workspaces: strArr(s.workspaces), // workspace ids; empty = caller's workspace only
    allowedPermissions: strArr(s.allowedPermissions).length > 0 ? strArr(s.allowedPermissions) : ['read-only'],
    stateFile: expand(typeof s.stateFile === 'string' && s.stateFile ? s.stateFile : '~/.dsh/spawned-sessions.json'),
  }
}

// ── seat accounting (same rule as mc-runtime: live sessions registered in
// the contacts store, minus excluded names) ──────────────────────────────
export function seatsUsed({ contacts, agentCtx, excludedContacts }) {
  const excluded = new Set(excludedContacts)
  let n = 0
  for (const [name, c] of Object.entries(contacts ?? {})) {
    if (excluded.has(name)) continue
    // v1.11: identity sessions are plugin-managed hidden sessions — never
    // user spawn seats (record flag, not name lists).
    if (c?.identity === true) continue
    if (agentCtx?.agents?.get(c.sessionId)) n++
  }
  return n
}

// ── faces ───────────────────────────────────────────────────────────────
export function detectFaces(agentCtx) {
  const get = (name) => {
    try { return agentCtx?.get?.(name) } catch { return undefined }
  }
  return {
    presets: get('agentPresets'),
    workspaces: get('workspaces'),
    sessions: get('sessions'),
    sessionTitle: get('sessionTitle'),
    permissionPresets: get('permissionPresets'),
    persistence: get('sessionPersistence'),
  }
}

// Resolve the CALLER's workspace so a spawned session inherits it EXPLICITLY
// (meta.cwd + attachSession) instead of landing in ungrouped sessions.
// Canonical pattern (mirrors dsh-taskboard callerWorkspace): the tool exec
// context carries the calling agent WITH its session header
// (exec.agent.session.header.cwd), resolved through the workspace registry's
// resolveByPath. Returns { id } or null.
export async function resolveCallerWorkspace(wsRegistry, exec) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const ws = await wsRegistry?.resolveByPath?.(cwd)
    return ws?.id ? { id: ws.id } : null
  } catch { /* cosmetic — fall through to null */ }
  return null
}

// ── journal (append-only JSONL audit: who spawned what, when) ───────────
export function appendSpawnJournal(stateFile, entry) {
  // O_APPEND append (atomic enough for line-sized records); never read+rewrite.
  try {
    mkdirSync(dirname(stateFile), { recursive: true })
    appendFileSync(stateFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    return true
  } catch {
    return false
  }
}

// ── internal creation ───────────────────────────────────────────────────
// options: { agentCtx, preset, workspaceId, provider, model, reasoningEffort,
//            permission, title }
// Throws on any failure BEFORE/AFTER create? Create failure throws (nothing
// was born). Post-create cosmetics (attach/rename/permission) are best-effort
// and reported in `cosmetic` errors array — the session exists and is fine.
export async function createSpawnedSession(options) {
  const {
    agentCtx, wsRegistry, preset, workspaceId,
    provider, model, reasoningEffort,
    permission, title,
  } = options
  const faces = detectFaces(agentCtx)
  if (!faces.presets || typeof faces.presets.resolve !== 'function') {
    throw new Error('agentPresets face unavailable — refusing to spawn without a resolvable preset (a bare default shell is a bug; check the dsh version)')
  }
  if (!preset) throw new Error('no preset: pass preset or set spawn.preset in config')

  const resolved = await faces.presets.resolve(preset)
  if (!resolved?.id) throw new Error(`preset "${preset}" did not resolve to a preset id`)

  let workspacePath
  const cosmetic = []
  if (workspaceId) {
    const ws = wsRegistry?.get?.(workspaceId)
    if (!ws?.path) throw new Error(`workspace "${workspaceId}" not found in the workspace registry`)
    workspacePath = ws.path
  }

  const sessionId = `session-${crypto.randomUUID()}`
  const agentOptions = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
  const handle = await agentCtx.agents.create({
    sessionId,
    meta: {
      ...(workspacePath ? { cwd: workspacePath } : {}),
      agentPreset: resolved.id,
    },
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    // Preset composition (mirrors apiproxy's composeAgent): resolve BEFORE
    // creation (the header snapshots meta), mount inside setup.
    setup: async (ctx) => {
      if (typeof faces.presets.mount === 'function') await faces.presets.mount(ctx, resolved.id)
    },
  })
  const finalSessionId = handle?.agent?.id ?? sessionId

  // Workspace attach — puts the session in the GUI project session list
  // (registry ws.attachSession, the taskboard execution pattern).
  if (workspaceId) {
    try {
      const ws = wsRegistry?.get?.(workspaceId)
      if (typeof ws?.attachSession !== 'function') throw new Error('workspace has no attachSession')
      await ws.attachSession(finalSessionId)
    } catch (e) { cosmetic.push(`attach: ${e?.message}`) }
  }
  // Title — pins the session-list entry (user-sourced rename, best effort).
  if (title) {
    try {
      const session = faces.sessions?.get?.(finalSessionId)
      if (session && typeof faces.sessionTitle?.rename === 'function') faces.sessionTitle.rename(session, title)
    } catch (e) { cosmetic.push(`rename: ${e?.message}`) }
  }
  // Permission — capability-gated and FAIL-CLOSED: a requested permission
  // that cannot be applied must not leave a session with a different policy
  // than the caller asked for. The caller disposes on permissionFailed.
  let permissionFailed = null
  if (permission) {
    try {
      const session = faces.sessions?.get?.(finalSessionId)
      if (!session || typeof faces.permissionPresets?.set !== 'function') {
        throw new Error('permissionPresets/sessions face unavailable — cannot apply requested permission')
      }
      faces.permissionPresets.set(session, permission)
    } catch (e) {
      permissionFailed = e?.message ?? String(e)
    }
  }

  return { sessionId: finalSessionId, preset: resolved.id, workspacePath, cosmetic, permissionFailed, handle }
}

// Dispose a session whose post-create steps failed badly enough that the
// caller wants it gone (resume gives an owned handle whose dispose()
// unregisters the agent — the only in-process path; mirrors mc-runtime).
export async function disposeSpawnedSession(agentCtx, sessionId, log = () => {}) {
  try {
    const handle = await agentCtx.agents.resume({ resumeSessionId: sessionId })
    await handle.dispose()
    log(`[agents-in-the-loop] disposed spawned session ${sessionId}`)
    return true
  } catch (e) {
    log(`[agents-in-the-loop] dispose failed for ${sessionId}: ${e?.message} — left for a human`)
    return false
  }
}
