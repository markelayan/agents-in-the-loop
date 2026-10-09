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
  const readBodyReq = (req) => new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
  route = createMcpRouteLazy({
    mcp: resolveMcpConfig({ mcp: { enabled: true, apiKeyFile: keyFile } }),
    log: noopLog,
    toolsService: makeToolsService({}),
    writeJson,
    readBody: readBodyReq,
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
  test('initialize → JSON-RPC result with serverInfo (real HTTP)', async () => {
    const { status, json } = await post(route, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    assert.equal(status, 200)
    assert.equal(json.result.serverInfo.name, 'dsh-agents-in-the-loop')
  })
  test('tools/list returns exposed tools; pure notification → 202', async () => {
    const { status, json } = await post(route, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.equal(status, 200)
    assert.deepEqual(json.result.tools.map((t) => t.name), [])
    const n = await post(route, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(n.status, 202)
  })
  test('unknown method → -32601', async () => {
    const { json } = await post(route, { jsonrpc: '2.0', id: 3, method: 'nope' })
    assert.equal(json.error.code, -32601)
  })
  test('batch: request + notification → only the request answered', async () => {
    const { json } = await post(route, [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    ])
    assert.ok(Array.isArray(json))
    assert.equal(json.length, 1)
    assert.equal(json[0].id, 4)
  })
})

// Real-HTTP helpers (no SDK): the handler is wired into a plain node http server.
import { createServer } from 'node:http'
async function post(route, body, { auth = null, addr = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = server.address().port
    const key = loadMcpKey(route.mcp?.apiKeyFile ?? keyFile)
    const res = await fetch(`http://127.0.0.1:${port}${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ?? key ? { authorization: `Bearer ${auth ?? key}` } : {}) },
      body: JSON.stringify(body),
      localAddress: addr === '::1' ? '::1' : undefined,
    })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  } finally { server.close() }
}

describe('mcp internals (kill-switch + isError mapping, no SDK needed)', () => {
  const defs = {
    contacts: { name: 'contacts', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ text: JSON.stringify({ ok: true, value: [] }) }) },
    session_message: { name: 'session_message', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ text: JSON.stringify({ ok: false, error: 'nope' }) }) },
  }
  const route = createMcpRouteLazy({
    mcp: resolveMcpConfig({ mcp: { enabled: true, apiKeyFile: keyFile, tools: ['contacts', 'session_message', 'spawn_session'] } }),
    log: noopLog,
    toolsService: makeToolsService(defs),
    writeJson: () => {},
    readBody: () => Promise.resolve({}),
  })
  const { callTool, mcpToolDefs } = route._internals

  test('kill-switched tool (spawn_session unregistered) disappears from defs', () => {
    assert.deepEqual(mcpToolDefs().map((t) => t.name), ['contacts', 'session_message'])
  })
  test('unknown tool name → isError with explicit error', async () => {
    const out = await callTool('nope', {})
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /not exposed over MCP/)
  })
  test('registered tool returning ok:false → isError true, text preserved', async () => {
    const out = await callTool('session_message', {})
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /nope/)
  })
  test('registered tool returning ok:true → isError false', async () => {
    const out = await callTool('contacts', {})
    assert.equal(out.isError, false)
    assert.match(out.content[0].text, /"ok":true/)
  })
  test('tool execute throwing → isError with message, no crash', async () => {
    const boom = createMcpRouteLazy({
      mcp: resolveMcpConfig({ mcp: { enabled: true, apiKeyFile: keyFile, tools: ['contacts'] } }),
      log: noopLog,
      toolsService: makeToolsService({ contacts: { name: 'contacts', parameters: { type: 'object' }, execute: async () => { throw new Error('boom') } } }),
      writeJson: () => {},
      readBody: () => Promise.resolve({}),
    })._internals
    const out = await boom.callTool('contacts', {})
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /boom/)
  })
})
