// MCP server surface for dsh-agents-in-the-loop (v1.9.0).
//
// Exposes the plugin's own dsh tools (contacts / session_message /
// spawn_session by default) as MCP tools over the EXISTING dsh web server —
// one more webServer.register route on the server the plugin already serves
// incoming requests with. ZERO new dependencies: the protocol surface we need
// (stateless streamable-HTTP, JSON responses only) is plain JSON-RPC 2.0 and
// is implemented by hand here.
//
// Supported methods: initialize, notifications/initialized (acked),
// tools/list, tools/call, ping. Everything else → -32601. Batches supported.
//
// Auth: loopback fence + bearer API key file, checked before any protocol
// work. Stateless by construction: no session ids, every POST self-contained,
// restart-proof; any MCP client speaking streamable-http reconnects with a
// plain initialize.
//
// Phase 2 IS mcp.allTools: when true, EVERY registered harness tool is
// exposed and callable (full-control mode, Mark directive 2026-10-09). The
// aitl-mcp key file is then a FULL-HARNESS-CAPABILITY credential: anything
// that can read it can run bash etc. on this machine. Loopback-only.

import { readFileSync, statSync, existsSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { isLoopbackAddr } from './mcp-auth.js'
import { isExternalSession } from './inbox.js'

const PROTOCOL_VERSION = '2025-03-26'
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const SERVER_INFO = { name: 'dsh-agents-in-the-loop', version: '1.11.0' }

const DEFAULTS = {
  enabled: false,
  path: '/api/agents-in-the-loop/mcp',
  apiKeyFile: '~/.dsh/aitl-mcp-key.json',
  callerId: 'session-mcp-external',
  allowNonLoopback: false,
  tools: ['contacts', 'session_message', 'spawn_session'],
  allTools: false, // true = expose EVERY harness tool (full control), not just the plugin's three
  identityHeader: 'x-aitl-identity',
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
  cfg.tools = Array.isArray(cfg.tools) ? cfg.tools : []
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
export function createMcpRouteLazy({ mcp, log, toolsService, writeJson, readBody, identityResolver = null, identityExecResolver = null, liveFlags = null }) {

  // Live allTools (Config UI): the hook wins when it answers; fall back to
  // the boot-time mcp.allTools. Failure of the hook = boot config (not off).
  function allToolsLive() {
    let flags = null
    try { flags = liveFlags?.() } catch { flags = null }
    return typeof flags?.allTools === 'boolean' ? flags.allTools : mcp.allTools === true
  }

  // All-tools mode (mcp.allTools): enumerate every harness tool. The dsh
  // tools service has grown across versions — probe the known enumeration
  // surfaces in order and log which one answered (once), so a miss is visible
  // in the live log instead of silently serving an empty list.
  let enumLogged = false
  function allToolNames() {
    const probe = (label, fn) => {
      try {
        const v = fn()
        if (Array.isArray(v) && v.length) return { label, names: v }
      } catch {}
      return null
    }
    const hit =
      probe('view().visible', () => {
        const visible = toolsService?.view?.(undefined)?.visible
        return visible instanceof Map ? [...visible.keys()] : null
      }) ??
      probe('list()', () => {
        const l = toolsService?.list?.(undefined)
        return Array.isArray(l) ? l.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean) : null
      }) ??
      probe('schemas()', () => {
        const schemas = toolsService?.schemas?.(undefined)
        return schemas && typeof schemas === 'object' ? Object.keys(schemas) : null
      })
    const names = [...new Set(hit?.names ?? [])]
    if (!enumLogged) {
      enumLogged = true
      log(`[agents-in-the-loop] MCP allTools enumeration: ${names.length} tools via ${hit ? hit.label : 'NO MATCHED SURFACE (check dsh version)'}`)
    }
    return names
  }

  // Live tool defs: resolved per request so kill-switched tools disappear
  // from tools/list naturally (tools service get() returns undefined).
  function mcpToolDefs() {
    const tools = []
    // allTools mode enumerates the WHOLE service; enumeration failure means
    // an EMPTY tools/list (fail closed) — callTool stays gated by the actual
    // registration lookup either way.
    const names = [...new Set(allToolsLive() ? allToolNames() : mcp.tools)]
    for (const name of names) {
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

  async function callTool(name, args, execId = null, identityCwd = null, identityExec = undefined) {
    if (!allToolsLive() && !mcp.tools.includes(name)) {
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
      // Workspace binding: harness workspace tools (memory, taskboard, file
      // context) derive their workspace from exec.agent.session.header.cwd —
      // the same canonical path the spawn workspace resolution uses. External
      // identities bind one via the contact record's `cwd` field so memory
      // calls land in THAT workspace instead of the home directory.
      // v1.11.0 — session-backed identities: when identityExec is provided
      // (resolved via identityExecResolver → identityManager.resolveExec),
      // it IS the real agent handle exec and is passed through AS-IS; the
      // synthetic identity below is skipped entirely.
      let exec
      if (identityExec !== undefined) {
        exec = identityExec
      } else {
        exec = { agent: { id: execId ?? mcp.callerId } }
        if (identityCwd) exec.session = { header: { cwd: identityCwd } }
      }
      const result = await def.execute(args ?? {}, exec)
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

  async function dispatch(msg, identitySessionId = null, identityCwd = null, identityName = null, identityIsSessionBacked = false) {
    const { id, method, params } = msg ?? {}
    const isNotification = typeof method === 'string' && method.startsWith('notifications/')
    switch (method) {
      case 'initialize': {
        // Echo the client's version when we know it (2025-06-18-only clients
        // abort on a lower echo), else our latest known. clientInfo.name is
        // advisory only — identity is the X-Aitl-Identity header (§9-G1).
        const requested = params?.protocolVersion
        const version = KNOWN_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION
        return { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } }
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null // notification → no response body (202)
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: mcpToolDefs() } }
      case 'tools/call': {
        // v1.11.0 — session-backed identity: resolve the REAL agent handle
        // via identityExecResolver (→ identityManager.resolveExec) and pass
        // it to the tool as-is. Fail closed: a resolution failure is a
        // JSON-RPC -32000 error, never a synthetic-identity fallback.
        if (identityIsSessionBacked && identityName) {
          if (typeof identityExecResolver !== 'function') {
            return { jsonrpc: '2.0', id, error: { code: -32000, message: `identity "${identityName}" is session-backed but the identity manager is unavailable (identities disabled or not ready)` } }
          }
          let r = null
          try { r = await identityExecResolver(identityName) } catch (e) { r = { ok: false, error: e?.message ?? String(e) } }
          if (!r?.ok || !r?.exec) {
            return { jsonrpc: '2.0', id, error: { code: -32000, message: `identity "${identityName}" exec unavailable: ${r?.error ?? 'resolution failed'}` } }
          }
          const outSessionBacked = await callTool(params?.name, params?.arguments, null, null, r.exec)
          return { jsonrpc: '2.0', id, result: outSessionBacked }
        }
        const out = await callTool(params?.name, params?.arguments, identitySessionId, identityCwd)
        return { jsonrpc: '2.0', id, result: out }
      }
      default:
        if (isNotification) return null
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method ?? '(none)'}` } }
    }
  }

  async function handlePost(req, res) {
    const body = await readBody(req)
    if (body === null) {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (typeof body !== 'object') {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
      return
    }
    if (Array.isArray(body) && body.length === 0) {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } })
      return
    }
    // Per-harness identity (plan §9-G1): the caller presents its registered
    // external contact name on EVERY POST (stateless — no session). Unknown
    // identities are rejected fail-closed; without the header the legacy
    // shared identity applies (no maildrop, no external registration).
    let identitySessionId = null
    let identityCwd = null
    let identityIsSessionBacked = false
    const identityName = (req.headers?.[mcp.identityHeader] ?? '').toString().trim().toLowerCase()
    if (identityName) {
      const contact = identityResolver ? identityResolver(identityName) : null
      // Gate (v1.11.0): legacy external contacts must be session-ext-…;
      // session-backed identity contacts (identity === true) carry a REAL
      // dsh session id (session-…) — their session shape is not checked,
      // the identity flag is the trust marker.
      const isSessionBacked = contact?.identity === true
      if (!contact || (!isExternalSession(contact.sessionId) && !isSessionBacked)) {
        writeJson(res, 403, { ok: false, error: `unknown external identity "${identityName}" (register it in contacts first, sessionId session-ext-…)` })
        return
      }
      identitySessionId = contact.sessionId
      identityCwd = typeof contact.cwd === 'string' && contact.cwd.startsWith('/') ? contact.cwd : null
      identityIsSessionBacked = isSessionBacked
    }
    const msgs = Array.isArray(body) ? body : [body]
    // A request WITHOUT an id is invalid (id-less = notification only for
    // notifications/*); answering it would produce an id-less response.
    if (msgs.some((m) => typeof m !== 'object' || m === null || (m.id === undefined && !(typeof m.method === 'string' && m.method.startsWith('notifications/'))))) {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
      return
    }
    const out = []
    for (const m of msgs) {
      const r = m.method === 'tools/call'
        ? await dispatch(m, identitySessionId, identityCwd, identityName || null, identityIsSessionBacked)
        : await dispatch(m)
      if (r) out.push(r)
    }
    if (out.length === 0) {
      // pure notification(s) → 202 Accepted, no body (JSON-RPC over HTTP)
      res.writeHead(202, { 'Content-Length': 0 })
      res.end()
      return
    }
    writeJson(res, 200, Array.isArray(body) ? out : out[0])
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
        writeJson(res, 405, { ok: false, error: 'method not allowed — POST only (stateless)' })
      }
    } catch (e) {
      log(`[agents-in-the-loop] MCP handler error: ${e?.message ?? e}`)
      if (!res.headersSent) writeJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } })
    }
  }

  return { path: mcp.path, handler, _internals: { callTool, mcpToolDefs } }
}
