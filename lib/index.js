// agents-in-the-loop — cross-session call center for DSH agents.
//
// Three model tools, nothing else:
//   session_message — list live sessions, deliver a message to another
//                     session (idle: visible full-text wake; busy:
//                     notice; each message delivered exactly once).
//   contacts        — named directory over session ids (resolve / call /
//                     add / update / remove) so agents reach each other by
//                     alias in one call.
//   spawn_session   — spawn a NEW persistent dsh session in-process
//                     (preset + model pin + optional workspace/permission),
//                     register it in contacts, deliver the first message.
//                     OFF unless spawn.enabled === true.
//
// Formerly taskboard-flow (kanban triggers/triage/task engine removed in
// v1.0.0 — messaging core preserved verbatim). All configuration lives in
// the cordis composition (cordis.patch.yml config block); there is no web
// UI settings panel.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startMcRuntime } from './mc-runtime.js'
import {
  resolveSpawnConfig,
  seatsUsed,
  createSpawnedSession,
  disposeSpawnedSession,
  appendSpawnJournal,
  resolveCallerWorkspace,
} from './spawner.js'
import { resolveMcpConfig, createMcpRouteLazy } from './mcp.js'

export const name = 'agents-in-the-loop'
export const inject = ['webServer']

// ── Config resolution ──────────────────────────────────────────────────

const DEFAULT_MAX_CHARS = 8000

