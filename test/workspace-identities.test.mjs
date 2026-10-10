import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'
import { openStore, loadContactsFromDb, saveContactsToDb, enqueueMessage, pollInbox, peekMessage, ackMessage, hasInbox, migrateContactsFromJson } from '../lib/inbox.js'

test('v2 migration recovers workspace identities and supports durable replies', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aitl-v2-')), 'store.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '2');
    CREATE TABLE contacts (name TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      label TEXT, tags TEXT, note TEXT, kind TEXT, cwd TEXT, identity INTEGER,
      created_at TEXT, updated_at TEXT);`)
  old.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'codex', 'session-existing', '', '[]', 'workspace=ws-1 preset=identity permission=read-only | orphan — flag-only, no auto-dispose',
    'local', '/ws/one', 1, 'created', 'updated',
  )
  old.close()
  const db = openStore(file)
  const c = loadContactsFromDb(db).codex
  assert.equal(c.workspaceId, 'ws-1')
  assert.equal(c.identityMeta.permission, 'read-only')
  assert.equal(c.identityMeta.preset, 'identity')
  assert.equal(c.kind, 'external')
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3')
  const queued = enqueueMessage(db, { recipient: c.sessionId, sender: 'maintainer', body: 'reply' })
  assert.equal(queued.ok, true)
  // Re-open the same on-disk database through a second connection.
  const reopened = new DatabaseSync(file)
  assert.equal(loadContactsFromDb(reopened).codex.workspaceId, 'ws-1')
  assert.equal(pollInbox(reopened, { recipient: c.sessionId }).messages[0].id, queued.id)
  assert.equal(peekMessage(reopened, { recipient: 'session-other', id: queued.id }).ok, false)
  assert.equal(ackMessage(reopened, { recipient: c.sessionId, id: queued.id }).ok, true)
  reopened.close()
})

test('SQLite and JSON import preserve identity metadata and deny ordinary local mailboxes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitl-metadata-'))
  const db = openStore(join(dir, 'store.db'))
  const contacts = {
    codex: { sessionId: 'session-real', identity: true, workspaceId: 'ws-1', cwd: '/ws/one',
      identityMeta: { preset: 'identity', permission: 'read-only', provisionedAt: 'timestamp' } },
    worker: { sessionId: 'session-worker', identity: false },
  }
  const file = join(dir, 'contacts.json')
  writeFileSync(file, JSON.stringify({ contacts }))
  assert.equal(migrateContactsFromJson(db, file).imported, 2)
  saveContactsToDb(db, loadContactsFromDb(db))
  const reloaded = loadContactsFromDb(db)
  assert.deepEqual(reloaded.codex.identityMeta, contacts.codex.identityMeta)
  assert.equal(reloaded.codex.workspaceId, 'ws-1')
  assert.equal(reloaded.codex.kind, 'external')
  assert.equal(hasInbox(db, reloaded.codex.sessionId), true)
  assert.equal(hasInbox(db, reloaded.worker.sessionId), false)
  assert.equal(enqueueMessage(db, { recipient: reloaded.worker.sessionId, sender: 'codex', body: 'no' }).ok, false)
  assert.equal(pollInbox(db, { recipient: reloaded.worker.sessionId }).ok, false)
})

async function assertDisabledInboxResponse() {
  const routes = new Map()
  const ctx = {
    get: () => undefined,
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    inject: (_deps, callback) => callback({
      workspaceRegistry: { list: () => [] },
      inject: (_deps2, cb) => cb({ agents: { get: () => undefined, list: () => [] } }),
    }),
  }
  apply(ctx, { contacts: { enabled: false }, sessionMessage: { enabled: false }, mcp: { inbox: { enabled: false } } })
  const req = Readable.from([])
  req.url = '/api/agents-in-the-loop/inbox?format=json'
  req.method = 'GET'
  req.socket = { remoteAddress: '127.0.0.1' }
  let status, payload
  await routes.get('/api/agents-in-the-loop/inbox').handler(req, {
    writeHead: (code) => { status = code }, end: (data) => { payload = data },
  })
  assert.equal(status, 503)
  assert.equal(JSON.parse(payload).code, 'inbox_disabled')
}

test('disabled inbox exposes a structured JSON response instead of a missing route', assertDisabledInboxResponse)

test('runtime enablement, live provisioning policy and all reply paths work with the SQLite store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aitl-host-'))
  const tools = new Map()
  const routes = new Map()
  const agents = new Map()
  const sessions = new Map()
  const creations = []
  const attachments = []
  let directDeliveries = 0
  const workspace = { path: '/ws/one', attachSession: async (sid) => { attachments.push(sid) } }
  const faces = {
    agentPresets: { resolve: async (id) => ({ id }), mount: async () => {} },
    sessions: { get: (sid) => sessions.get(sid) },
    permissionPresets: { set: (session, permission) => { session.permission = permission } },
  }
  const agentCtx = {
    get: (name) => faces[name],
    agents: {
      get: (sid) => agents.get(sid),
      list: () => [...agents.values()],
      create: async (options) => {
        creations.push(options)
        const agent = { id: options.sessionId, status: 'idle', inject: async () => { directDeliveries++ } }
        agents.set(agent.id, agent)
        sessions.set(agent.id, {})
        return { agent }
      },
      resume: async ({ resumeSessionId }) => ({ agent: agents.get(resumeSessionId), dispose: async () => { agents.delete(resumeSessionId) } }),
    },
  }
  const toolsService = { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) }, get: (name) => tools.get(name) }
  let dispose
  const ctx = {
    get: (name) => name === 'tools' ? toolsService : undefined,
    webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    inject: (_deps, callback) => callback({
      workspaceRegistry: { get: (id) => id === 'ws-1' ? workspace : undefined, list: () => [] },
      inject: (_deps2, cb) => { dispose = cb(agentCtx) },
    }),
  }
  apply(ctx, {
    contacts: { file: join(dir, 'contacts.json') },
    spawn: { stateFile: join(dir, 'journal.jsonl'), provider: 'test-provider', model: 'first' },
    identities: { enabled: false, preset: 'identity' },
    mcp: { inbox: { enabled: true, file: join(dir, 'store.db'), panel: { enabled: false } } },
  })
  t.after(() => dispose?.())
  async function route(path, method = 'GET', body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method
    req.url = path
    req.socket = { remoteAddress: '127.0.0.1' }
    let status, payload
    const res = { writeHead: (code) => { status = code }, end: (data) => { payload = data } }
    await routes.get(path.split('?')[0]).handler(req, res)
    return { status, body: JSON.parse(payload) }
  }
  const configPath = '/api/agents-in-the-loop/config'
  const identitiesPath = '/api/agents-in-the-loop/identities'
  // The JSON client API remains available when the standalone HTML panel is off.
  assert.equal((await route('/api/agents-in-the-loop/inbox?format=json')).status, 200)
  const disabledPanel = await route('/api/agents-in-the-loop/inbox')
  assert.equal(disabledPanel.status, 503)
  assert.equal(disabledPanel.body.code, 'inbox_panel_disabled')
  assert.equal((await route(identitiesPath)).status, 503)
  assert.equal((await route(configPath, 'POST', { path: 'identities.enabled', value: true })).status, 200)
  assert.equal((await route(configPath, 'POST', { path: 'mcp.inbox.enabled', value: false })).status, 409)
  assert.equal((await route(identitiesPath)).status, 200)
  const first = await route(identitiesPath, 'POST', { name: 'codex', workspaceId: 'ws-1' })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const sid = first.body.sessionId
  assert.equal(attachments.includes(sid), true)
  assert.equal(creations[0].meta.cwd, workspace.path)
  assert.equal((await route(identitiesPath)).body.identities[0].workspaceId, 'ws-1')
  await route(configPath, 'POST', { path: 'identities.model', value: 'second' })
  await route(configPath, 'POST', { path: 'identities.allowedPermissions', value: ['read-only', 'workspace-write'] })
  const second = await route(identitiesPath, 'POST', { name: 'codex-two', workspaceId: 'ws-1', permission: 'workspace-write' })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(creations[1].agentOptions.model, 'second')
  assert.equal(sessions.get(second.body.sessionId).permission, 'workspace-write')
  const callTool = async (name, args, sender) => JSON.parse((await tools.get(name).execute(args, { agent: { id: sender } })).text)
  const rawTarget = await callTool('session_message', { action: 'send', target: sid, message: 'raw id' }, 'maintainer')
  assert.equal(rawTarget.ok, false)
  assert.match(rawTarget.error, /Raw session-id targets are disabled/)
  const senders = [
    () => callTool('session_message', { action: 'send', target: 'codex', message: 'tool reply' }, 'maintainer'),
    () => callTool('inbox', { action: 'send', target: 'codex', message: 'inbox reply' }, 'maintainer'),
    async () => (await route('/api/agents-in-the-loop/inbox?format=json&op=send', 'POST', { target: 'codex', message: 'panel reply' })).body,
    async () => (await route('/api/agents-in-the-loop/message', 'POST', { from: 'maintainer', contact: 'codex', message: 'API reply' })).body,
  ]
  for (const send of senders) assert.equal((await send()).ok, true)
  assert.equal(directDeliveries, 0, 'replies must not wake the hidden identity session')
  const polled = await callTool('inbox', { action: 'poll' }, sid)
  assert.equal(polled.ok, true)
  assert.equal(polled.messages.length, 4)
  const id = polled.messages[0].id
  assert.equal((await callTool('inbox', { action: 'peek', id }, sid)).message.body, 'tool reply')
  assert.equal((await callTool('inbox', { action: 'ack', id }, second.body.sessionId)).ok, false)
  assert.equal((await callTool('inbox', { action: 'ack', id }, sid)).ok, true)
  assert.equal((await callTool('inbox', { action: 'poll' }, 'session-local')).ok, false)
  const panel = await route('/api/agents-in-the-loop/inbox?format=json&identity=codex')
  assert.equal(panel.body.externals.some((x) => x.sessionId === sid), true)
  assert.equal(panel.body.messages.length, 4)
  assert.equal((await route('/api/agents-in-the-loop/inbox?format=json&op=ack', 'POST', { identity: 'codex', id: polled.messages[1].id })).body.ok, true)
  const reprovisioned = await route(identitiesPath, 'PUT', { name: 'codex' })
  assert.equal(reprovisioned.status, 200, JSON.stringify(reprovisioned.body))
  assert.equal(reprovisioned.body.workspaceId, 'ws-1')
  assert.equal(sessions.get(reprovisioned.body.sessionId).permission, 'read-only')
  assert.equal((await route(configPath, 'POST', { path: 'identities.enabled', value: false })).status, 200)
  assert.equal((await route(identitiesPath)).status, 503)
  assert.equal((await route(configPath, 'DELETE', { path: 'identities.enabled' })).status, 200)
  assert.equal((await route(identitiesPath)).status, 503, 'clearing override restores disabled boot policy')
  // Reloading a disabled instance cannot reuse the module's previous open store.
  await assertDisabledInboxResponse()
})
