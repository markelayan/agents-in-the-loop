// agents-in-the-loop — cross-session call center for DSH agents.
//
// Two model tools, nothing else:
//   session_message — list live sessions, deliver a message to another
//                     session (idle: visible full-text wake; busy:
//                     mid-turn-safe notice; plus a runtime-context note).
//   contacts        — named directory over session ids (resolve / call /
//                     add / update / remove) so agents reach each other by
//                     alias in one call.
//
// Formerly taskboard-flow (kanban triggers/triage/task engine removed in
// v1.0.0 — messaging core preserved verbatim). All configuration lives in
// the cordis composition (cordis.patch.yml config block); there is no web
// UI settings panel.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'agents-in-the-loop'
export const inject = ['webServer']

// ── Config resolution ──────────────────────────────────────────────────

function resolveLive(config) {
  const cfg = config ?? {}
  return {
    enabled: cfg.enabled !== false,
    // session_message tool kill-switch (default ON).
    sessionMessage: cfg.sessionMessage?.enabled !== false,
    // contacts directory tool (default ON). Store defaults to the
    // historical taskboard-flow path so pre-rename contacts survive;
    // '~/' in a custom path expands.
    contactsEnabled: cfg.contacts?.enabled !== false,
    contactsFile:
      typeof cfg.contacts?.file === 'string' && cfg.contacts.file.length > 0
        ? (cfg.contacts.file.startsWith('~/') ? join(homedir(), cfg.contacts.file.slice(2)) : cfg.contacts.file)
        : join(homedir(), '.dsh', 'taskboard-flow-contacts.json'),
  }
}

// ── Contacts directory store ───────────────────────────────────────────
// Named aliases for session ids so agents resolve "who do I contact" in
// ONE call (name → session id + label + live status) instead of
// list-then-guess. Personal local state, atomic tmp+rename writes,
// never shipped with the package.

const CONTACT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

function normalizeContactName(raw) {
  const name = String(raw ?? '').trim().toLowerCase()
  return CONTACT_NAME_RE.test(name) ? name : null
}

function loadContacts(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    return data && typeof data === 'object' && data.contacts && typeof data.contacts === 'object'
      ? data.contacts
      : {}
  } catch {
    return {}
  }
}

