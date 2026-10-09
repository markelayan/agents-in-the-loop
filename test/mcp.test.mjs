import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMcpConfig, loadMcpKey, verifyMcpAuth, isLoopback, createMcpRouteLazy } from '../lib/mcp.js'
import { isLoopbackAddr } from '../lib/mcp-auth.js'

const tmp = mkdtempSync(join(tmpdir(), 'aitl-mcp-'))
const keyFile = join(tmp, 'aitl-mcp-key.json')
writeFileSync(keyFile, JSON.stringify({ key: 'aitl_' + 'a'.repeat(32) }))

const noopLog = () => {}
const json = (r) => JSON.parse(r.body)

function fakeRes() {
  const r = { statusCode: null, body: null, headersSent: false, ended: false }
  r.writeHead = (code) => { r.statusCode = code; r.headersSent = true }
  r.end = (b) => { r.body = b; r.ended = true }
  return r
}

function fakeReq({ method = 'POST', addr = '127.0.0.1', auth = null } = {}) {
  return {
    method,
    socket: { remoteAddress: addr },
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    on(ev, cb) { if (ev === 'data') this._data = cb; if (ev === 'end') this._end = cb },
  }
}

function makeToolsService(defs) {
  return { get: (name) => defs[name] }
}

describe('mcp config', () => {
  test('defaults: disabled, loopback, three tools', () => {
    const c = resolveMcpConfig({})
    assert.equal(c.enabled, false)
    assert.equal(c.path, '/api/agents-in-the-loop/mcp')
    assert.equal(c.callerId, 'session-mcp-external')
    assert.equal(c.allowNonLoopback, false)
    assert.deepEqual(c.tools, ['contacts', 'session_message', 'spawn_session'])
    assert.deepEqual(c.bridge, { enabled: false, allowedTools: [] })
  })
  test('tilde expansion and tool override', () => {
    const c = resolveMcpConfig({ mcp: { apiKeyFile: '~/.x.json', tools: ['contacts'] } })
    assert.ok(c.apiKeyFile.startsWith('/'))
    assert.deepEqual(c.tools, ['contacts'])
  })
})

describe('mcp auth', () => {
  test('key file load + bearer verify', () => {
    const key = loadMcpKey(keyFile)
    assert.ok(key?.startsWith('aitl_'))
    assert.equal(verifyMcpAuth(fakeReq({ auth: key }), key), true)
    assert.equal(verifyMcpAuth(fakeReq({ auth: 'wrong' }), key), false)
    assert.equal(verifyMcpAuth(fakeReq({}), key), false)
    assert.equal(verifyMcpAuth(fakeReq({ auth: key }), null), false) // no key file → locked
  })
  test('missing key file returns null (fail closed)', () => {
    assert.equal(loadMcpKey(join(tmp, 'nope.json')), null)
  })
  test('loopback detection', () => {
    assert.equal(isLoopbackAddr('127.0.0.1'), true)
    assert.equal(isLoopbackAddr('::1'), true)
    assert.equal(isLoopbackAddr('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddr('192.168.1.5'), false)
  })
})

describe('mcp route guards (no SDK needed)', () => {
  let route, writeJsonOut
  const writeJson = (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)) }
  const readBody = () => Promise.resolve({})
  route = createMcpRouteLazy({
    mcp: resolveMcpConfig({ mcp: { enabled: true, apiKeyFile: keyFile } }),
    log: noopLog,
    toolsService: makeToolsService({}),
    writeJson,
    readBody,
  })

  test('non-loopback rejected 403 before auth', async () => {
    const req = fakeReq({ addr: '192.168.1.5', auth: 'whatever' })
    const res = fakeRes()
    await route.handler(req, res)
    assert.equal(res.statusCode, 403)
  })
  test('missing key → 401 even from loopback', async () => {
    const r2 = createMcpRouteLazy({ mcp: resolveMcpConfig({ mcp: { apiKeyFile: join(tmp, 'nope.json') } }), log: noopLog, toolsService: makeToolsService({}), writeJson, readBody })
    const res = fakeRes()
    await r2.handler(fakeReq({}), res)
    assert.equal(res.statusCode, 401)
  })
  test('wrong bearer → 401', async () => {
    const res = fakeRes()
    await route.handler(fakeReq({ auth: 'bad' }), res)
    assert.equal(res.statusCode, 401)
  })
  test('GET rejected 405 (stateless, POST only)', async () => {
    const key = loadMcpKey(keyFile)
    const res = fakeRes()
    await route.handler(fakeReq({ method: 'GET', auth: key }), res)
    assert.equal(res.statusCode, 405)
  })
  test('valid initialize POST → 200 JSON-RPC result (or 503 when SDK absent)', async () => {
    const key = loadMcpKey(keyFile)
    const route2 = createMcpRouteLazy({
      mcp: resolveMcpConfig({ mcp: { enabled: true, apiKeyFile: keyFile } }),
      log: noopLog,
      toolsService: makeToolsService({}),
      writeJson,
      readBody: (req) => Promise.resolve(req._body ? JSON.parse(req._body) : {}),
    })
    const req = fakeReq({ auth: key })
    req._body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    const res = fakeRes()
    await route2.handler(req, res)
        assert.ok([200, 503].includes(res.statusCode))
    if (res.statusCode === 200) assert.ok(json(res).result)
    if (res.statusCode === 503) assert.equal(json(res).error.code, -32000)
  })
})

// SDK-present integration tests run only where the SDK resolves (live profile).
const sdkAvailable = await import('@modelcontextprotocol/sdk/server/index.js').then(() => true, () => false)
if (sdkAvailable) {
  test('tools/list over streamable-http returns exposed tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const { createServer } = await import('node:http')
    const defs = {
      contacts: {
        name: 'contacts', description: 'd', parameters: { type: 'object', properties: { action: { type: 'string' } } },
        execute: async () => ({ text: JSON.stringify({ ok: true, value: [] }) }),
      },
    }
    const route = createMcpRouteLazy({
      mcp: resolveMcpConfig({ mcp: { enabled: true, apiKeyFile: keyFile, tools: ['contacts'] } }),
      log: noopLog,
      toolsService: makeToolsService(defs),
      writeJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) },
      readBody: (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(JSON.parse(d || '{}'))) }),
    })
    const server = createServer((req, res) => route.handler(req, res))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const key = loadMcpKey(keyFile)
    const client = new Client({ name: 'test', version: '0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${route.path}`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((t) => t.name), ['contacts'])
    const out = await client.callTool({ name: 'contacts', arguments: { action: 'list' } })
    assert.equal(out.isError, undefined)
    assert.match(out.content[0].text, /"ok":true/)
    await client.close()
    server.close()
  })
} else {
  test('SDK not present in repo — integration tests skipped (live-only)', () => { assert.ok(true) })
}

