// spawn_session tests with a mock cordis ctx (no DSH needed):
//   node --test test/spawn.test.mjs
// Covers: kill-switch, happy path (create faces called with exact pins,
// contacts + journal + first message), preset/workspace/permission gating,
// seat cap, model/provider arg rejection, duplicate name, create-failure
// (nothing registered), post-create cosmetic degradation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function makeCtx({ agentsExtra = {}, faces = {}, config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aitl-spawn-'))
  const contactsFile = join(dir, 'contacts.json')
  writeFileSync(contactsFile, JSON.stringify({ version: 1, contacts: {} }))
  const stateFile = join(dir, 'spawned.jsonl')
  const tools = {}
  const agents = {
    created: [],
    get: (id) => agentsExtra[id] ?? null,
    list: () => Object.values(agentsExtra),
    create: async (opts) => {
      agents.created.push(opts)
      const id = opts.sessionId
      agentsExtra[id] = {
        id, status: 'idle', calls: [],
        steer: (m) => {
          if (agents.failSteer) throw new Error('steer failed')
          agentsExtra[id].calls.push(['steer', m])
        },
        followup: () => {}, inject: () => {},
        ctx: { inject: () => {} },
      }
      return { agent: agentsExtra[id], dispose: async () => { agents.disposed.push(id) } }
    },
    resume: async ({ resumeSessionId }) => ({
      dispose: async () => { agents.disposed.push(resumeSessionId) },
    }),
    disposed: [],
  }
  const ctx = {
    inject: (_deps, fn) => fn(ctx),
    get: (name) => {
      if (name === 'tools') return { register: (t) => { tools[t.name] = t; return () => {} } }
      if (name === 'agentPresets') return faces.presets
      if (name === 'workspaces') return faces.workspaces
      if (name === 'sessions') return faces.sessions
      if (name === 'sessionTitle') return faces.sessionTitle
      if (name === 'permissionPresets') return faces.permissionPresets
      return undefined
    },
    on: () => () => {},
    effect: () => {},
    agents,
    workspaceRegistry: faces.wsRegistry,
    webServer: { register: () => () => {} },
  }
  apply(ctx, { ...config, contacts: { file: contactsFile }, spawn: { ...(config.spawn ?? {}), stateFile } })
  return { tools, agents, contactsFile, stateFile }
}

const defaultFaces = {
  presets: {
    resolve: async (id) => ({ id: `preset-${id}` }),
    mount: async () => {},
  },
  sessions: { get: () => ({}) },
  sessionTitle: { rename: () => {} },
  permissionPresets: { set: () => {} },
}

const baseConfig = { spawn: { enabled: true, preset: 'engineer' } }
const spawn = (tools, from, args) =>
  tools.spawn_session.execute(args, { agent: { id: from } }).then((r) => JSON.parse(r.text))

test('kill-switch off: tool not registered', () => {
  const { tools } = makeCtx({ config: { spawn: { enabled: false } }, faces: defaultFaces })
  assert.equal(tools.spawn_session, undefined)
})

test('kill-switch on: tool registered', () => {
  const { tools } = makeCtx({ config: baseConfig, faces: defaultFaces })
  assert.ok(tools.spawn_session)
})

test('happy path: create pinned, contact registered, journal, first message steered', async () => {
  const { tools, agents, contactsFile, stateFile } = makeCtx({ config: baseConfig, faces: defaultFaces })
  const r = await spawn(tools, 'session-leader', { name: 'Worker', message: 'do the thing' })
  assert.equal(r.ok, true, r.error)
  assert.equal(agents.created.length, 1)
  const opts = agents.created[0]
  assert.equal(opts.meta.agentPreset, 'preset-engineer') // preset pin resolved
  assert.equal(opts.agentOptions.provider, 'zai-coding-cn') // model pin from config
  assert.equal(opts.agentOptions.model, 'glm-5.3-flash')
  assert.equal(typeof opts.setup, 'function')
  await opts.setup({}) // mount callable
  assert.equal(opts.permission, undefined) // no workspace/permission face calls
  const stored = JSON.parse(readFileSync(contactsFile, 'utf-8')).contacts
  assert.equal(stored.worker.sessionId, r.sessionId)
  assert.ok(stored.worker.tags.includes('spawned'))
  assert.ok(existsSync(stateFile))
  assert.match(readFileSync(stateFile, 'utf-8'), /"action":"spawn"/)
  const agent = agents.get(r.sessionId)
  assert.equal(agent.calls.length, 1)
  assert.equal(agent.calls[0][0], 'steer')
  assert.match(agent.calls[0][1].content[0].text, /do the thing/)
})