function saveContacts(file, contacts) {
  const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), contacts }, null, 2) + '\n'
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}`
  writeFileSync(tmp, payload, 'utf-8')
  renameSync(tmp, file)
}

// ── Plugin ─────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const live = resolveLive(config)
  // Action logs go to console.log — ctx.logger output never reaches
  // ~/.dsh/dsh-web.log (verified 2026-08-28 audit), which left actions
  // without an audit trail. apply() has always used console.log.
  const log = (...args) => console.log(...args)

  // Runtime-context delivery channel: per-session note buffers rendered
  // into the target agent's system prompt via systemPrompt.context()
  // (dsh-system-prompt layer.contexts — the "Current runtime context"
  // snapshot block). Notes expire after NOTE_TTL_MS; NOTE_CAP retained
  // per session.
  const contextNotes = new Map() // sessionId -> [{key, text, addedAt}]
  const contextFibers = new Map() // agent -> fiber (per-agent systemPrompt context registration)
  const failedInstalls = new Set() // agent ids whose installContextNotes already logged an error (log-once)
  const NOTE_TTL_MS = 30 * 60 * 1000
  const NOTE_CAP = 5

  function renderContextNotes(sid) {
    const notes = contextNotes.get(sid)
    if (!notes || notes.length === 0) return ''
    const now = Date.now()
    const fresh = notes.filter((n) => now - n.addedAt < NOTE_TTL_MS)
    if (fresh.length !== notes.length) contextNotes.set(sid, fresh)
    if (fresh.length === 0) {
      contextNotes.delete(sid)
      return ''
    }
    return fresh.slice(-NOTE_CAP).map((n) => n.text).filter((t) => t && t.trim()).join('\n\n')
  }

  function installContextNotes(agent) {
    const sid = agent?.id
    if (!sid || contextFibers.has(agent)) return
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'agents-in-the-loop',
          order: 200,
          text: () => renderContextNotes(sid),
        })
      })
      contextFibers.set(agent, fiber)
    } catch (e) {
      if (!failedInstalls.has(sid)) {
        failedInstalls.add(sid)
        log(`[agents-in-the-loop] context install failed for ${sid}: ${e?.message}`)
      }
    }
  }

  // dsh-system-prompt's interpolator scans ALL context text for {{name}}
  // groups (GROUP_AT /^\{\{([^{}]*)\}\}/, name must match /^[a-z][a-z0-9_]*$/)
  // and THROWS on anything else — e.g. a forwarded message containing the
  // literal "{{}}" or a template snippet like {{lastExecution}} poisons the
  // target session's system prompt until the note TTL clears. Break the
  // opening-brace pair so the interpolator never sees a reference.
  function sanitizePromptText(text) {
    return String(text).replace(/\{\{/g, '{ {')
  }

  function pushContextNote(sid, key, rawText) {
    if (!sid || !rawText) return
    const text = sanitizePromptText(rawText)
    let notes = contextNotes.get(sid)
    if (!notes) {
      notes = []
      contextNotes.set(sid, notes)
    }
    if (notes.some((n) => n.key === key)) return // same key delivered once
    notes.push({ key, text, addedAt: Date.now() })
    if (notes.length > NOTE_CAP) notes.splice(0, notes.length - NOTE_CAP)
  }

  // ── shared cross-session delivery ───────────────────────────────────
  // Delivery rules (preserved from taskboard-flow v0.6.2–v0.7.2, keep
  // them): an IDLE target's wake carries the FULL payload — steer renders
  // it visibly in the target conversation; a pointer-only nudge once left
  // humans staring at "full text in your runtime context" with nothing
  // visible. Status is read ONCE (live-observed race: target flipped
  // idle→running mid-send, which double-reading turned into a
  // contradictory result). A BUSY target + wake gets the FULL text
  // injected as a plugin-source notice — same path as context/compression
  // nudges: visible immediately, mid-turn safe, starts no turn. Both
  // paths also push a runtime-context note. resumeIfDead resurrects a
  // dead target via AgentRegistry.resume (opt-in).
  async function deliverSessionMessage({ sid, target, message, wake = true, resumeIfDead = false }) {
    if (!target) return { ok: false, error: 'target session id required (use session_message or contacts action "list" to discover targets)' }
    if (!message) return { ok: false, error: 'message text required' }
    if (target === sid) return { ok: false, error: 'self-send refused — target must be another session' }
    let agent = agentCtx.agents.get(target)
    let resumed = false
    if (!agent && resumeIfDead === true) {
      // A resumed agent MUST carry a model route: dsh-agent-loop registers the
      // `model` prompt variable as `context.agent?.options.model`
      // (dsh-agent-loop/lib/index.js:1094) and the deployment persona renders
      // {{model}} — resuming without agentOptions left options.model undefined
      // and every wake turn died with `prompt variable "{{model}}" has no value
      // for this assembly (section "deployment:persona")`. Use the deployment
      // default selection (same fallback taskboard-flow v0.7.x used).
      try {
        const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
        const agentOptions = sel?.provider && sel?.model
          ? { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) }
          : {}
        const handle = await agentCtx.agents.resume({ resumeSessionId: target, agentOptions })
        agent = handle?.agent ?? handle
        resumed = true
      } catch (e) {
        return { ok: false, error: `resume ${target} failed: ${e?.message}` }
      }
    }
    if (!agent || typeof agent.inject !== 'function') {
      return { ok: false, error: `session ${target} not live${resumeIfDead === true ? '' : ' (retry with resumeIfDead: true to resurrect it)'}` }
    }
    const text = `[session-message] From session ${sid}:\n\n${message}`
    pushContextNote(target, `sm-${randomUUID()}`, text)
    installContextNotes(agent)
    const idleAtSend = agent.status === 'idle'
    let nudgeVia = 'none'
    if (wake !== false && idleAtSend) {
      const wakeMsg = {
        id: `msg-smn-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }
      if (typeof agent.steer === 'function') {
        agent.steer(wakeMsg)
        nudgeVia = 'steer'
      } else if (typeof agent.followup === 'function') {
        agent.followup(wakeMsg)
        nudgeVia = 'followup'
      }
    }
    let noticeInjected = false
    if (!idleAtSend && wake !== false && typeof agent.inject === 'function') {
      try {
        agent.inject({
          id: `msg-smn-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'agents-in-the-loop', form: 'notice' },
        })
        noticeInjected = true
      } catch (e) {
        log(`[agents-in-the-loop] session_message notice inject failed → ${target}: ${e?.message}`)
      }
    }
    const delivery = idleAtSend
      ? `context+wake-${nudgeVia}`
      : (noticeInjected ? 'context+notice' : 'context-only')
    const note = idleAtSend
      ? 'idle main session: full text now visible in its conversation + runtime context; a turn starts at the user\'s next input'
      : (noticeInjected
          ? 'busy target: full text injected as a visible conversation notice (same path as context-compression nudges) + runtime context note; the running turn is untouched'
          : 'busy target: context note only (wake disabled)')
    return { ok: true, from: sid, to: target, targetStatus: agent.status ?? 'unknown', delivery, nudgeVia, noticeInjected, note, resumed }
  }

  let agentCtx = null // set inside the agents inject below
  let disposeSessionMsgTool = null
  let disposeContactsTool = null
  let offCreated = null
  let offDisposed = null

  // ── Start: wait for workspaceRegistry + agents ──────────────────────

  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    wsCtx.inject(['agents'], (ac) => {
      agentCtx = ac
      // Seed the runtime-context registration for every existing agent
      // and keep it installed for agents created later (pattern from
      // dsh-file-reference-local/lib/index.js:265-297). agent.id is the
      // session id used by agents.get(sessionId).
      try {
        for (const a of agentCtx.agents.list()) installContextNotes(a)
      } catch (e) {
        log(`[agents-in-the-loop] agent seeding failed: ${e?.message}`)
      }
      offCreated = ctx.on('agent/created', ({ agent }) => installContextNotes(agent))
      offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        contextFibers.delete(agent)
        if (agent?.id) contextNotes.delete(agent.id)
      })

      // ── session_message tool ─────────────────────────────────────────
      // Harness physics (kept from taskboard-flow): main GUI sessions
      // start turns on user input, so the wake renders the text but does
      // not force a turn. A BUSY target gets the context note only
      // (steering an in-flight turn is lossy). resumeIfDead resurrects a
      // dead target via AgentRegistry.resume (opt-in).
      if (live.sessionMessage) {
        try {
          const toolsSvcMsg = ctx.get('tools')
          if (toolsSvcMsg && typeof toolsSvcMsg.register === 'function') {
            disposeSessionMsgTool = toolsSvcMsg.register({
              name: 'session_message',
              description:
                'Send a message to another DSH session agent, or list live sessions. Delivery: on an IDLE target the FULL message text is rendered into the target conversation (steer, followup fallback) AND pushed into its runtime context (~30-min TTL); main GUI sessions start a turn only on user input, so the text is visible the moment anyone opens the target session and the agent reads it at its next turn. A BUSY target receives the runtime-context note only. Actions: "list" → live sessions [{id,status}]; "send" (target + message required) → deliver. Optional: wake (default true), resumeIfDead (default false — resume a dead target session first). Self-send refused.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['list', 'send'], description: 'list = enumerate live sessions; send = deliver a message.' },
                  target: { type: 'string', description: 'Target session id (required for send; use action "list" or contacts "list" to discover).' },
                  message: { type: 'string', description: 'Message text (required for send).' },
                  wake: { type: 'boolean', description: 'Nudge an idle target to start a turn (default true).' },
                  resumeIfDead: { type: 'boolean', description: 'Resume the target session if not live (default false).' },
                },
              },
              output: {
                schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: value.text }],
              },
              async execute(args, exec) {
                try {
                  const sid = exec?.agent?.id ?? exec?.agent?.session?.id ?? null
                  if (!sid) return { text: JSON.stringify({ ok: false, error: 'caller identity unavailable — send refused' }) }
                  const action = args?.action === 'send' ? 'send' : 'list'
                  if (action === 'list') {
                    const rows = []
                    for (const a of agentCtx.agents.list()) {
                      if (!a?.id) continue
                      rows.push({ id: a.id, status: a.status ?? 'unknown' })
                    }
                    return { text: JSON.stringify({ ok: true, count: rows.length, sessions: rows }) }
                  }
                  const target = typeof args?.target === 'string' ? args.target.trim() : ''
                  const message = typeof args?.message === 'string' ? args.message.trim() : ''
                  const result = await deliverSessionMessage({
                    sid,
                    target,
                    message,
                    wake: args?.wake !== false,
                    resumeIfDead: args?.resumeIfDead === true,
                  })
                  if (result.ok) {
                    log(`[agents-in-the-loop] session_message ${sid} → ${target} (${result.delivery})${result.resumed ? ' [resumed]' : ''}`)
                  }
                  return { text: JSON.stringify(result) }
                } catch (err) {
                  return { text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }
                }
              },
            })
            log('[agents-in-the-loop] tool registered: session_message (cross-session messaging)')
          } else {
            log('[agents-in-the-loop] tools service unavailable — session_message NOT registered')
          }
        } catch (err) {
          log(`[agents-in-the-loop] session_message registration failed: ${err?.message}`)
        }
      }

      // ── contacts tool ────────────────────────────────────────────────
      // Named contact directory over raw session ids: agents resolve an
      // alias ("advisor") to session id + label + LIVE status in ONE call
      // (no list-then-guess), message a contact in one call via the shared
      // delivery engine, and manage entries (add/update/remove) at
      // runtime — no config edits, no restart. Local JSON store, atomic
      // tmp+rename writes; the store is personal state, never shipped.
      if (live.contactsEnabled) {
        try {
          const toolsSvcCc = ctx.get('tools')
          if (toolsSvcCc && typeof toolsSvcCc.register === 'function') {
            const nowIso = () => new Date().toISOString()
            disposeContactsTool = toolsSvcCc.register({
              name: 'contacts',
              description:
                'Named contacts directory for cross-session messaging: resolve a human alias ("advisor", "brain-orchestrator") to its session id + LIVE status in ONE call instead of list-then-guess. Actions: "list" → every contact with live status; "get" (name) → one contact + status; "call" (name + message) → message that contact through the same engine as session_message (idle: visible full-text wake; busy: mid-turn-safe notice); "add" (name only — registers YOUR calling session automatically; pass sessionId only to register a different session; optional label/tags/note) → create; "update" (name, optional sessionId/label/tags/note/rename) → edit; "remove" (name) → delete. Names: lowercase [a-z0-9._-], ≤64 chars.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['list', 'get', 'call', 'add', 'update', 'remove'], description: 'list | get | call | add | update | remove.' },
                  name: { type: 'string', description: 'Contact name (required for get/call/add/update/remove).' },
                  sessionId: { type: 'string', description: 'Target session id (optional for add — omit it to register YOUR calling session automatically; pass one only to register a different session. Optional for update).' },
                  message: { type: 'string', description: 'Message text (required for call).' },
                  label: { type: 'string', description: 'Human-readable label (optional; add/update).' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (add/update).' },
                  note: { type: 'string', description: 'Free-text note (optional; add/update).' },
                  rename: { type: 'string', description: 'Rename the contact (optional; update only).' },
                  wake: { type: 'boolean', description: 'Nudge an idle contact (default true; call only).' },
                  resumeIfDead: { type: 'boolean', description: 'Resume a dead contact session first (default false; call only).' },
                },
              },
              output: {
                schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: value.text }],
              },
              async execute(args, exec) {
                try {
                  const sid = exec?.agent?.id ?? exec?.agent?.session?.id ?? null
                  if (!sid) return { text: JSON.stringify({ ok: false, error: 'caller identity unavailable — refused' }) }
                  const action = ['list', 'get', 'call', 'add', 'update', 'remove'].includes(args?.action) ? args.action : null
                  if (!action) return { text: JSON.stringify({ ok: false, error: 'action must be one of: list, get, call, add, update, remove' }) }
                  const contacts = loadContacts(live.contactsFile)
                  const liveStatus = (sessionId) => {
                    const a = agentCtx.agents.get(sessionId)
                    return a ? (a.status ?? 'unknown') : 'dead'
                  }
                  const withStatus = (name, c) => ({
                    name,
                    sessionId: c.sessionId,
                    label: c.label ?? '',
                    tags: c.tags ?? [],
                    note: c.note ?? '',
                    updatedAt: c.updatedAt ?? null,
                    status: liveStatus(c.sessionId),
                  })
                  if (action === 'list') {
                    const rows = Object.keys(contacts).sort().map((n) => withStatus(n, contacts[n]))
                    return { text: JSON.stringify({ ok: true, count: rows.length, contacts: rows, file: live.contactsFile }) }
                  }
                  const rawName = typeof args?.name === 'string' ? args.name.trim() : ''
                  const name = normalizeContactName(rawName)
                  if (!name) {
                    return { text: JSON.stringify({ ok: false, error: `invalid contact name "${rawName}" — use lowercase letters/digits/._- (≤64 chars)` }) }
                  }
                  if (action === 'get') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list")` }) }
                    return { text: JSON.stringify({ ok: true, contact: withStatus(name, c) }) }
                  }
                  if (action === 'call') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list")` }) }
                    const message = typeof args?.message === 'string' ? args.message.trim() : ''
                    const result = await deliverSessionMessage({
                      sid,
                      target: c.sessionId,
                      message,
                      wake: args?.wake !== false,
                      resumeIfDead: args?.resumeIfDead === true,
                    })
                    if (result.ok) {
                      log(`[agents-in-the-loop] contacts call "${name}" ${sid} → ${c.sessionId} (${result.delivery})${result.resumed ? ' [resumed]' : ''}`)
                      result.contact = name
                      result.label = c.label ?? ''
                    }
                    return { text: JSON.stringify(result) }
                  }
                  if (action === 'add') {
                    // sessionId optional — omitted (or "self") registers
                    // the CALLING session. Agents self-register by name
                    // only; researching their own session id was slow. An
                    // explicit id still lets a caller register a contact
                    // pointing at another session.
                    const explicit = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
                    const selfReg = explicit === '' || explicit === 'self'
                    const sessionId = selfReg ? sid : explicit
                    if (!/^session-[0-9a-fA-F-]{10,}$/.test(sessionId)) {
                      return { text: JSON.stringify({ ok: false, error: 'sessionId must look like "session-…" — or omit it to register YOUR session automatically' }) }
                    }
                    if (contacts[name]) {
                      return { text: JSON.stringify({ ok: false, error: `contact "${name}" already exists — use action "update"` }) }
                    }
                    const record = {
                      sessionId,
                      label: typeof args?.label === 'string' ? args.label.trim() : '',
                      tags: Array.isArray(args?.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean) : [],
                      note: typeof args?.note === 'string' ? args.note.trim() : '',
                      createdAt: nowIso(),
                      updatedAt: nowIso(),
                    }
                    const next = { ...contacts, [name]: record }
                    try { saveContacts(live.contactsFile, next) } catch (e) {
                      return { text: JSON.stringify({ ok: false, error: `persist failed: ${e?.message}` }) }
                    }
                    log(`[agents-in-the-loop] contacts add "${name}" → ${sessionId}${selfReg ? ' (self)' : ''}`)
                    const out = { ok: true, added: name, contact: withStatus(name, record) }
                    if (selfReg) out.selfRegistered = true
                    if (!agentCtx.agents.get(sessionId)) {
                      out.warn = 'session not currently live — contact saved anyway (resumeIfDead can reach it later)'
                    }
                    return { text: JSON.stringify(out) }
                  }
                  if (action === 'update') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list" or "add")` }) }
                    if (args?.sessionId !== undefined) {
                      const sessionId = String(args.sessionId).trim()
                      if (!/^session-[0-9a-fA-F-]{10,}$/.test(sessionId)) {
                        return { text: JSON.stringify({ ok: false, error: 'sessionId must look like "session-…"' }) }
                      }
                      c.sessionId = sessionId
                    }
                    if (args?.label !== undefined) c.label = String(args.label).trim()
                    if (args?.tags !== undefined) c.tags = Array.isArray(args?.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean) : []
                    if (args?.note !== undefined) c.note = String(args.note).trim()
                    let finalName = name
                    if (args?.rename !== undefined) {
                      const renamed = normalizeContactName(args.rename)
                      if (!renamed) return { text: JSON.stringify({ ok: false, error: `invalid new name "${args.rename}"` }) }
                      if (renamed !== name && contacts[renamed]) {
                        return { text: JSON.stringify({ ok: false, error: `contact "${renamed}" already exists` }) }
                      }
                      finalName = renamed
                    }
                    c.updatedAt = nowIso()
                    const next = { ...contacts }
                    delete next[name]
                    next[finalName] = c
                    try { saveContacts(live.contactsFile, next) } catch (e) {
                      return { text: JSON.stringify({ ok: false, error: `persist failed: ${e?.message}` }) }
                    }
                    log(`[agents-in-the-loop] contacts update "${name}"${finalName !== name ? ` → "${finalName}"` : ''}`)
                    return { text: JSON.stringify({ ok: true, updated: finalName, renamed: finalName !== name, contact: withStatus(finalName, c) }) }
                  }
                  if (action === 'remove') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list")` }) }
                    const next = { ...contacts }
                    delete next[name]
                    try { saveContacts(live.contactsFile, next) } catch (e) {
                      return { text: JSON.stringify({ ok: false, error: `persist failed: ${e?.message}` }) }
                    }
                    log(`[agents-in-the-loop] contacts remove "${name}"`)
                    return { text: JSON.stringify({ ok: true, removed: name, sessionId: c.sessionId }) }
                  }
                  return { text: JSON.stringify({ ok: false, error: 'unhandled action' }) }
                } catch (err) {
                  return { text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }
                }
              },
            })
            log('[agents-in-the-loop] tool registered: contacts (named contact directory)')
          } else {
            log('[agents-in-the-loop] tools service unavailable — contacts NOT registered')
          }
        } catch (err) {
          log(`[agents-in-the-loop] contacts registration failed: ${err?.message}`)
        }
      }

      // ── HTTP API for the contacts panel (client half, lib/client.js) ──
      // The webserver's browser-auth fence already gates /api/*; these routes
      // inherit it. Shape follows the dsh-skill-explorer host-route pattern:
      // { path, handler } registered via ctx.webServer.register.
      let disposeRoutes = []
      try {
        const writeJson = (res, status, body) => {
          const payload = JSON.stringify(body)
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
          res.end(payload)
        }
        const readBody = (req) =>
          new Promise((resolve) => {
            let data = ''
            req.on('data', (chunk) => {
              data += chunk
              if (data.length > 1e6) req.destroy()
            })
            req.on('end', () => {
              try { resolve(data ? JSON.parse(data) : {}) } catch { resolve(null) }
            })
          })
        // Loopback-only trust fence (pattern from dsh-skill-explorer): custom
        // webServer routes are NOT auto-fenced by the harness browser-auth
        // layer, and this host binds 0.0.0.0 — refuse anything that is not
        // loopback so LAN peers cannot read/modify the contacts store.
        const isLoopback = (req) => {
          const addr = req.socket?.remoteAddress ?? ''
          return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
        }
        const guard = (req, res) => {
          if (isLoopback(req)) return true
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return false
        }
        const SESSION_RE = /^session-[0-9a-fA-F-]{10,}$/
        const routes = [
          {
            path: '/api/agents-in-the-loop/sessions',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              const sessions = []
              try {
                for (const a of agentCtx.agents.list()) {
                  if (!a?.id) continue
                  sessions.push({ id: a.id, status: a.status ?? 'unknown' })
                }
              } catch {}
              return writeJson(res, 200, { ok: true, sessions })
            },
          },
          {
            path: '/api/agents-in-the-loop/contacts',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              try {
                const contacts = loadContacts(live.contactsFile)
                const liveStatus = (sessionId) => {
                  const a = agentCtx.agents.get(sessionId)
                  return a ? (a.status ?? 'unknown') : 'dead'
                }
                if (req.method === 'GET') {
                  const rows = Object.keys(contacts).sort().map((n) => ({ name: n, ...contacts[n], status: liveStatus(contacts[n].sessionId) }))
                  return writeJson(res, 200, { ok: true, contacts: rows })
                }
                if (req.method === 'POST') {
                  const body = await readBody(req)
                  if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
                  const name = normalizeContactName(body.name)
                  if (!name) return writeJson(res, 400, { ok: false, error: 'invalid name (lowercase [a-z0-9._-], ≤64 chars)' })
                  if (contacts[name]) return writeJson(res, 409, { ok: false, error: `contact "${name}" already exists` })
                  const sessionId = String(body.sessionId ?? '').trim()
                  if (!SESSION_RE.test(sessionId)) return writeJson(res, 400, { ok: false, error: 'sessionId must look like "session-…"' })
                  const record = {
                    sessionId,
                    label: typeof body.label === 'string' ? body.label.trim() : '',
                    tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean) : [],
                    note: typeof body.note === 'string' ? body.note.trim() : '',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  }
                  const next = { ...contacts, [name]: record }
                  try { saveContacts(live.contactsFile, next) } catch (e) { return writeJson(res, 500, { ok: false, error: `persist failed: ${e?.message}` }) }
                  log(`[agents-in-the-loop] api add "${name}" → ${sessionId}`)
                  return writeJson(res, 200, { ok: true, contact: { name, ...record, status: liveStatus(sessionId) } })
                }
                if (req.method === 'PUT') {
                  const body = await readBody(req)
                  if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
                  const name = normalizeContactName(body.name)
                  if (!name) return writeJson(res, 400, { ok: false, error: 'invalid name' })
                  const c = contacts[name]
                  if (!c) return writeJson(res, 404, { ok: false, error: `contact "${name}" not found` })
                  if (body.sessionId !== undefined) {
                    const sessionId = String(body.sessionId).trim()
                    if (!SESSION_RE.test(sessionId)) return writeJson(res, 400, { ok: false, error: 'sessionId must look like "session-…"' })
                    c.sessionId = sessionId
                  }
                  if (body.label !== undefined) c.label = String(body.label).trim()
                  if (body.tags !== undefined) c.tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean) : []
                  if (body.note !== undefined) c.note = String(body.note).trim()
                  let finalName = name
                  if (body.rename !== undefined) {
                    const renamed = normalizeContactName(body.rename)
                    if (!renamed) return writeJson(res, 400, { ok: false, error: 'invalid new name' })
                    if (renamed !== name && contacts[renamed]) return writeJson(res, 409, { ok: false, error: `contact "${renamed}" already exists` })
                    finalName = renamed
                  }
                  c.updatedAt = new Date().toISOString()
                  const next = { ...contacts }
                  delete next[name]
                  next[finalName] = c
                  try { saveContacts(live.contactsFile, next) } catch (e) { return writeJson(res, 500, { ok: false, error: `persist failed: ${e?.message}` }) }
                  log(`[agents-in-the-loop] api update "${name}"${finalName !== name ? ` → "${finalName}"` : ''}`)
                  return writeJson(res, 200, { ok: true, contact: { name: finalName, ...c, status: liveStatus(c.sessionId) } })
                }
                if (req.method === 'DELETE') {
                  const url = new URL(req.url, 'http://dsh.invalid')
                  const name = normalizeContactName(url.searchParams.get('name'))
                  if (!name) return writeJson(res, 400, { ok: false, error: 'name query param required' })
                  const c = contacts[name]
                  if (!c) return writeJson(res, 404, { ok: false, error: `contact "${name}" not found` })
                  const next = { ...contacts }
                  delete next[name]
                  try { saveContacts(live.contactsFile, next) } catch (e) { return writeJson(res, 500, { ok: false, error: `persist failed: ${e?.message}` }) }
                  log(`[agents-in-the-loop] api remove "${name}"`)
                  return writeJson(res, 200, { ok: true, removed: name })
                }
                return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              } catch (e) {
                return writeJson(res, 500, { ok: false, error: e?.message ?? String(e) })
              }
            },
          },
        ]
        for (const route of routes) {
          try { disposeRoutes.push(ctx.webServer.register(route)) } catch (e) {
            log(`[agents-in-the-loop] route ${route.path} registration failed: ${e?.message}`)
          }
        }
        log(`[agents-in-the-loop] api routes active: ${routes.map((r) => r.path).join(', ')}`)
      } catch (err) {
        log(`[agents-in-the-loop] api route setup failed: ${err?.message}`)
      }

      log(
        `[agents-in-the-loop] ready — session_message=${live.sessionMessage} contacts=${live.contactsEnabled} store=${live.contactsFile}`,
      )

      return () => {
        try {
          offCreated?.()
          offDisposed?.()
        } catch {}
        try {
          disposeSessionMsgTool?.()
        } catch {}
        try {
          disposeContactsTool?.()
        } catch {}
        for (const dispose of disposeRoutes) {
          try { dispose?.() } catch {}
        }
        // Dispose every per-agent systemPrompt context fiber with the plugin.
        for (const [agent, fiber] of contextFibers) {
          try {
            fiber?.dispose?.()
          } catch {}
          contextFibers.delete(agent)
        }
        contextNotes.clear()
      }
    })
  })
}