function resolveLive(config) {
  const cfg = config ?? {}
  return {
    enabled: cfg.enabled !== false,
    // session_message tool kill-switch (default ON).
    sessionMessage: cfg.sessionMessage?.enabled !== false,
    // Per-message char cap (v1.6.0). Long reports belong in a file.
    maxChars: Number.isInteger(cfg.sessionMessage?.maxChars) && cfg.sessionMessage.maxChars >= 500
      ? cfg.sessionMessage.maxChars
      : DEFAULT_MAX_CHARS,
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

  // v1.6.0 — NO runtime-context channel. dsh 0.2 materializes every change
  // of systemPrompt.context() text as a NEW durable user-role snapshot in
  // history (dsh-agent-loop RuntimeContextProjection), so the old per-session
  // note buffer (5 notes, 30-min TTL) re-copied every buffered message — and
  // every other plugin's runtime context — on each delivery and each expiry.
  // Those snapshots compound and the agent cannot drop them. Every message
  // is now delivered exactly ONCE as an ordinary compactable conversation
  // message (steer when idle, inject when busy / wake disabled).

  // Per-message cap (config sessionMessage.maxChars). Oversized text is
  // truncated with a note telling the sender to use a file path.
  const MESSAGE_MAX_CHARS = live.maxChars

  // Footer read by the compaction summarizer (it replays the conversation
  // before summarizing). Without it, "capture explicit instructions
  // faithfully" makes every checkpoint carry inter-session messages forward
  // verbatim, forever.
  const SUMMARY_HINT =
    '[agents-in-the-loop: inter-session message. When summarizing/compacting, keep at most one line: sender + gist + any still-open request. Do not quote it verbatim.]'

  function formatSessionMessage(from, message) {
    let body = String(message)
    if (body.length > MESSAGE_MAX_CHARS) {
      const dropped = body.length - MESSAGE_MAX_CHARS
      body = `${body.slice(0, MESSAGE_MAX_CHARS)}\n\n[… truncated ${dropped} chars by agents-in-the-loop — ask the sender to put long content in a file and send the path]`
    }
    return `[session-message] From session ${from}:\n\n${body}\n\n${SUMMARY_HINT}`
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
  // paths deliver ONCE (v1.6.0). resumeIfDead resurrects a
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
    const text = formatSessionMessage(sid, message)
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
    // Busy target, wake disabled, or no steer/followup: agent.inject() queues
    // the message for the next pre-step WITHOUT waking the driver (dsh 0.2
    // Agent.inject contract) — visible, mid-turn safe, delivered once.
    let noticeInjected = false
    if (nudgeVia === 'none') {
      try {
        agent.inject({
          id: `msg-smn-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:agents-in-the-loop', plugin: 'agents-in-the-loop', form: 'notice' },
        })
        noticeInjected = true
      } catch (e) {
        log(`[agents-in-the-loop] session_message notice inject failed → ${target}: ${e?.message}`)
        return { ok: false, error: `delivery to ${target} failed: ${e?.message}` }
      }
    }
    const delivery = nudgeVia !== 'none' ? `wake-${nudgeVia}` : 'notice'
    const note = nudgeVia !== 'none'
      ? 'idle target: full text now visible in its conversation; a turn starts at the user\'s next input'
      : (idleAtSend
          ? 'idle target, wake disabled: queued as a notice, read at its next turn'
          : 'busy target: full text queued as a visible notice for its next step; the running turn is untouched')
    return { ok: true, from: sid, to: target, targetStatus: agent.status ?? 'unknown', delivery, nudgeVia, noticeInjected, note, resumed }
  }

  let agentCtx = null // set inside the agents inject below
  let disposeSessionMsgTool = null
  let disposeContactsTool = null

  // ── Start: wait for workspaceRegistry + agents ──────────────────────

  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    const wsRegistry = wsCtx.workspaceRegistry
    wsCtx.inject(['agents'], (ac) => {
      agentCtx = ac
      // ── session_message tool ─────────────────────────────────────────
      // Harness physics (kept from taskboard-flow): main GUI sessions
      // start turns on user input, so the wake renders the text but does
      // not force a turn. A BUSY target gets a queued notice
      // (steering an in-flight turn is lossy). resumeIfDead resurrects a
      // dead target via AgentRegistry.resume (opt-in).
      if (live.sessionMessage) {
        try {
          const toolsSvcMsg = ctx.get('tools')
          if (toolsSvcMsg && typeof toolsSvcMsg.register === 'function') {
            disposeSessionMsgTool = toolsSvcMsg.register({
              name: 'session_message',
              description:
                'Send a message to another DSH session agent, or list live sessions. Delivery (each message lands exactly ONCE in the target conversation): an IDLE target gets the full text rendered into its conversation (steer, followup fallback); main GUI sessions start a turn only on user input, so the agent reads it at its next turn. A BUSY target (or wake:false) gets the full text queued as a visible notice for its next step. Messages over ' + live.maxChars + ' chars are truncated — put long reports in a file and send the path. Actions: "list" → live sessions [{id,status,contact?}]; "send" (target + message required) → deliver. TARGET: pass the REGISTERED CONTACT NAME (resolved live at call time; contacts action "list" to discover names). Raw "session-…" ids are rejected. Optional: wake (default true), resumeIfDead (default false). Self-send refused.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['list', 'send'], description: 'list = enumerate live sessions; send = deliver a message.' },
                  target: { type: 'string', description: 'Registered contact name (REQUIRED — resolved to its current session id at call time, immune to stale ids). Raw "session-…" ids are rejected since v1.4.2.' },
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
                    // Annotate each live session with its registered
                    // contact name (if any) so models address by name.
                    const contactsByName = loadContacts(live.contactsFile)
                    const sidToName = new Map(
                      Object.entries(contactsByName).map(([n, c]) => [String(c.sessionId), n])
                    )
                    const rows = []
                    for (const a of agentCtx.agents.list()) {
                      if (!a?.id) continue
                      const contact = sidToName.get(a.id)
                      rows.push(contact ? { id: a.id, status: a.status ?? 'unknown', contact } : { id: a.id, status: a.status ?? 'unknown' })
                    }
                    return { text: JSON.stringify({ ok: true, count: rows.length, sessions: rows }) }
                  }
                  // Target resolution (2026-09-18): a registered contact
                  // name is the ONLY accepted target form and is resolved
                  // live at call time, so a re-raised agent under the same
                  // name is always reached.
                  // ★v1.4.2 (user directive): raw session-id targeting is
                  // DISABLED — a "session-…" id is rejected with a clean
                  // error pointing at contacts. Reason: raw ids go stale
                  // when agents are re-raised and bypass the named directory.
                  let target = typeof args?.target === 'string' ? args.target.trim() : ''
                  let resolvedFrom = null
                  if (/^session-/.test(target)) {
                    return {
                      text: JSON.stringify({
                        ok: false,
                        error: 'Raw session-id targets are disabled (v1.4.2). Use the registered contact NAME instead — `session_message` action "list" (or `contacts` action "list") shows every contact with its live status.',
                      }),
                    }
                  }
                  if (target) {
                    const name = normalizeContactName(target)
                    const c = name ? loadContacts(live.contactsFile)[name] : null
                    if (c?.sessionId) {
                      resolvedFrom = name
                      target = String(c.sessionId)
                    }
                  }
                  const message = typeof args?.message === 'string' ? args.message.trim() : ''
                  const result = await deliverSessionMessage({
                    sid,
                    target,
                    message,
                    wake: args?.wake !== false,
                    resumeIfDead: args?.resumeIfDead === true,
                  })
                  if (resolvedFrom !== null) result.resolvedFrom = resolvedFrom
                  if (result.ok) {
                    log(`[agents-in-the-loop] session_message ${sid} → ${target}${resolvedFrom ? ` (contact "${resolvedFrom}")` : ''} (${result.delivery})${result.resumed ? ' [resumed]' : ''}`)
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

      // ── spawn_session (v1.8.0): in-process session creation ──────────
      // Optional feature — OFF unless spawn.enabled === true. Same faces
      // dsh-taskboard uses for scheduled executions (AgentsFace.create +
      // agentPresets resolve/mount + workspaces): preset pin, model pin
      // (config-only — never a tool arg), optional workspace/permission,
      // seat cap over the contacts store, JSONL audit journal, contacts
      // registration, first message delivered via the shared engine.
      // Distinct from subagent children: spawned sessions are PERSISTENT
      // peers, deliberately registered in contacts (Subagent isolation law
      // covers 1-shot subagent runs, not these).
      let disposeSpawnTool = null
      const spawnCfg = resolveSpawnConfig(config)
      // Serialize spawns: seat count and duplicate-name checks are snapshots —
      // concurrent spawns could both pass then both create (QA finding 1).
      let spawnChain = Promise.resolve()
      const withSpawnLock = (fn) => {
        const run = spawnChain.then(fn, fn)
        spawnChain = run.catch(() => {})
        return run
      }
      if (spawnCfg.enabled) {
        try {
          const toolsSvcSpawn = ctx.get('tools')
          if (toolsSvcSpawn && typeof toolsSvcSpawn.register === 'function') {
            disposeSpawnTool = toolsSvcSpawn.register({
              name: 'spawn_session',
              description:
                'Spawn a NEW persistent DSH session (in-process, like the Mission Control bridge) with a pinned preset and model, optionally in a workspace and with a permission mode. The session is registered in contacts under `name`, the first `message` is delivered as its task brief, and you can reach it afterwards via session_message / contacts by name. OFF unless the plugin config sets spawn.enabled=true. NOT a subagent: this creates a durable co-worker session (costs tokens while it runs). The model is fixed by plugin config and cannot be chosen per call.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'message'],
                properties: {
                  name: { type: 'string', description: 'Contacts name for the new session (lowercase [a-z0-9._-], ≤64 chars, must not exist).' },
                  message: { type: 'string', description: 'First message (task brief) delivered to the new session right after spawn.' },
                  preset: { type: 'string', description: `Agent preset id for the new session. Default: spawn.preset from config${spawnCfg.preset ? ` (${spawnCfg.preset})` : ' (unset — REQUIRED per call)'}.` },
                  workspaceId: { type: 'string', description: 'Workspace to spawn into (must be in the spawn.workspaces allowlist). Omit = caller default.' },
                  permission: { type: 'string', enum: ['read-only', 'workspace-write'], description: 'Permission mode for the spawned session (must be in spawn.allowedPermissions; default read-only).' },
                  wake: { type: 'boolean', description: 'Deliver `message` as a wake immediately (default true).' },
                },
              },
              output: {
                schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: value.text }],
              },
              execute(args, exec) {
                const self = this
                return withSpawnLock(() => self.executeSpawn(args, exec))
              },
              async executeSpawn(args, exec) {
                try {
                  const nowIso = () => new Date().toISOString()
                  const sid = exec?.agent?.id ?? exec?.agent?.session?.id ?? null
                  if (!sid) return { text: JSON.stringify({ ok: false, error: 'caller identity unavailable — spawn refused' }) }
                  const name = normalizeContactName(typeof args?.name === 'string' ? args.name.trim() : '')
                  if (!name) return { text: JSON.stringify({ ok: false, error: 'invalid name — use lowercase letters/digits/._- (≤64 chars)' }) }
                  const message = typeof args?.message === 'string' ? args.message.trim() : ''
                  if (!message) return { text: JSON.stringify({ ok: false, error: 'message (first task brief) required' }) }
                  if (args?.model !== undefined || args?.provider !== undefined) {
                    return { text: JSON.stringify({ ok: false, error: 'model/provider are pinned by plugin config (spawn.provider/spawn.model) — not selectable per call' }) }
                  }
                  const contacts = loadContacts(live.contactsFile)
                  if (contacts[name]) return { text: JSON.stringify({ ok: false, error: `contact "${name}" already exists — pick another name` }) }
                  const seats = seatsUsed({ contacts, agentCtx, excludedContacts: config?.mc?.excludedContacts ?? ['dsh-maintainer'] })
                  if (seats >= spawnCfg.maxSessions) {
                    return { text: JSON.stringify({ ok: false, error: `seat cap ${spawnCfg.maxSessions} reached (${seats} live) — close or remove a contact session first` }) }
                  }
                  // preset: per-call, else config default; allowlist enforced.
                  const preset = typeof args?.preset === 'string' && args.preset.trim() ? args.preset.trim() : spawnCfg.preset
                  if (!preset) return { text: JSON.stringify({ ok: false, error: 'no preset: pass preset or set spawn.preset in config' }) }
                  if (spawnCfg.allowedPresets.length > 0 && !spawnCfg.allowedPresets.includes(preset)) {
                    return { text: JSON.stringify({ ok: false, error: `preset "${preset}" not in spawn.allowedPresets [${spawnCfg.allowedPresets.join(', ')}]` }) }
                  }
                  // workspace: explicit per-call (allowlist-enforced — the
                  // cross-workspace ban at tool level). Omitted → auto-resolve
                  // the CALLER's workspace (header.cwd → workspaces.list()
                  // match) so the child is explicitly cwd'd + attached instead
                  // of landing in ungrouped sessions. The auto-resolved id is
                  // the caller's OWN workspace — inherently authorized, the
                  // allowlist gates only explicit cross-workspace requests.
                  let workspaceId = typeof args?.workspaceId === 'string' && args.workspaceId.trim() ? args.workspaceId.trim() : ''
                  let workspaceAuto = false
                  if (!workspaceId) {
                    const auto = await resolveCallerWorkspace(wsRegistry, exec)
                    if (auto) { workspaceId = auto.id; workspaceAuto = true }
                  }
                  if (workspaceId && !workspaceAuto && spawnCfg.workspaces.length > 0 && !spawnCfg.workspaces.includes(workspaceId)) {
                    return { text: JSON.stringify({ ok: false, error: `workspace "${workspaceId}" not in spawn.workspaces allowlist` }) }
                  }
                  // permission: allowlist-enforced (default read-only).
                  const permission = typeof args?.permission === 'string' && args.permission.trim() ? args.permission.trim() : 'read-only'
                  if (!spawnCfg.allowedPermissions.includes(permission)) {
                    return { text: JSON.stringify({ ok: false, error: `permission "${permission}" not in spawn.allowedPermissions [${spawnCfg.allowedPermissions.join(', ')}]` }) }
                  }
                  // Config sanity: the effective pinned model must be allowlisted (QA finding 6).
                  const effectiveModel = `${spawnCfg.provider}/${spawnCfg.model}`
                  if (spawnCfg.allowedModels.length > 0 && !spawnCfg.allowedModels.includes(effectiveModel)) {
                    return { text: JSON.stringify({ ok: false, error: `config error: pinned model ${effectiveModel} not in spawn.allowedModels [${spawnCfg.allowedModels.join(', ')}]` }) }
                  }
                  let created
                  try {
                    created = await createSpawnedSession({
                      agentCtx,
                      wsRegistry,
                      preset,
                      workspaceId,
                      provider: spawnCfg.provider,
                      model: spawnCfg.model,
                      reasoningEffort: spawnCfg.reasoningEffort,
                      permission,
                      title: name,
                    })
                  } catch (e) {
                    // create() threw BEFORE any session exists (preset resolve,
                    // workspace resolve, agents.create rejection) — clean error,
                    // nothing to dispose.
                    return { text: JSON.stringify({ ok: false, error: `spawn failed: ${e?.message ?? String(e)}` }) }
                  }
                  // QA finding 2 — fail closed: a requested permission that
                  // could not be applied must not survive with another policy.
                  if (created.permissionFailed) {
                    await disposeSpawnedSession(agentCtx, created.sessionId, log)
                    return { text: JSON.stringify({ ok: false, error: `spawn aborted — requested permission "${permission}" could not be applied: ${created.permissionFailed}` }) }
                  }
                  // Session EXISTS from here. Register contact + journal; if
                  // those fail, dispose the session (no unregistered zombies).
                  const record = {
                    sessionId: created.sessionId,
                    label: `spawned: ${name}`,
                    tags: ['spawned', preset],
                    note: `spawned by ${sid} — preset=${created.preset} model=${spawnCfg.provider}/${spawnCfg.model}${workspaceId ? ` workspace=${workspaceId}` : ''} permission=${permission}`,
                    createdAt: nowIso(),
                    updatedAt: nowIso(),
                  }
                  const next = { ...loadContacts(live.contactsFile), [name]: record }
                  try {
                    saveContacts(live.contactsFile, next)
                  } catch (e) {
                    await disposeSpawnedSession(agentCtx, created.sessionId, log)
                    return { text: JSON.stringify({ ok: false, error: `contact persist failed — session disposed: ${e?.message}` }) }
                }
                  if (!appendSpawnJournal(spawnCfg.stateFile, {
                    action: 'spawn', name, by: sid, sessionId: created.sessionId,
                    preset: created.preset, provider: spawnCfg.provider, model: spawnCfg.model,
                    reasoningEffort: spawnCfg.reasoningEffort ?? null, workspaceId: workspaceId || null, permission,
                  })) {
                    log(`[agents-in-the-loop] WARNING: spawn journal append failed for "${name}" (${created.sessionId})`)
                  }
                  let delivery = null
                  if (args?.wake !== false) {
                    try {
                      delivery = await deliverSessionMessage({ sid, target: created.sessionId, message, wake: true })
                    } catch (e) {
                      delivery = { ok: false, error: e?.message ?? String(e) }
                    }
                    if (!delivery.ok) {
                      // A spawned session without its task brief is a zombie
                      // worker: dispose + remove contact + journal the abort.
                      try {
                        const cs = loadContacts(live.contactsFile)
                        const next = { ...cs }
                        delete next[name]
                        saveContacts(live.contactsFile, next)
                      } catch {}
                      appendSpawnJournal(spawnCfg.stateFile, { action: 'abort', name, by: sid, sessionId: created.sessionId, reason: `first-message delivery failed: ${delivery.error}` })
                      await disposeSpawnedSession(agentCtx, created.sessionId, log)
                      return { text: JSON.stringify({ ok: false, error: `session created but first-message delivery failed (${delivery.error}) — session disposed, contact removed` }) }
                    }
                  }
                  log(`[agents-in-the-loop] spawned "${name}" → ${created.sessionId} (preset=${created.preset} model=${spawnCfg.provider}/${spawnCfg.model}${workspaceId ? ` ws=${workspaceId}` : ''} by=${sid})`)
                  return { text: JSON.stringify({
                    ok: true, sessionId: created.sessionId, name, preset: created.preset,
                    model: `${spawnCfg.provider}/${spawnCfg.model}`, workspaceId: workspaceId || null, workspaceAuto,
                    permission, cosmetic: created.cosmetic,
                    firstMessage: delivery ? { ok: delivery.ok, delivery: delivery.delivery, error: delivery.error } : { skipped: true },
                  }) }
                  } catch (err) {
                  return { text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }
                }
              },
            })
            log(`[agents-in-the-loop] tool registered: spawn_session (in-process spawn, cap=${spawnCfg.maxSessions}, ${spawnCfg.provider}/${spawnCfg.model})`)
          } else {
            log('[agents-in-the-loop] tools service unavailable — spawn_session NOT registered')
          }
        } catch (err) {
          log(`[agents-in-the-loop] spawn_session registration failed: ${err?.message}`)
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
            let done = false
            const finish = (v) => { if (!done) { done = true; resolve(v) } }
            req.on('data', (chunk) => {
              data += chunk
              if (data.length > 1e6) req.destroy()
            })
            req.on('end', () => {
              try { finish(data ? JSON.parse(data) : {}) } catch { finish(null) }
            })
            // req.destroy() (oversize) fires 'close'/'error', not 'end' —
            // resolve null so awaiting handlers answer 400 instead of hanging.
            req.on('close', () => finish(null))
            req.on('error', () => finish(null))
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
          {
            // External agents (Claude Code etc.): send-only messaging.
            // They NEVER register into the contacts store and never receive
            // messages — one POST, resolved against existing contacts, same
            // delivery engine as the session_message tool (idle wake renders
            // the full text; busy target gets a mid-turn-safe notice).
            // resumeIfDead is hard-wired false: an external sender must not
            // resurrect sessions. Loopback-only via guard() like the rest.
            path: '/api/agents-in-the-loop/message',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              try {
                const body = await readBody(req)
                if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
                const from = String(body.from ?? 'external-agent').trim().slice(0, 64) || 'external-agent'
                const contactName = normalizeContactName(body.contact)
                if (!contactName) return writeJson(res, 400, { ok: false, error: 'invalid contact name (lowercase [a-z0-9._-])' })
                const message = typeof body.message === 'string' ? body.message : ''
                if (!message.trim()) return writeJson(res, 400, { ok: false, error: 'message text required' })
                const contact = loadContacts(live.contactsFile)[contactName]
                if (!contact) return writeJson(res, 404, { ok: false, error: `contact "${contactName}" not found` })
                const result = await deliverSessionMessage({
                  sid: from,
                  target: contact.sessionId,
                  message,
                  wake: true,
                  resumeIfDead: false,
                })
                if (!result?.ok) {
                  // The tool-side hint (resumeIfDead) does not apply here: external senders cannot resume.
                  if (/ not live/.test(result?.error ?? '')) {
                    result.error = `session ${contact.sessionId} not live — open the "${contactName}" session in DSH first (external senders cannot resume sessions)`
                  }
                  log(`[agents-in-the-loop] external send to "${contactName}" rejected: ${result?.error}`)
                  return writeJson(res, 409, { ok: false, error: result?.error ?? 'delivery refused' })
                }
                log(`[agents-in-the-loop] external send "${from}" → "${contactName}" (${result.nudgeVia ?? 'no-wake'})`)
                return writeJson(res, 200, {
                  ok: true,
                  contact: contactName,
                  from,
                  nudgeVia: result.nudgeVia ?? 'none',
                  noticeInjected: result.noticeInjected === true,
                })
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
        // MCP endpoint (v1.9.0): JSON-RPC 2.0 surface for EXTERNAL harnesses
        // (Claude Code, Codex, other DSH profiles via mcp_manager_add), hand-
        // rolled in lib/mcp.js on this existing server — zero dependencies.
        // Gated by mcp.enabled (default false); auth = loopback + bearer key.
        const mcpCfg = resolveMcpConfig(config)
        if (mcpCfg.enabled) {
          try {
            disposeRoutes.push(ctx.webServer.register(createMcpRouteLazy({
              mcp: mcpCfg,
              log,
              toolsService: ctx.get('tools'),
              writeJson,
              readBody,
            })))
            log(`[agents-in-the-loop] MCP endpoint registered: ${mcpCfg.path} (tools: ${mcpCfg.allTools ? 'ALL harness tools' : mcpCfg.tools.join(', ')})`)
          } catch (e) {
            log(`[agents-in-the-loop] MCP route registration failed: ${e?.message}`)
          }
        }
      } catch (err) {
        log(`[agents-in-the-loop] api route setup failed: ${err?.message}`)
      }

      // ── MC runtime (DSH-MC-1): Mission Control drives dsh agents ────
      // Optional feature — OFF by default (mc.enabled === true to turn on).
      let disposeMcRuntime = null
      let disposeMcHealthOff = null
      if (config?.mc?.enabled === true) {
        try {
          disposeMcRuntime = startMcRuntime(ctx, config, {
            contactsFile: live.contactsFile,
            agentCtx,
            deliverSessionMessage,
            log,
          })
        } catch (err) {
          log(`[agents-in-the-loop] mc-runtime start failed: ${err?.message}`)
        }
      } else {
        // loopback-only stub so probes get an explicit {enabled:false}
        try {
          disposeMcHealthOff = ctx.webServer.register({
            path: '/api/agents-in-the-loop/mc-health',
            handler: async (req, res) => {
              const addr = req.socket?.remoteAddress ?? ''
              if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) {
                res.writeHead(403, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, error: 'forbidden: loopback-only' }))
              }
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, enabled: false }))
            },
          })
        } catch (e) {
          log(`[agents-in-the-loop] mc-health stub registration failed: ${e?.message}`)
        }
      }

      const mcpState = resolveMcpConfig(config)
      log(
        `[agents-in-the-loop] ready v1.9.0 — session_message=${live.sessionMessage} contacts=${live.contactsEnabled} spawn=${spawnCfg.enabled} mcp=${mcpState.enabled ? mcpState.path : 'off'} store=${live.contactsFile}`,
      )

      return () => {
        try {
          disposeMcHealthOff?.()
        } catch {}
        try {
          disposeMcRuntime?.()
        } catch {}
        try {
          disposeSessionMsgTool?.()
        } catch {}
        try {
          disposeContactsTool?.()
        } catch {}
        try {
          disposeSpawnTool?.()
        } catch {}
        for (const dispose of disposeRoutes) {
          try { dispose?.() } catch {}
        }
      }
    })
  })
}
