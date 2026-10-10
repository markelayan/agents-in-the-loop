// identity manager tests (v1.11) with in-memory mock faces (no node:sqlite):
//   node --test test/identity.test.mjs
// Covers: seatsUsed skips identity:true records; register (contact record
// shape, silent, duplicate-name refusal, cap 8, permission fail-closed
// abort, persist-fail dispose); re-provision order (NEW create → re-point →
// dispose old); lazy resume carrying agentOptions.provider/model +
// identity-resume journal; resolveExec fail-closed -32000; orphanSweep
// flag-only; deregister removes contact even when dispose fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityManager } from '../lib/identity.js'
import { seatsUsed } from '../lib/spawner.js'

function makeDeps({ config = {}, spawnImpl, resumeImpl, getImpl, disposeImpl, saveContactsImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aitl-identity-'))
  const stateFile = join(dir, 'spawned.jsonl')
  const contacts = {}
  const agentsExtra = {}
  const calls = { spawn: [], disposed: [], resumed: [], saved: [] }
  const agents = {
    get: (id) => (getImpl ? getImpl(id, agentsExtra) : agentsExtra[id] ?? null),
    resume: async (opts) => {
      calls.resumed.push(opts)
      if (resumeImpl) return resumeImpl(opts)
      const agent = { id: opts.resumeSessionId, status: 'idle' }
      agentsExtra[opts.resumeSessionId] = agent
      return { agent, dispose: async () => {} }
    },
  }
  const deps = {
    getContacts: () => contacts,
    saveContacts: (next) => {
      calls.saved.push(Object.keys(next))
      if (saveContactsImpl) return saveContactsImpl(next)
      // FULL-STATE write semantics (mirrors saveContacts in lib/index.js):
      // names absent from `next` are removed.
      for (const k of Object.keys(contacts)) if (!(k in next)) delete contacts[k]
      for (const [k, v] of Object.entries(next)) contacts[k] = v
    },
    spawn: async (opts) => {
      calls.spawn.push(opts)
      if (spawnImpl) return spawnImpl(opts)
      const sessionId = `session-${crypto.randomUUID()}`
      const agent = { id: sessionId, status: 'idle' }
      agentsExtra[sessionId] = agent
      return { sessionId, preset: opts.preset, workspacePath: `/ws/${opts.workspaceId}`, cosmetic: [], permissionFailed: null, handle: { agent, dispose: async () => {} } }
    },
    dispose: async (sessionId) => {
      if (disposeImpl) return disposeImpl(sessionId)
      calls.disposed.push(sessionId)
    },
    agents,
    wsRegistry: { get: (id) => (typeof id === 'string' && id.startsWith('ws-') ? { path: `/ws/${id}`, attachSession: async () => {} } : undefined) },
    stateFile,
    config,
    log: () => {},
  }
  return { deps, contacts, agents, agentsExtra, calls, stateFile, journalLines: () => (exists(stateFile) ? readFileSync(stateFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) }
}

function exists(p) { try { return readFileSync(p, 'utf8').length >= 0 } catch { return false } }

const baseConfig = { identities: { preset: 'aitl-identity' }, spawn: { provider: 'zai-coding-cn', model: 'glm-5.3-flash' } }

test('missing identity preset refuses before spawning rather than inventing a preset', async () => {
  const t = makeDeps()
  const r = await createIdentityManager(t.deps).register('codex', 'ws-1')
  assert.equal(r.ok, false)
  assert.match(r.error, /identity preset required/)
  assert.equal(t.calls.spawn.length, 0)
})

test('seatsUsed skips contacts flagged identity:true', () => {
  const agents = { get: (id) => (id === 'session-live' ? { id } : null) }
  const contacts = {
    human: { sessionId: 'session-live' },
    'identity-a': { sessionId: 'session-dead', identity: true },
    excluded: { sessionId: 'session-live' },
  }
  assert.equal(seatsUsed({ contacts, agentCtx: { agents }, excludedContacts: ['excluded'] }), 1)
})

test('register creates the contact record and journals — silent provisioning', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const r = await mgr.register('codex-trading', 'ws-8008')
  assert.equal(r.ok, true)
  const c = t.contacts['codex-trading']
  assert.equal(c.identity, true)
  assert.equal(c.kind, 'external')
  assert.equal(c.workspaceId, 'ws-8008')
  assert.equal(c.cwd, '/ws/ws-8008')
  assert.equal(c.tags.includes('aitl-identity'), true)
  assert.equal(c.identityMeta.permission, 'read-only')
  assert.equal(c.identityMeta.preset, 'aitl-identity')
  assert.match(c.note, /workspace=ws-8008/)
  // spawn pins: preset, permission read-only, model pair, title = name
  const spawnCall = t.calls.spawn[0]
  assert.equal(spawnCall.preset, 'aitl-identity')
  assert.equal(spawnCall.permission, 'read-only')
  assert.equal(spawnCall.provider, 'zai-coding-cn')
  assert.equal(spawnCall.model, 'glm-5.3-flash')
  assert.equal(spawnCall.title, 'codex-trading')
  // journal has identity-register
  assert.equal(t.journalLines().some((e) => e.action === 'identity-register' && e.name === 'codex-trading'), true)
})

test('register refuses to hijack an existing contact name', async () => {
  const t = makeDeps({ config: baseConfig })
  t.contacts.existing = { sessionId: 'session-x', label: 'human contact' }
  const mgr = createIdentityManager(t.deps)
  const r = await mgr.register('existing', 'ws-1')
  assert.equal(r.ok, false)
  assert.match(r.error, /already exists/)
  assert.equal(t.calls.spawn.length, 0) // nothing provisioned
})

test('register refuses beyond maxIdentities 8 (owner decision)', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  for (let i = 0; i < 8; i++) {
    const r = await mgr.register(`id-${i}`, `ws-${i}`)
    assert.equal(r.ok, true, `register ${i}`)
  }
  const r = await mgr.register('id-overflow', 'ws-x')
  assert.equal(r.ok, false)
  assert.match(r.error, /cap 8 reached/)
  assert.equal(t.calls.spawn.length, 8)
})