test('duplicate name rejected before any face call', async () => {
  const { tools, agents, contactsFile } = makeCtx({ config: baseConfig, faces: defaultFaces })
  writeFileSync(contactsFile, JSON.stringify({ version: 1, contacts: { taken: { sessionId: 'session-x' } } }))
  const r = await spawn(tools, 'session-leader', { name: 'taken', message: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.error, /already exists/)
  assert.equal(agents.created.length, 0)
})

test('seat cap reached: rejected, no create', async () => {
  const worker = { id: 'session-abcdef1234', status: 'idle', steer: () => {}, inject: () => {}, followup: () => {}, ctx: { inject: () => {} } }
  const { tools, agents } = makeCtx({
    config: { ...baseConfig, spawn: { ...baseConfig.spawn, maxSessions: 1 }, mc: { excludedContacts: ['dsh-maintainer'] } },
    faces: defaultFaces,
    agentsExtra: { 'session-abcdef1234': worker },
  })
  // seat counted from contacts store: register one live contact
  const r0 = await tools.contacts.execute({ action: 'add', name: 'occupied', sessionId: 'session-abcdef1234' }, { agent: { id: 'session-leader' } }).then((x) => JSON.parse(x.text))
  assert.equal(r0.ok, true, r0.error)
  const r = await spawn(tools, 'session-leader', { name: 'worker2', message: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.error, /seat cap 1/)
  assert.equal(agents.created.length, 0)
})

test('model/provider tool args rejected with config pointer', async () => {
  const { tools, agents } = makeCtx({ config: baseConfig, faces: defaultFaces })
  const r = await spawn(tools, 'session-leader', { name: 'w', message: 'm', model: 'gpt-6-luna' })
  assert.equal(r.ok, false)
  assert.match(r.error, /spawn\.provider\/spawn\.model/)
  assert.equal(agents.created.length, 0)
})

test('preset not in allowlist rejected', async () => {
  const { tools, agents } = makeCtx({
    config: { spawn: { enabled: true, allowedPresets: ['engineer'] } },
    faces: defaultFaces,
  })
  const r = await spawn(tools, 'session-leader', { name: 'w', message: 'm', preset: 'scout' })
  assert.equal(r.ok, false)
  assert.match(r.error, /allowedPresets/)
  assert.equal(agents.created.length, 0)
})

test('no preset anywhere: explicit error, never a bare shell', async () => {
  const { tools, agents } = makeCtx({ config: { spawn: { enabled: true } }, faces: defaultFaces })
  const r = await spawn(tools, 'session-leader', { name: 'w', message: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.error, /no preset/)
  assert.equal(agents.created.length, 0)
})

test('workspace allowlist enforced; allowed workspace pins cwd', async () => {
  const { tools, agents } = makeCtx({
    config: { ...baseConfig, spawn: { ...baseConfig.spawn, workspaces: ['ws-1'] } },
    faces: { ...defaultFaces, wsRegistry: { resolveByPath: async () => undefined, get: (id) => (id === 'ws-1' ? { id, path: '/tmp/ws-ws-1', attachSession: async () => {} } : undefined) } },
  })
  const bad = await spawn(tools, 'session-leader', { name: 'w1', message: 'm', workspaceId: 'ws-other' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /allowlist/)
  const good = await spawn(tools, 'session-leader', { name: 'w2', message: 'm', workspaceId: 'ws-1' })
  assert.equal(good.ok, true, good.error)
  assert.equal(agents.created.at(-1).meta.cwd, '/tmp/ws-ws-1')
})

test('create failure (preset resolve throws): clean error, nothing registered', async () => {
  const { tools, agents, contactsFile } = makeCtx({
    config: baseConfig,
    faces: { ...defaultFaces, presets: { resolve: async () => { throw new Error('unknown preset') }, mount: async () => {} } },
  })
  const r = await spawn(tools, 'session-leader', { name: 'w', message: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.error, /spawn failed: unknown preset/)
  assert.equal(agents.created.length, 0)
  assert.equal(Object.keys(JSON.parse(readFileSync(contactsFile, 'utf-8')).contacts).length, 0)
})

test('agentPresets face missing: refused (no bare default shell)', async () => {
  const { tools, agents } = makeCtx({ config: baseConfig, faces: {} })
  const r = await spawn(tools, 'session-leader', { name: 'w', message: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.error, /agentPresets face unavailable/)
  assert.equal(agents.created.length, 0)
})

test('permission arg applied via permissionPresets when faces exist', async () => {
  let setArgs = null
  const { tools, agents } = makeCtx({
    config: { ...baseConfig, spawn: { ...baseConfig.spawn, allowedPermissions: ['read-only', 'workspace-write'] } },
    faces: { ...defaultFaces, permissionPresets: { set: (s, p) => { setArgs = p } } },
  })
  const r = await spawn(tools, 'session-leader', { name: 'w', message: 'm', permission: 'workspace-write' })
  assert.equal(r.ok, true, r.error)
  assert.equal(setArgs, 'workspace-write')
  assert.ok(agents.created.length === 1)
})

test('caller workspace auto-attach: no workspaceId → exec header cwd resolved and child attached', async () => {
  const attached = []
  const faces = {
    ...defaultFaces,
    wsRegistry: {
      resolveByPath: async (cwd) => (cwd === '/tmp/ws-ws-1' ? { id: 'ws-1' } : undefined),
      get: (id) => (id === 'ws-1' ? { id, path: '/tmp/ws-ws-1', attachSession: async (sid) => { attached.push([id, sid]) } } : undefined),
    },
  }
  const { tools, agents } = makeCtx({ config: { ...baseConfig, spawn: { ...baseConfig.spawn, workspaces: ['ws-2'] } }, faces })
  // spawn() helper passes exec.agent = { id } only; call execute directly with the session header
  const r = JSON.parse((await tools.spawn_session.execute(
    { name: 'w-auto', message: 'm' },
    { agent: { id: 'session-leader', session: { header: { cwd: '/tmp/ws-ws-1' } } } },
  ).then((x) => x.text)))
  assert.equal(r.ok, true, r.error)
  assert.equal(r.workspaceAuto, true)
  assert.equal(r.workspaceId, 'ws-1')
  assert.equal(agents.created[0].meta.cwd, '/tmp/ws-ws-1')
  assert.equal(attached.length, 1)
})

test('no caller header and no workspaceId: still spawns, ungrouped (explicit null)', async () => {
  const { tools, agents } = makeCtx({ config: baseConfig, faces: defaultFaces })
  const r = await spawn(tools, 'session-unknown', { name: 'w-nogroup', message: 'm' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.workspaceId, null)
  assert.equal(r.workspaceAuto, false)
  assert.equal(agents.created[0].meta.cwd, undefined)
})

test('requested permission that cannot be applied: fail closed, session disposed', async () => {
  const { tools, agents } = makeCtx({
    config: { ...baseConfig, spawn: { ...baseConfig.spawn, allowedPermissions: ['read-only', 'workspace-write'] } },
    faces: { ...defaultFaces, permissionPresets: undefined, sessions: undefined },
  })
  const r = await spawn(tools, 'session-leader', { name: 'w-perm', message: 'm', permission: 'workspace-write' })
  assert.equal(r.ok, false)
  assert.match(r.error, /could not be applied/)
  assert.ok(agents.disposed.includes(r.sessionId === undefined ? agents.disposed[0] : agents.disposed[0]))
})

test('failed first-message delivery: rollback — disposed, contact removed', async () => {
  const { tools, agents, contactsFile } = makeCtx({ config: baseConfig, faces: defaultFaces })
  agents.failSteer = true
  const r = await spawn(tools, 'session-leader', { name: 'w-del', message: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.error, /first-message delivery failed/)
  assert.ok(agents.disposed.length === 1)
  const stored = JSON.parse(readFileSync(contactsFile, 'utf-8')).contacts
  assert.equal(stored['w-del'], undefined)
})

test('pinned model not in spawn.allowedModels: config error, no create', async () => {
  const { tools, agents } = makeCtx({
    config: { ...baseConfig, spawn: { ...baseConfig.spawn, allowedModels: ['other/model'] } },
    faces: defaultFaces,
  })
  const r = await spawn(tools, 'session-leader', { name: 'w-model', message: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.error, /not in spawn.allowedModels/)
  assert.equal(agents.created.length, 0)
})
