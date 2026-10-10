// identity — v1.11 session-backed external identities (lib/identity.js).
// An aitl identity is a contact whose sessionId is a REAL hidden dsh session
// provisioned via the spawn machinery (createSpawnedSession — NOT duplicated
// here; the host wires `deps.spawn` to it). Pure lifecycle module: register /
// reprovision / deregister / lazy-resume resolveExec / orphan flagging.
//
// Owner decisions baked in (v1.11 plan §3/§4/§8):
//   - permission default read-only day-one (Q1)
//   - identities.model separate key defaulting to the spawn pair (Q2)
//   - silent provisioning — no orientation message (Q3)
//   - orphan = flag-only, never auto-dispose (Q4)
//   - no model-facing provisioning — this module is owner/API-facing only (Q5)
//   - session-log compaction = default dsh behavior, nothing special (Q7)

import { appendSpawnJournal } from './spawner.js'

const IDENTITY_TAG = 'aitl-identity'
const RESUME_JOURNAL_COOLDOWN_MS = 60_000

function resolveIdentityConfig(config) {
  const s = config?.identities ?? {}
  const spawn = config?.spawn ?? {}
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [])
  return {
    preset: typeof s.preset === 'string' && s.preset ? s.preset : 'aitl-identity',
    allowedPresets: strArr(s.allowedPresets), // empty = any resolvable
    // Q2: separate identities.model, defaulting to the spawn pair.
    provider: typeof s.provider === 'string' && s.provider ? s.provider : (spawn.provider ?? ''),
    model: typeof s.model === 'string' && s.model ? s.model : (spawn.model ?? ''),
    reasoningEffort: typeof s.reasoningEffort === 'string' && s.reasoningEffort ? s.reasoningEffort : spawn.reasoningEffort,
    allowedPermissions: strArr(s.allowedPermissions).length > 0 ? strArr(s.allowedPermissions) : ['read-only'],
    maxIdentities: Number.isInteger(s.maxIdentities) && s.maxIdentities > 0 ? s.maxIdentities : 8,
    resumeIfDead: s.resumeIfDead !== false,
  }
}

function identityContacts(contacts) {
  return Object.entries(contacts ?? {}).filter(([, c]) => c?.identity === true)
}

function failClosed(message) {
  return { code: -32000, message }
}