test('register refuses permissions outside the allowlist (read-only day-one)', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const r = await mgr.register('codex', 'ws-1', { permission: 'workspace-write' })
  assert.equal(r.ok, false)
  assert.match(r.error, /allowedPermissions/)
  assert.equal(t.calls.spawn.length, 0)
  const ok = await mgr.register('codex', 'ws-1')
  assert.equal(ok.ok, true)
  assert.equal(t.contacts.codex.identityMeta.permission, 'read-only')
})

test('permission apply failure aborts provisioning and disposes (fail-closed)', async () => {
  const t = makeDeps({
    config: baseConfig,
    spawnImpl: async () => ({ sessionId: 'session-permfail', permissionFailed: 'permissionPresets face unavailable' }),
  })
  const mgr = createIdentityManager(t.deps)
  const r = await mgr.register('codex', 'ws-1')
  assert.equal(r.ok, false)
  assert.match(r.error, /permission apply failed/)
  assert.deepEqual(t.calls.disposed, ['session-permfail'])
  assert.equal(t.contacts.codex, undefined)
})

test('persist failure disposes the new session — no unregistered zombies', async () => {
  const t = makeDeps({
    config: baseConfig,
    saveContactsImpl: () => { throw new Error('db locked') },
  })
  const mgr = createIdentityManager(t.deps)
  const r = await mgr.register('codex', 'ws-1')
  assert.equal(r.ok, false)
  assert.match(r.error, /persist failed/)
  assert.equal(t.calls.disposed.length, 1)
})

test('re-provision order: NEW session created → contact re-pointed → THEN old disposed', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const first = await mgr.register('codex', 'ws-old')
  assert.equal(first.ok, true)
  const oldSessionId = first.sessionId
  const events = []
  // instrument the order via wrappers
  const origSpawn = t.deps.spawn
  const origSave = t.deps.saveContacts
  const origDispose = t.deps.dispose
  t.deps.spawn = async (o) => { const r = await origSpawn(o); events.push('spawn'); return r }
  t.deps.saveContacts = (n) => { origSave(n); events.push('save') }
  t.deps.dispose = async (s) => { events.push(`dispose:${s}`); return origDispose(s) }
  const r = await mgr.reprovision('codex', { workspaceId: 'ws-new' })
  assert.equal(r.ok, true)
  assert.notEqual(r.sessionId, oldSessionId)
  const spawnIdx = events.indexOf('spawn')
  const saveIdx = events.indexOf('save')
  const disposeIdx = events.findIndex((e) => e.startsWith('dispose:'))
  assert.ok(spawnIdx < saveIdx, 'spawn before save')
  assert.ok(saveIdx < disposeIdx, 're-point before dispose old')
  assert.equal(events[disposeIdx], `dispose:${oldSessionId}`)
  const c = t.contacts.codex
  assert.equal(c.sessionId, r.sessionId)
  assert.equal(c.workspaceId, 'ws-new')
  assert.equal(c.cwd, '/ws/ws-new')
})

test('failed re-provision leaves the old identity fully working', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const first = await mgr.register('codex', 'ws-old')
  const oldSessionId = first.sessionId
  const r = await mgr.reprovision('codex', { workspaceId: 'does-not-exist' })
  assert.equal(r.ok, false)
  assert.match(r.error, /old identity untouched/)
  assert.equal(t.contacts.codex.sessionId, oldSessionId)
  assert.equal(t.calls.disposed.length, 0)
})

test('resolveExec returns the REAL live agent handle', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const r = await mgr.register('codex', 'ws-1')
  const live = await mgr.resolveExec('codex')
  assert.equal(live.ok, true)
  assert.equal(live.exec.agent.id, r.sessionId)
  assert.equal(live.exec.agent.session, undefined) // plain handle; header comes from the registry
})

