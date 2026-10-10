import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCatalog } from '../lib/catalog.js'
import { apply } from '../lib/index.js'

test('catalog projects registry choices without returning service configuration', async () => {
  const services = {
    llm: { listProviders: () => [{ id: 'provider', name: 'Configured provider', apiKey: 'omit' }],
      listModels: async () => [{ id: 'model', name: 'Configured model', privateConfig: 'omit' }] },
    agentPresets: { list: async () => ({ ok: true, value: { presets: [{ id: 'standard', name: 'Standard', prompt: 'omit' }] } }) },
  }
  const result = await readCatalog({ agentCtx: { get: (name) => services[name] },
    wsRegistry: { list: () => [{ id: 'ws', title: 'Project', path: '/project', internal: 'omit' }] } })
  assert.deepEqual(result.models, [{ provider: 'provider', model: 'model', label: 'Configured provider / Configured model' }])
  assert.deepEqual(result.presets, [{ id: 'standard', title: 'Standard' }])
  assert.deepEqual(result.workspaces, [{ id: 'ws', title: 'Project', path: '/project' }])
  assert.deepEqual(result.errors, {})
  assert.ok(!JSON.stringify(result).includes('omit'))
})

test('catalog retains working registries and reports failed providers without leaking error details', async () => {
  const llm = { listProviders: () => [{ id: 'working' }, { id: 'failed' }],
    listModels: async (id) => { if (id === 'failed') throw new Error('private upstream detail'); return [{ id: 'model' }] } }
  const result = await readCatalog({ wsCtx: { get: (name) => name === 'llm' ? llm : undefined } })
  assert.equal(result.models[0].provider, 'working')
  assert.ok(result.errors.models)
  assert.ok(result.errors.presets)
  assert.ok(result.errors.workspaces)
  assert.ok(!JSON.stringify(result).includes('private upstream detail'))
})

test('catalog route rejects remote callers and mutations before accessing registries', async () => {
  const routes = new Map()
  let reads = 0
  const ctx = {
    get: () => undefined,
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    inject: (_, cb) => cb({ workspaceRegistry: { list: () => { reads++; return [] } },
      inject: (_, inner) => inner({ agents: { get: () => undefined, list: () => [] } }) }),
  }
  apply(ctx, { contacts: { enabled: false }, sessionMessage: { enabled: false }, mcp: { inbox: { enabled: false } } })
  const route = routes.get('/api/agents-in-the-loop/catalog')
  for (const [method, address, expected] of [['GET', '192.0.2.1', 403], ['POST', '127.0.0.1', 405]]) {
    const req = Readable.from([])
    req.method = method; req.socket = { remoteAddress: address }
    let status
    await route.handler(req, { writeHead: (code) => { status = code }, end() {} })
    assert.equal(status, expected)
  }
  assert.equal(reads, 0)
  const req = Readable.from([])
  req.method = 'GET'; req.socket = { remoteAddress: '127.0.0.1' }
  let status, payload
  await route.handler(req, { writeHead: (code) => { status = code }, end: (data) => { payload = JSON.parse(data) } })
  assert.equal(status, 200)
  assert.equal(reads, 1)
  assert.deepEqual(payload.workspaces, [])
  assert.ok(payload.errors.models)
})

test('contact API persists a registered workspace, renames, clears it, and rejects arbitrary paths', async () => {
  const routes = new Map()
  const ctx = {
    get: () => undefined,
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    inject: (_, cb) => cb({ workspaceRegistry: { list: () => [{ id: 'ws', path: '/project' }] },
      inject: (_, inner) => inner({ agents: { get: () => undefined, list: () => [] } }) }),
  }
  apply(ctx, { contacts: { enabled: false, file: join(mkdtempSync(join(tmpdir(), 'aitl-contact-cwd-')), 'contacts.json') },
    sessionMessage: { enabled: false }, mcp: { inbox: { enabled: false } } })
  const route = routes.get('/api/agents-in-the-loop/contacts')
  async function request(method, body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method; req.socket = { remoteAddress: '127.0.0.1' }
    let status, payload
    await route.handler(req, { writeHead: (code) => { status = code }, end: (data) => { payload = JSON.parse(data) } })
    return { status, payload }
  }
  const created = await request('POST', { name: 'worker', sessionId: 'session-1234567890', cwd: '/project' })
  assert.equal(created.status, 200)
  assert.equal((await request('GET')).payload.contacts[0].cwd, '/project')
  assert.equal((await request('PUT', { name: 'worker', cwd: '/not-registered' })).status, 400)
  assert.equal((await request('GET')).payload.contacts[0].cwd, '/project')
  assert.equal((await request('PUT', { name: 'worker', cwd: 42 })).status, 400)
  assert.equal((await request('PUT', { name: 'worker', rename: 'renamed', cwd: '' })).status, 200)
  const saved = (await request('GET')).payload.contacts[0]
  assert.equal(saved.name, 'renamed')
  assert.equal(saved.cwd, undefined)
})
