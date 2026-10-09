// MCP server surface for dsh-agents-in-the-loop (v1.9.0, phase 1).
//
// Exposes the plugin's own dsh tools (contacts / session_message /
// spawn_session by default) over a streamable-HTTP MCP endpoint served on the
// EXISTING dsh web server — one more webServer.register route, no extra
// process. Auth: loopback fence + bearer API key file. Stateless transports
// (one per POST, no session ids) keep the surface curl-friendly and
// restart-proof: any MCP client that speaks streamable-http reconnects with a
// plain initialize.
//
// Phase 2 (harness tool bridging) is NOT implemented here — it is gated by
// mcp.bridge.enabled and needs Mark's decisions (plan §3/§7, D4).
//
// The @modelcontextprotocol/sdk is an OPTIONAL peer: it is present in the live
// profile node_modules but absent in the repo. If the import fails the route
// still registers and answers 503 with a one-time degrade log, so apply()
// never fails because of the SDK.

import { readFileSync, statSync, existsSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { isLoopbackAddr } from './mcp-auth.js'

const DEFAULTS = {
  enabled: false,
  path: '/api/agents-in-the-loop/mcp',
  apiKeyFile: '~/.dsh/aitl-mcp-key.json',
  callerId: 'session-mcp-external',
  allowNonLoopback: false,
  tools: ['contacts', 'session_message', 'spawn_session'],
  bridge: { enabled: false, allowedTools: [] },
}

export function resolveMcpConfig(config = {}) {
  const raw = config.mcp ?? {}
  const cfg = {
    ...DEFAULTS,
    ...raw,
    bridge: { ...DEFAULTS.bridge, ...(raw.bridge ?? {}) },
  }
  cfg.path = typeof cfg.path === 'string' && cfg.path.startsWith('/') ? cfg.path : DEFAULTS.path
  cfg.apiKeyFile = typeof cfg.apiKeyFile === 'string' && cfg.apiKeyFile
    ? cfg.apiKeyFile.replace(/^~/, homedir())
    : DEFAULTS.apiKeyFile.replace(/^~/, homedir())
  cfg.tools = Array.isArray(cfg.tools) && cfg.tools.length > 0 ? cfg.tools : []
  return cfg
}

// ── API key ─────────────────────────────────────────────────────────────
// Key file shape: {"key":"aitl_<hex>"} — same pattern as the MC bridge's
// apiKeyFile, but a DIFFERENT trust domain (never reuse the MC key).
let keyCache = { file: null, mtime: 0, key: null }

export function loadMcpKey(file) {
  try {
    if (!existsSync(file)) return null
    const mtime = statSync(file).mtimeMs
    if (keyCache.file === file && keyCache.mtime === mtime) return keyCache.key
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    const key = typeof parsed?.key === 'string' && parsed.key.length >= 16 ? parsed.key : null
    keyCache = { file, mtime, key }
    return key
  } catch {
    return null
  }
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function verifyMcpAuth(req, apiKey) {
  if (!apiKey) return false // no key file → locked (fail closed)
  const header = req?.headers?.authorization ?? ''
  const match = /^Bearer\s+(.+)$/.exec(header)
  if (!match) return false
  return safeEqual(match[1], apiKey)
}

export function isLoopback(req) {
  return isLoopbackAddr(req?.socket?.remoteAddress ?? '')
}

// ── Route factory ───────────────────────────────────────────────────────
// Returns { path, handler } immediately; the SDK is imported lazily on the
// first request. Transports are STATELESS (sessionIdGenerator: undefined,
// enableJsonResponse: true) — every POST is self-contained, no session map
// to leak or evict, and curl works without an SSE channel.
export function createMcpRouteLazy({ mcp, log, toolsService, writeJson, readBody }) {
  let sdk = null // { Server, StreamableHTTPServerTransport, schemas } | 'missing'
  let degradedLogged = false

  async function loadSdk() {
    if (sdk) return sdk
    try {
      const serverMod = await import('@modelcontextprotocol/sdk/server/index.js')
      const transportMod = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
      const typesMod = await import('@modelcontextprotocol/sdk/types.js')
      sdk = {
        Server: serverMod.Server ?? serverMod.default?.Server,
        StreamableHTTPServerTransport: transportMod.StreamableHTTPServerTransport ?? transportMod.default?.StreamableHTTPServerTransport,
        ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
        CallToolRequestSchema: typesMod.CallToolRequestSchema,
      }
      if (!sdk.Server || !sdk.StreamableHTTPServerTransport || !sdk.ListToolsRequestSchema || !sdk.CallToolRequestSchema) sdk = 'missing'
    } catch {
      sdk = 'missing'
    }
    if (sdk === 'missing' && !degradedLogged) {
      degradedLogged = true
      log('[agents-in-the-loop] MCP: @modelcontextprotocol/sdk unavailable — endpoint answers 503 (install the SDK or upgrade the profile)')
    }
    return sdk
  }

  // Live tool defs: resolved per request so kill-switched tools disappear
  // from tools/list naturally (tools service get() returns undefined).
  function mcpToolDefs() {
    const tools = []
    for (const name of mcp.tools) {
      let def
      try { def = toolsService?.get?.(name, undefined) } catch { def = undefined }
      if (!def) continue
      tools.push({
        name: def.name ?? name,
        description: def.description ?? '',
        inputSchema: def.parameters && def.parameters.type === 'object' ? def.parameters : { type: 'object', properties: {} },
      })
    }
    return tools
  }

  async function callTool(name, args) {
    if (!mcp.tools.includes(name)) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `tool "${name}" is not exposed over MCP` }) }] }
    }
    let def
    try { def = toolsService?.get?.(name, undefined) } catch { def = undefined }
    if (!def || typeof def.execute !== 'function') {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `tool "${name}" is not registered (disabled or unknown)` }) }] }
    }
    try {
      // Synthetic caller identity: MCP callers have no dsh session. The three
      // phase-1 tools only read exec.agent.id; spawn logs the service id in
      // journal + contacts note (audit trail preserved).
      const result = await def.execute(args ?? {}, { agent: { id: mcp.callerId } })
      const text = typeof result?.text === 'string' ? result.text : JSON.stringify(result ?? {})
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      return {
        isError: parsed ? parsed.ok === false : false,
        content: [{ type: 'text', text }],
      }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e?.message ?? String(e) }) }] }
    }
  }

  async function buildServer() {
    const s = await loadSdk()
    if (s === 'missing') return null
    const server = new s.Server({ name: 'dsh-agents-in-the-loop', version: '1.9.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(s.ListToolsRequestSchema, async () => ({ tools: mcpToolDefs() }))
    server.setRequestHandler(s.CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req?.params ?? {}
      return callTool(name, args)
    })
    return server
  }

  let lastRpcId = null
  async function handlePost(req, res) {
    const body = await readBody(req)
    lastRpcId = Array.isArray(body) ? null : (typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null)
    if (body === null || typeof body !== 'object') {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const server = await buildServer()
    if (!server) {
      writeJson(res, 503, { jsonrpc: '2.0', id: Array.isArray(body) ? null : body?.id ?? null, error: { code: -32000, message: 'MCP SDK unavailable on this deployment' } })
      return
    }
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { try { transport.close() } catch {} try { server.close() } catch {} })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  async function handler(req, res) {
    // Auth fence FIRST — before any protocol work.
    if (!mcp.allowNonLoopback && !isLoopback(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return
    }
    const apiKey = loadMcpKey(mcp.apiKeyFile)
    if (!verifyMcpAuth(req, apiKey)) {
      writeJson(res, 401, { ok: false, error: 'unauthorized: missing or invalid bearer key' })
      return
    }
    try {
      if (req.method === 'POST') {
        await handlePost(req, res)
      } else {
        // v1: no SSE stream slots (GET) and no sessions to terminate (DELETE).
        writeJson(res, 405, { ok: false, error: 'method not allowed — POST only (stateless streamable-http)' })
      }
    } catch (e) {
      log(`[agents-in-the-loop] MCP handler error: ${e?.message ?? e}`)
      if (!res.headersSent) writeJson(res, 500, { jsonrpc: '2.0', id: lastRpcId, error: { code: -32603, message: 'Internal error' } })
    }
  }

  return { path: mcp.path, handler, _internals: { callTool, mcpToolDefs, loadSdk } }
}