test('resolveExec lazily resumes a dead session carrying agentOptions.provider/model + journals identity-resume', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const r = await mgr.register('codex', 'ws-1')
  delete t.agentsExtra[r.sessionId] // session dead
  const live = await mgr.resolveExec('codex')
  assert.equal(live.ok, true)
  assert.deepEqual(t.calls.resumed[0].agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3-flash' })
  assert.equal(live.exec.agent.id, r.sessionId)
  const journal = t.journalLines().filter((e) => e.action === 'identity-resume')
  assert.equal(journal.length, 1)
  assert.equal(journal[0].sessionId, r.sessionId)
})

test('resolveExec is fail-closed -32000 when dead and unresumable', async () => {
  const t = makeDeps({
    config: baseConfig,
    resumeImpl: async () => { throw new Error('session log missing') },
  })
  const mgr = createIdentityManager(t.deps)
  const reg = await mgr.register('codex', 'ws-1')
  delete t.agentsExtra[reg.sessionId] // session dead; resume will be attempted
  const r = await mgr.resolveExec('codex')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, -32000)
  assert.match(r.error.message, /unavailable/)
  // resumeIfDead:false → fail-closed without attempting resume
  const t2 = makeDeps({ config: { ...baseConfig, identities: { ...baseConfig.identities, resumeIfDead: false } } })
  const mgr2 = createIdentityManager(t2.deps)
  const r2reg = await mgr2.register('codex', 'ws-1')
  delete t2.agentsExtra[r2reg.sessionId] // session dead; resumeIfDead:false → no resume attempt
  const r2 = await mgr2.resolveExec('codex')
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, -32000)
  assert.equal(t2.calls.resumed.length, 0)
})

test('resolveExec refuses unknown / non-identity names', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  assert.equal((await mgr.resolveExec('nobody')).error.code, -32000)
  t.contacts.human = { sessionId: 'session-x' }
  assert.equal((await mgr.resolveExec('human')).error.code, -32000)
})

test('orphanSweep flags dead identity contacts — flag-only, no dispose', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const a = await mgr.register('alive', 'ws-1')
  const b = await mgr.register('dead', 'ws-2')
  delete t.agentsExtra[b.sessionId]
  const sweep = await mgr.orphanSweep()
  assert.deepEqual(sweep.flagged, ['dead'])
  assert.equal(t.contacts.dead.orphan, true)
  assert.match(t.contacts.dead.note, /orphan — flag-only, no auto-dispose/)
  assert.notEqual(t.contacts.alive.orphan, true)
  assert.equal(t.calls.disposed.length, 0) // never auto-dispose
  // a live identity never gets flagged
  assert.equal(t.contacts.alive.orphan, undefined)
  assert.equal(t.contacts['alive'].sessionId, a.sessionId)
  // sweep again — idempotent (no double flag, no re-journal)
  const sweep2 = await mgr.orphanSweep()
  assert.deepEqual(sweep2.flagged, [])
  // recovery: back live → flag cleared
  t.agentsExtra[b.sessionId] = { id: b.sessionId, status: 'idle' }
  await mgr.orphanSweep()
  assert.notEqual(t.contacts.dead.orphan, true)
})

test('deregister removes the contact even when dispose fails, and journals', async () => {
  const t = makeDeps({
    config: baseConfig,
    disposeImpl: async () => { throw new Error('resume failed') },
  })
  const mgr = createIdentityManager(t.deps)
  const r0 = await mgr.register('codex', 'ws-1')
  const r = await mgr.deregister('codex')
  assert.equal(r.ok, true)
  assert.equal(r.disposed, false)
  assert.equal(t.contacts.codex, undefined)
  assert.equal(t.journalLines().some((e) => e.action === 'identity-dispose' && e.disposed === false), true)
  assert.equal(t.journalLines().some((e) => e.action === 'identity-register' && e.sessionId === r0.sessionId), true)
})

test('status() and listAll() expose live/orphan state', async () => {
  const t = makeDeps({ config: baseConfig })
  const mgr = createIdentityManager(t.deps)
  const a = await mgr.register('alive', 'ws-1')
  const b = await mgr.register('dead', 'ws-2')
  delete t.agentsExtra[b.sessionId]
  await mgr.orphanSweep()
  const st = mgr.status()
  assert.equal(st.length, 2)
  const alive = st.find((s) => s.name === 'alive')
  const dead = st.find((s) => s.name === 'dead')
  assert.deepEqual([alive.live, alive.orphan, alive.workspaceId, alive.sessionId], [true, false, 'ws-1', a.sessionId])
  assert.deepEqual([dead.live, dead.orphan, dead.workspaceId], [false, true, 'ws-2'])
  assert.equal(mgr.listAll().map((x) => x.name).sort().join(','), 'alive,dead')
})