// ── createIdentityManager(deps) ─────────────────────────────────────────
// deps = {
//   db?, contactsFile?,          // journal bookkeeping context (informational)
//   getContacts: () => contactsObj,
//   saveContacts: (contactsObj) => void,
//   spawn: async (opts) => ({ sessionId, preset, workspacePath, cosmetic, permissionFailed, handle }),
//       — the createSpawnedSession path with agentCtx/wsRegistry pre-bound
//   dispose: async (sessionId) => void,   — disposeSpawnedSession path
//   agents: agentCtx.agents face — get / resume (+requireInitiator where present)
//   wsRegistry?,                 — optional, to resolve workspace path for contact.cwd
//   stateFile?,                  — spawn journal file
//   config?,                     — plugin config ({ identities, spawn })
//   log: (line) => void,
// }
export function createIdentityManager(deps) {
  const {
    getContacts, saveContacts, spawn, dispose, agents, wsRegistry, stateFile, config,
  } = deps ?? {}
  const log = deps?.log ?? (() => {})
  const cfg = resolveIdentityConfig(config)
  // Per-identity serialization for the resume journal rate-limit bookkeeping.
  const lastResumeJournal = new Map()

  function journal(action, entry) {
    if (!stateFile) return
    appendSpawnJournal(stateFile, { action, ...entry })
  }

  function workspacePath(workspaceId) {
    try { return wsRegistry?.get?.(workspaceId)?.path ?? null } catch { return null }
  }

  function buildContact(name, workspaceId, provisioned) {
    const path = workspacePath(workspaceId)
    return {
      sessionId: provisioned.sessionId,
      label: `${IDENTITY_TAG}: ${name}`,
      tags: [IDENTITY_TAG],
      note: `workspace=${workspaceId ?? ''} preset=${provisioned.preset} permission=${provisioned.permission}`,
      kind: 'external',
      identity: true,
      workspaceId: workspaceId ?? '',
      ...(path ? { cwd: path } : {}),
      identityMeta: {
        preset: provisioned.preset,
        permission: provisioned.permission,
        provisionedAt: new Date().toISOString(),
      },
    }
  }

  // Provision one hidden session. Throws on failure AFTER cleaning up.
  async function provisionSession({ name, workspaceId, permission }) {
    if (!workspaceId) throw new Error('workspaceId required — identities are per-workspace by design')
    const eff = resolveIdentityConfig(config) // live config, not the closure snapshot
    const wsPath = workspacePath(workspaceId)
    if (!wsPath) throw new Error(`workspace "${workspaceId}" not found in the workspace registry`)
    if (!eff.allowedPresets.includes(eff.preset) && eff.allowedPresets.length > 0) {
      throw new Error(`preset "${eff.preset}" not in identities.allowedPresets [${eff.allowedPresets.join(', ')}]`)
    }
    const perm = permission && String(permission).trim() ? String(permission).trim() : 'read-only'
    if (!eff.allowedPermissions.includes(perm)) {
      throw new Error(`permission "${perm}" not in identities.allowedPermissions [${eff.allowedPermissions.join(', ')}]`)
    }
    const created = await deps.spawn({
      preset: eff.preset,
      workspaceId,
      ...(eff.provider ? { provider: eff.provider } : {}),
      ...(eff.model ? { model: eff.model } : {}),
      ...(eff.reasoningEffort ? { reasoningEffort: eff.reasoningEffort } : {}),
      permission: perm,
      title: name,
    })
    if (created?.permissionFailed) {
      // Fail-closed: a permission that cannot be applied must not leave the
      // session behind (spawner abort-on-permissionFailed pattern).
      if (created.sessionId) { try { await deps.dispose(created.sessionId) } catch { /* best-effort */ } }
      throw new Error(`permission apply failed, provisioning aborted: ${created.permissionFailed}`)
    }
    if (!created?.sessionId) {
      if (created?.sessionId) { try { await deps.dispose(created.sessionId) } catch { /* best-effort */ } }
      throw new Error('spawn returned no sessionId')
    }
    return { ...created, permission: perm }
  }

  async function persist(next) {
    const snapshot = { ...(deps.getContacts?.() ?? {}) }
    Object.assign(snapshot, next)
    deps.saveContacts(snapshot) // throws → caller disposes (no unregistered zombies)
  }

  // ── register(name, workspaceId, { permission }) ────────────────────────
  async function register(name, workspaceId, { permission } = {}) {
    const contacts = deps.getContacts?.() ?? {}
    if (contacts[name]) {
      return { ok: false, error: `contact "${name}" already exists — identities never hijack an existing contact` }
    }
    const count = identityContacts(contacts).length
    const eff = resolveIdentityConfig(config)
    if (count >= eff.maxIdentities) {
      return { ok: false, error: `identity cap ${eff.maxIdentities} reached (${count} registered) — deregister one first` }
    }
    let provisioned
    try {
      provisioned = await provisionSession({ name, workspaceId, permission })
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) }
    }
    const contact = buildContact(name, workspaceId, provisioned)
    try {
      await persist({ [name]: contact })
    } catch (e) {
      try { await deps.dispose(provisioned.sessionId) } catch { /* best-effort */ }
      return { ok: false, error: `persist failed — session disposed (no unregistered zombies): ${e?.message}` }
    }
    // Silent provisioning: no message, no wake. The session exists dormant.
    journal('identity-register', { name, workspaceId, sessionId: provisioned.sessionId, permission: provisioned.permission, preset: provisioned.preset })
    log(`[agents-in-the-loop] identity "${name}" registered → ${provisioned.sessionId} (workspace ${workspaceId}, permission ${provisioned.permission})`)
    return { ok: true, name, sessionId: provisioned.sessionId, workspaceId, permission: provisioned.permission }
  }

  // ── re-provision(name, { workspaceId, permission }) ────────────────────
  // Owner decision §4.2: create NEW session FIRST, re-point the contact,
  // THEN dispose the old session — never the reverse (a failed create must
  // leave the old identity fully working).
  async function reprovision(name, { workspaceId, permission } = {}) {
    const contacts = deps.getContacts?.() ?? {}
    const old = contacts[name]
    if (old?.identity !== true) return { ok: false, error: `"${name}" is not an identity contact` }
    const wsId = workspaceId && String(workspaceId).trim() ? String(workspaceId).trim() : old.workspaceId
    let provisioned
    try {
      provisioned = await provisionSession({ name, workspaceId: wsId, permission: permission ?? old.identityMeta?.permission })
    } catch (e) {
      return { ok: false, error: `re-provision aborted (old identity untouched): ${e?.message}` }
    }
    const contact = buildContact(name, wsId, provisioned)
    try {
      await persist({ [name]: contact })
    } catch (e) {
      try { await deps.dispose(provisioned.sessionId) } catch { /* best-effort */ }
      return { ok: false, error: `persist failed during re-provision — new session disposed, old identity kept: ${e?.message}` }
    }
    if (old.sessionId && old.sessionId !== provisioned.sessionId) {
      try { await deps.dispose(old.sessionId) } catch { /* logged inside dispose */ }
    }
    journal('identity-reprovision', { name, workspaceId: wsId, sessionId: provisioned.sessionId, oldSessionId: old.sessionId })
    log(`[agents-in-the-loop] identity "${name}" re-provisioned → ${provisioned.sessionId}`)
    return { ok: true, name, sessionId: provisioned.sessionId, workspaceId: wsId }
  }

  // ── deregister(name) ───────────────────────────────────────────────────
  // §4.6: contact removed REGARDLESS of dispose outcome; a failed dispose
  // leaves the shell for a human (startup sweep flags it).
  async function deregister(name) {
    const contacts = deps.getContacts?.() ?? {}
    const contact = contacts[name]
    if (contact?.identity !== true) return { ok: false, error: `"${name}" is not an identity contact` }
    const snapshot = { ...contacts }
    delete snapshot[name]
    try {
      deps.saveContacts(snapshot)
    } catch (e) {
      return { ok: false, error: `persist failed — contact kept: ${e?.message}` }
    }
    let disposed = true
    try {
      await deps.dispose(contact.sessionId)
    } catch { disposed = false }
    journal('identity-dispose', { name, sessionId: contact.sessionId, disposed })
    log(`[agents-in-the-loop] identity "${name}" deregistered (${contact.sessionId}${disposed ? '' : ' — dispose failed, left for a human'})`)
    return { ok: true, name, disposed }
  }

  // ── resolveExec(name) — the REAL agent handle, or a fail-closed error ──
  // Live → use it. Dead + resumeIfDead → agents.resume carrying
  // agentOptions.provider/model (the {{model}} prompt-variable lesson:
  // resuming without a model route kills every subsequent turn).
  async function resolveExec(name) {
    const contact = (getContacts?.() ?? {})[name]
    if (!contact) return { ok: false, error: failClosed(`unknown identity "${name}"`) }
    if (contact.identity !== true) return { ok: false, error: failClosed(`"${name}" is not an identity contact`) }
    let agent = agents?.get?.(contact.sessionId)
    if (!agent) {
      const eff = resolveIdentityConfig(config)
      if (!eff.resumeIfDead) {
        return { ok: false, error: failClosed(`identity session ${contact.sessionId} is dead (resumeIfDead disabled)`) }
      }
      try {
        const agentOptions = {
          ...(eff.provider ? { provider: eff.provider } : {}),
          ...(eff.model ? { model: eff.model } : {}),
          ...(eff.reasoningEffort ? { reasoningEffort: eff.reasoningEffort } : {}),
        }
        const handle = await agents.resume({ resumeSessionId: contact.sessionId, agentOptions })
        agent = handle?.agent ?? handle
      } catch (e) {
        return { ok: false, error: failClosed(`identity session ${contact.sessionId} unavailable (resume failed: ${e?.message})`) }
      }
      if (!agent) return { ok: false, error: failClosed(`identity session ${contact.sessionId} unavailable (resume returned no agent)`) }
      // Belt-and-braces: re-verify the workspace attach after resume so the
      // memoir registry fallback (sessionId reverse-lookup) keeps resolving.
      if (contact.workspaceId) {
        try {
          const ws = wsRegistry?.get?.(contact.workspaceId)
          const sessions = typeof ws?.listSessions === 'function' ? await ws.listSessions() : null
          const attached = Array.isArray(sessions)
            ? sessions.some((s) => (typeof s === 'string' ? s : s?.id) === contact.sessionId)
            : true // face does not expose membership — skip (attach was done at provision)
          if (!attached && typeof ws?.attachSession === 'function') {
            await ws.attachSession(contact.sessionId)
            log(`[agents-in-the-loop] identity "${name}" re-attached to workspace ${contact.workspaceId} after resume`)
          }
        } catch { /* best-effort */ }
      }
      // Journal one 'identity-resume' line, rate-limited per session (60 s).
      const now = Date.now()
      const last = lastResumeJournal.get(contact.sessionId) ?? 0
      if (now - last >= RESUME_JOURNAL_COOLDOWN_MS) {
        lastResumeJournal.set(contact.sessionId, now)
        journal('identity-resume', { name, sessionId: contact.sessionId })
      }
      log(`[agents-in-the-loop] identity "${name}" lazily resumed ${contact.sessionId}`)
    }
    return { ok: true, exec: { agent } }
  }

  // ── status / listAll ───────────────────────────────────────────────────
  function listAll() {
    return identityContacts(deps.getContacts?.() ?? {}).map(([name, c]) => ({ name, ...c }))
  }

  function status() {
    return identityContacts(deps.getContacts?.() ?? {}).map(([name, c]) => ({
      name,
      sessionId: c.sessionId,
      workspaceId: c.workspaceId ?? '',
      live: Boolean(agents?.get?.(c.sessionId)),
      orphan: c.orphan === true,
    }))
  }

  // ── orphanSweep — flag-only, never auto-dispose (Q4) ───────────────────
  // Contacts with identity:true whose sessionId is NOT live get flagged.
  // Startup + hourly (host schedules; this module only sweeps).
  async function orphanSweep() {
    const contacts = deps.getContacts?.() ?? {}
    const flagged = []
    const next = {}
    for (const [name, c] of identityContacts(contacts)) {
      const live = Boolean(agents?.get?.(c.sessionId))
      const shouldBeOrphan = !live
      if (shouldBeOrphan && c.orphan !== true) {
        next[name] = {
          ...c,
          orphan: true,
          note: `${c.note ?? ''} | orphan — flag-only, no auto-dispose`.replace(/^\s*\|/, '').trim(),
        }
        flagged.push(name)
        journal('identity-orphan', { name, sessionId: c.sessionId })
      } else if (!shouldBeOrphan && c.orphan === true) {
        next[name] = { ...c, orphan: false, note: (c.note ?? '').replace(/\s*\|?\s*orphan — flag-only, no auto-dispose/g, '').trim() }
      }
    }
    if (Object.keys(next).length > 0) {
      try { await persist(next) } catch (e) { log(`[agents-in-the-loop] orphan sweep persist failed: ${e?.message}`) }
    }
    return { flagged, checked: identityContacts(contacts).length }
  }

  return { register, reprovision, deregister, resolveExec, status, listAll, orphanSweep }
}
