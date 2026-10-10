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
import { startMcRuntime, resolveMcConfig } from './mc-runtime.js'
import {
  resolveSpawnConfig,
  seatsUsed,
  createSpawnedSession,
  disposeSpawnedSession,
  appendSpawnJournal,
  resolveCallerWorkspace,
} from './spawner.js'
import { resolveMcpConfig, createMcpRouteLazy } from './mcp.js'
import { createIdentityManager } from './identity.js'
import { readCatalog } from './catalog.js'
import { openStore, loadContactsFromDb, saveContactsToDb, migrateContactsFromJson, resolveInboxConfig, enqueueMessage, pollInbox, ackMessage, listInbox, peekMessage, sweepInbox, isExternalSession, isInboxContact, hasInbox, getConfigOverrides, setConfigOverride, clearConfigOverride, getPath, setPath } from './inbox.js'

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

// v1.11.0 — session-backed identities config. `model` defaults to the spawn
// pair (spawn.provider/spawn.model) when not explicitly set; maxIdentities
// caps provisioned identities; allowedPermissions gates provisioning
// (default read-only — Mark owner decision, read-only first).
export function resolveIdentitiesConfig(config = {}) {
  const raw = config.identities ?? {}
  const spawn = resolveSpawnConfig(config)
  return {
    enabled: raw.enabled === true,
    maxIdentities: Number.isInteger(raw.maxIdentities) && raw.maxIdentities > 0 ? raw.maxIdentities : 8,
    preset: typeof raw.preset === 'string' ? raw.preset.trim() : '',
    allowedPresets: Array.isArray(raw.allowedPresets) ? raw.allowedPresets.filter((x) => typeof x === 'string') : [],
    provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : spawn.provider,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : spawn.model,
    reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '',
    allowedPermissions: Array.isArray(raw.allowedPermissions) && raw.allowedPermissions.length
      ? raw.allowedPermissions.filter((x) => typeof x === 'string')
      : ['read-only'],
    resumeIfDead: raw.resumeIfDead !== false,
    routeTimeoutMs: Number.isInteger(raw.routeTimeoutMs) && raw.routeTimeoutMs > 0 ? raw.routeTimeoutMs : 30000,
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

// v1.10.0: contacts live in the aitl SQLite store when the inbox feature is
// enabled (one DB for contacts + inbox). Fall back to the legacy JSON file
// when the store is closed (inbox disabled) — call sites are unchanged.
let aitlDb = null
let aitlInboxCfg = null

function loadContacts(file) {
  if (aitlDb) return loadContactsFromDb(aitlDb)
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
  if (aitlDb) return saveContactsToDb(aitlDb, contacts)
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

  // ── effective config (Config UI, host half) ────────────────────────────
  // Effective config = boot config + SQLite `cfg.*` overrides. Defined at
  // apply() scope so BOTH the tool execute guards (registered below) and
  // the Config API routes (registered later, inside the routes try-block)
  // close over the same helpers. Reads aitlDb at call time (module-level
  // let) so late store-open is picked up; all meta access is guarded for
  // aitlDb === null (inbox disabled).
  const RESTART_REQUIRED = new Set([
    'enabled', 'mcp.enabled', 'mcp.path', 'mcp.apiKeyFile', 'mcp.identityHeader',
    'mcp.inbox.enabled', 'mcp.inbox.file', 'contacts.file', 'spawn.stateFile', 'mc.enabled', 'mc.url', 'mc.apiKeyFile',
  ])
  const applyOverrides = (base, overrides) => { for (const [p, v] of Object.entries(overrides)) setPath(base, p, v); return base }
  // Full effective tree = boot base + SQLite overrides, fresh each call
  // (cheap: base resolution is pure config math). eff(path) is a single
  // lookup; the Config API returns the whole tree via effAll().
  const effAll = () => {
    const base = {
      enabled: config.enabled !== false,
      sessionMessage: { enabled: !!live.sessionMessage, maxChars: live.maxChars },
      contacts: { enabled: !!live.contactsEnabled, file: live.contactsFile },
      spawn: { ...resolveSpawnConfig(config) },
      identities: resolveIdentitiesConfig(config),
      mcp: resolveMcpConfig(config),
      mc: resolveMcConfig(config),
    }
    try { return applyOverrides(base, aitlDb ? getConfigOverrides(aitlDb) : {}) } catch { return base }
  }
  const eff = (path) => getPath(effAll(), path)
  let effRefresh = () => {}
  const effFlag = (path) => eff(path) !== false && eff(path) !== undefined

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
        const smGuard = () => { try { return effFlag('sessionMessage.enabled') } catch { return true } }
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
                  target: { type: 'string', description: 'Registered contact name (REQUIRED — resolved to its current session id at call time, immune to stale ids). Raw "session-…" ids are rejected since v1.4.2. Messaging an EXTERNAL contact (registered with a session-ext-… id) enqueues to its inbox instead of direct delivery.' },
                  threadId: { type: 'string', description: 'thread id [a-z0-9-]{6,64} (external inbox contacts; reused for conversation threading)' },
                  replyTo: { type: 'number', description: 'inbox message id being replied to (external contacts only)' },
                  subject: { type: 'string', description: 'optional subject line (external inbox contacts)' },
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
                  // Config kill-switch (live via eff()): must gate ALL
                  // actions (list included), so it is the first line.
                  if (!effFlag('sessionMessage.enabled')) return { text: JSON.stringify({ ok: false, error: 'disabled via Config (agents-in-the-loop panel)' }) }
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
                      // v1.10.0 (D6): messages to an EXTERNAL contact go to
                      // its inbox maildrop — external harnesses poll, they
                      // have no wake listener.
                      if (aitlDb && isInboxContact(c)) {
                        const message0 = typeof args?.message === 'string' ? args.message.trim() : ''
                        if (!message0) return { text: JSON.stringify({ ok: false, error: 'message required' }) }
                        const enq = enqueueMessage(aitlDb, {
                          recipient: c.sessionId,
                          sender: sid,
                          body: message0,
                          threadId: typeof args?.threadId === 'string' ? args.threadId : null,
                          replyTo: args?.replyTo != null ? Number(args.replyTo) : null,
                          subject: typeof args?.subject === 'string' ? args.subject : '',
                          maxPending: aitlInboxCfg.maxPending,
                          maxChars: aitlInboxCfg.maxChars,
                        })
                        if (enq.ok) {
                          log(`[agents-in-the-loop] session_message ${sid} → inbox[${resolvedFrom}] id=${enq.id} (thread ${enq.threadId})`)
                          return { text: JSON.stringify({ ok: true, delivery: 'inbox', inbox: { id: enq.id, threadId: enq.threadId, recipient: resolvedFrom }, resolvedFrom }) }
                        }
                        return { text: JSON.stringify({ ok: false, error: `inbox enqueue failed: ${enq.error}`, resolvedFrom }) }
                      }
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
                  cwd: { type: 'string', description: 'Absolute workspace path bound to this identity (external contacts) — workspace tools (memory, taskboard) resolve against it instead of the home directory' },
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
                  // Config kill-switch (live via eff()) — first line, all actions.
                  if (!effFlag('contacts.enabled')) return { text: JSON.stringify({ ok: false, error: 'disabled via Config (agents-in-the-loop panel)' }) }
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
                    // v1.10.0 (G5): an external identity may only claim its
                    // OWN session-ext id (anti maildrop-hijack).
                    if (isExternalSession(sessionId) && sessionId !== sid) {
                      return { text: JSON.stringify({ ok: false, error: `external identity ${sid} may only register itself (got "${sessionId}")` }) }
                    }
                    if (!/^session-(?:[0-9a-fA-F-]{10,}|ext-[a-z0-9][a-z0-9-]{1,62})$/.test(sessionId)) {
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
                      cwd: typeof args?.cwd === 'string' && args.cwd.startsWith('/') ? args.cwd : '',
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
                      if (contacts[name]?.identity && sessionId !== contacts[name].sessionId) {
                        return { text: JSON.stringify({ ok: false, error: `"${name}" is a session-backed identity — re-point it via identities re-provision` }) }
                      }
                      if (isExternalSession(sessionId) && sessionId !== sid) {
                        return { text: JSON.stringify({ ok: false, error: `external identity ${sid} may only keep its own session id` }) }
                      }
                      if (!/^session-(?:[0-9a-fA-F-]{10,}|ext-[a-z0-9][a-z0-9-]{1,62})$/.test(sessionId)) {
                        return { text: JSON.stringify({ ok: false, error: 'sessionId must look like "session-…"' }) }
                      }
                      c.sessionId = sessionId
                    }
                    if (args?.cwd !== undefined) {
                      c.cwd = typeof args.cwd === 'string' && args.cwd.startsWith('/') ? args.cwd : ''
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
                    if (contacts[name]?.identity) {
                      return { text: JSON.stringify({ ok: false, error: `"${name}" is a session-backed identity — deregister via DELETE /api/agents-in-the-loop/identities so its session is disposed` }) }
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

      const inboxCfg = resolveInboxConfig(config)
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
      let disposeInboxTool = null
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
                  // Config kill-switch (live via eff()) — first line.
                  if (!effFlag('spawn.enabled')) return { text: JSON.stringify({ ok: false, error: 'disabled via Config (agents-in-the-loop panel)' }) }
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
      // ── inbox (v1.10.0): external maildrop surface — OFF unless
      // mcp.inbox.enabled (plan §8; TESTING flag in bundle patch). One
      // unified tool: poll/ack/list/peek the caller's own maildrop, or
      // send INTO dsh by contact name. DSH agents do not poll — they
      // message externals via session_message, which enqueues.
      if (inboxCfg.enabled) {
        try {
          const toolsSvcInbox = ctx.get('tools')
          if (toolsSvcInbox && typeof toolsSvcInbox.register === 'function') {
            disposeInboxTool = toolsSvcInbox.register({
              name: 'inbox',
              description:
                'Cross-harness inbox (v1.10.0). EXTERNAL harnesses call this over MCP with their X-Aitl-Identity header: action "poll" takes pending messages (marks delivered; at-least-once with a redeliver window), "ack" confirms handling, "list"/"peek" inspect without taking, "send" delivers INTO dsh by contact name (routes like session_message). DSH agents do not poll — they message externals via session_message and the message lands in the external inbox.',
              parameters: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['poll', 'ack', 'list', 'peek', 'send'], description: 'inbox operation' },
                  id: { type: 'number', description: 'message id (ack/peek)' },
                  target: { type: 'string', description: 'contact name (send → dsh agent)' },
                  message: { type: 'string', description: 'body (send)' },
                  subject: { type: 'string', description: 'optional subject (send)' },
                  threadId: { type: 'string', description: 'thread id (send/reply)' },
                  replyTo: { type: 'number', description: 'message id being replied to (send)' },
                  includeAcked: { type: 'boolean', description: 'list: include acked messages' },
                },
                required: ['action'],
              },
              execute: async (args, exec) => {
                try {
                  if (!aitlDb) return { text: JSON.stringify({ ok: false, error: 'inbox disabled (mcp.inbox.enabled=false)' }) }
                  const sid = exec?.agent?.id ?? null
                  if (!sid) return { text: JSON.stringify({ ok: false, error: 'caller identity unavailable' }) }
                  const action = typeof args?.action === 'string' ? args.action : ''
                  if (action === 'send') {
                    const name = normalizeContactName(typeof args?.target === 'string' ? args.target.trim() : '')
                    const c = name ? loadContacts(live.contactsFile)[name] : null
                    if (!c?.sessionId) return { text: JSON.stringify({ ok: false, error: `contact "${name ?? args?.target}" not found` }) }
                    if (isInboxContact(c)) {
                      const enq = enqueueMessage(aitlDb, {
                        recipient: c.sessionId, sender: sid,
                        body: typeof args?.message === 'string' ? args.message.trim() : '',
                        threadId: args?.threadId ?? null, replyTo: args?.replyTo ?? null,
                        subject: args?.subject ?? '', maxPending: aitlInboxCfg.maxPending, maxChars: aitlInboxCfg.maxChars,
                      })
                      return { text: JSON.stringify(enq) }
                    }
                    const result = await deliverSessionMessage({
                      sid, target: c.sessionId,
                      message: typeof args?.message === 'string' ? args.message.trim() : '',
                      wake: args?.wake !== false, resumeIfDead: args?.resumeIfDead === true,
                    })
                    if (result.ok) result.resolvedFrom = name
                    return { text: JSON.stringify(result) }
                  }
                  if (!hasInbox(aitlDb, sid)) return { text: JSON.stringify({ ok: false, error: `mailbox actions require an external identity (X-Aitl-Identity header) — "${sid}" has no inbox` }) }
                  if (action === 'poll') return { text: JSON.stringify(pollInbox(aitlDb, { recipient: sid, redeliverAfterMin: aitlInboxCfg.redeliverAfterMin })) }
                  if (action === 'ack') {
                    if (args?.id === undefined) return { text: JSON.stringify({ ok: false, error: 'id required for ack' }) }
                    return { text: JSON.stringify(ackMessage(aitlDb, { recipient: sid, id: Number(args.id) })) }
                  }
                  if (action === 'list') return { text: JSON.stringify(listInbox(aitlDb, { recipient: sid, includeAcked: args?.includeAcked === true })) }
                  if (action === 'peek') {
                    if (args?.id === undefined) return { text: JSON.stringify({ ok: false, error: 'id required for peek' }) }
                    return { text: JSON.stringify(peekMessage(aitlDb, { recipient: sid, id: Number(args.id) })) }
                  }
                  return { text: JSON.stringify({ ok: false, error: `unknown action "${action}" — poll|ack|list|peek|send` }) }
                } catch (err) {
                  return { text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }
                }
              },
              output: {
                schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: value.text }],
              },
            })
            log('[agents-in-the-loop] tool registered: inbox (external maildrop surface)')
          } else {
            log('[agents-in-the-loop] tools service unavailable — inbox NOT registered')
          }
        } catch (err) {
          log(`[agents-in-the-loop] inbox registration failed: ${err?.message}`)
        }
      } else {
        log('[agents-in-the-loop] inbox disabled (mcp.inbox.enabled=false)')
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
        // Inbox store (v1.10.0): one SQLite DB for contacts + maildrops.
        // Migrates the legacy contacts JSON once (renames it .migrated).
        if (inboxCfg.enabled && !aitlDb) {
          aitlInboxCfg = inboxCfg
          aitlDb = openStore(inboxCfg.file, { log })
          const mig = migrateContactsFromJson(aitlDb, live.contactsFile, { log })
          if (mig.error) log(`[agents-in-the-loop] contacts migration issue: ${mig.error}`)
          // S1: retention must run for the life of the process, not once.
          const sweepTimer = setInterval(() => {
            try { const r = sweepInbox(aitlDb, { retentionDays: inboxCfg.retentionDays }); if (r.expiredAll) log(`[agents-in-the-loop] inbox sweep: expired ${r.expiredAll}`) } catch {}
          }, 60 * 60 * 1000)
          sweepTimer.unref?.()
        }
        // Effective config = boot config + SQLite overrides (Config UI writes
        // any dotted path; execute guards read through eff() each call).
        // Defined at apply() scope (see eff block above the tools) so the
        // tool execute guards can close over it.
        const SESSION_RE = /^session-(?:[0-9a-fA-F-]{10,}|ext-[a-z0-9][a-z0-9-]{1,62})$/
        const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
        if (aitlDb) sweepInbox(aitlDb, { retentionDays: inboxCfg.retentionDays })
        // Construct lazily when enabled, including Config API enablement.
        // Config getters keep provisioning and resume policy live without
        // replacing the manager or losing its journal bookkeeping.
        let identityManager = null
        const identitiesEff = () => { try { return resolveIdentitiesConfig(effAll()) } catch { return resolveIdentitiesConfig(config) } }
        const ensureIdentityManager = () => {
          if (!identitiesEff().enabled || !aitlDb) return null
          if (identityManager) return identityManager
          identityManager = createIdentityManager({
              db: aitlDb,
              contactsFile: live.contactsFile,
              getContacts: () => loadContacts(live.contactsFile),
              saveContacts: (contacts) => saveContacts(live.contactsFile, contacts),
              // createSpawnedSession with agentCtx/wsRegistry pre-bound; the
              // effective identities config supplies any field identity.js
              // does not pass (provider/model default to the spawn pair).
              spawn: async (opts = {}) => {
                const idEff = identitiesEff()
                return createSpawnedSession({
                  agentCtx,
                  wsRegistry,
                  preset: opts.preset || idEff.preset,
                  workspaceId: opts.workspaceId || undefined,
                  provider: opts.provider || idEff.provider,
                  model: opts.model || idEff.model,
                  reasoningEffort: opts.reasoningEffort || idEff.reasoningEffort || undefined,
                  permission: opts.permission || 'read-only',
                  title: opts.name || opts.title || 'identity',
                })
              },
              dispose: async (sessionId) => disposeSpawnedSession(agentCtx, sessionId, log),
              agents: agentCtx.agents,
              wsRegistry,
              stateFile: spawnCfg.stateFile,
              config: { get identities() { return identitiesEff() }, get spawn() { return effAll().spawn } },
              log,
          })
          log('[agents-in-the-loop] identity manager created (session-backed identities)')
          return identityManager
        }
        effRefresh = ensureIdentityManager
        try { ensureIdentityManager() } catch (e) {
          log(`[agents-in-the-loop] identity manager unavailable: ${e?.message}`)
        }
        const routes = [
          {
            path: '/api/agents-in-the-loop/inbox',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              if (!inboxCfg.enabled || !aitlDb) return writeJson(res, 503, { ok: false, error: 'inbox disabled (mcp.inbox.enabled=false)', code: 'inbox_disabled' })
              const url = new URL(req.url ?? '/inbox', 'http://localhost')
              // JSON API for the client UI
              if (url.searchParams.get('format') === 'json') {
                // Panel send (Config UI): same routing as the inbox tool's
                // send action — external contact → maildrop enqueue, local
                // contact → shared delivery engine.
                if (req.method === 'POST' && url.searchParams.get('op') === 'send') {
                  const body = await readBody(req)
                  if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
                  const name = normalizeContactName(typeof body.target === 'string' ? body.target.trim() : '')
                  const c = name ? loadContacts(live.contactsFile)[name] : null
                  if (!c?.sessionId) return writeJson(res, 404, { ok: false, error: `contact "${body.target ?? ''}" not found` })
                  const sender = 'dsh-panel'
                  if (isInboxContact(c)) {
                    const enq = enqueueMessage(aitlDb, {
                      recipient: c.sessionId, sender,
                      body: typeof body.message === 'string' ? body.message.trim() : '',
                      threadId: typeof body.threadId === 'string' ? body.threadId : null,
                      replyTo: body.replyTo != null ? Number(body.replyTo) : null,
                      subject: typeof body.subject === 'string' ? body.subject : '',
                      maxPending: aitlInboxCfg.maxPending, maxChars: aitlInboxCfg.maxChars,
                    })
                    return writeJson(res, enq.ok ? 200 : 500, { ...enq, target: name, delivery: 'inbox' })
                  }
                  const result = await deliverSessionMessage({
                    sid: sender, target: c.sessionId,
                    message: typeof body.message === 'string' ? body.message.trim() : '',
                    wake: true, resumeIfDead: false,
                  })
                  if (result.ok) {
                    result.resolvedFrom = name
                    log(`[agents-in-the-loop] panel send "${sender}" → ${name} (${result.delivery})`)
                  }
                  return writeJson(res, result.ok ? 200 : 409, { ...result, target: name, delivery: 'direct' })
                }
                if (req.method === 'POST' && url.searchParams.get('op') === 'ack') {
                  const body = await new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) } }) })
                  const who = String(body.identity ?? '').toLowerCase()
                  const rec = who ? loadContacts(live.contactsFile)[who] : null
                  if (!isInboxContact(rec)) { writeJson(res, 403, { ok: false, error: 'unknown external identity' }); return }
                  return writeJson(res, 200, ackMessage(aitlDb, { recipient: rec.sessionId, id: Number(body.id) }))
                }
                const externals = Object.entries(loadContacts(live.contactsFile)).filter(([, c]) => isInboxContact(c))
                const summary = externals.map(([name, c]) => {
                  const pending = aitlDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND status != 'acked'").get(c.sessionId)
                  return { name, sessionId: c.sessionId, pending: pending.n }
                })
                const who = url.searchParams.get('identity') ?? ''
                let messages = []
                if (who) {
                  const rec = loadContacts(live.contactsFile)[who]
                  if (isInboxContact(rec)) {
                    messages = aitlDb.prepare('SELECT id, sender, thread_id AS threadId, subject, body, status, created_at AS createdAt FROM messages WHERE recipient = ? ORDER BY id DESC LIMIT 200').all(rec.sessionId)
                  }
                }
                return writeJson(res, 200, { ok: true, externals: summary, identity: who || null, messages })
              }
              if (!effFlag('mcp.inbox.panel.enabled')) return writeJson(res, 503, { ok: false, error: 'inbox panel disabled', code: 'inbox_panel_disabled' })
              const who = url.searchParams.get('identity') ?? ''
              let rowsHtml = '<p style="color:#888">append ?identity=&lt;contact-name&gt; to view a maildrop</p>'
              if (who) {
                const rec = loadContacts(live.contactsFile)[who]
                const rows = isInboxContact(rec) ? aitlDb.prepare('SELECT id, sender, thread_id AS threadId, subject, body, status, created_at AS createdAt FROM messages WHERE recipient = ? ORDER BY id DESC LIMIT 200').all(rec.sessionId) : []
                rowsHtml = rows.length ? rows.map((r) => `
                  <tr><td>${r.id}</td><td>${escapeHtml(r.sender)}</td><td>${escapeHtml(r.threadId)}</td>
                  <td>${escapeHtml(r.subject)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.createdAt)}</td>
                  <td><pre style="white-space:pre-wrap;margin:0;max-width:60ch">${escapeHtml(r.body)}</pre></td></tr>`).join('')
                  : '<tr><td colspan="7" style="color:#888">empty</td></tr>'
              }
              const externals = Object.entries(loadContacts(live.contactsFile)).filter(([, c]) => isInboxContact(c))
              const html = `<!doctype html><html><head><meta charset="utf-8"><title>aitl inbox</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f5f5f5}</style>
</head><body><h2>agents-in-the-loop · inbox</h2>
<p>external identities: ${externals.length ? externals.map(([n]) => `<a href="?identity=${encodeURIComponent(n)}">${escapeHtml(n)}</a>`).join(' &middot; ') : '<i>none registered</i>'}</p>
<table><tr><th>id</th><th>sender</th><th>thread</th><th>subject</th><th>status</th><th>created</th><th>body</th></tr>${rowsHtml}</table>
</body></html>`
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end(html)
            },
          },
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
            // Config API (Config UI, host half): read the effective config
            // (boot + SQLite cfg.* overrides), write/clear overrides live.
            // Paths in RESTART_REQUIRED are boot-time (files, headers,
            // enablement of route surfaces) → 409 restart required.
            path: '/api/agents-in-the-loop/config',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              try {
                if (req.method === 'GET') {
                  effRefresh()
                  return writeJson(res, 200, {
                    ok: true,
                    effective: effAll(),
                    overrides: aitlDb ? getConfigOverrides(aitlDb) : {},
                    restartRequired: [...RESTART_REQUIRED],
                  })
                }
                if (req.method === 'POST') {
                  const body = await readBody(req)
                  if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
                  const path = typeof body.path === 'string' ? body.path.trim() : ''
                  if (!path || !/^[A-Za-z0-9_.-]+$/.test(path)) return writeJson(res, 400, { ok: false, error: 'path must be a non-empty dotted config path' })
                  if (RESTART_REQUIRED.has(path)) {
                    return writeJson(res, 409, { ok: false, error: 'restart required', restartRequired: true })
                  }
                  if (!aitlDb) return writeJson(res, 503, { ok: false, error: 'inbox disabled — config overrides need the SQLite store' })
                  setConfigOverride(aitlDb, path, body.value)
                  effRefresh()
                  return writeJson(res, 200, { ok: true, path, value: body.value, effective: getPath(effAll(), path) })
                }
                if (req.method === 'DELETE') {
                  let path = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path')
                  if (!path) {
                    const body = await readBody(req)
                    path = body && typeof body.path === 'string' ? body.path.trim() : ''
                  }
                  if (!path) return writeJson(res, 400, { ok: false, error: 'path required (query param or JSON body)' })
                  if (!aitlDb) return writeJson(res, 503, { ok: false, error: 'inbox disabled — config overrides need the SQLite store' })
                  clearConfigOverride(aitlDb, path)
                  effRefresh()
                  return writeJson(res, 200, { ok: true, cleared: path })
                }
                return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              } catch (e) {
                return writeJson(res, 500, { ok: false, error: e?.message ?? String(e) })
              }
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
                  if (body.cwd !== undefined && typeof body.cwd !== 'string') return writeJson(res, 400, { ok: false, error: 'cwd must be a workspace path string' })
                  const cwd = body.cwd?.trim() || ''
                  if (cwd && !(await wsRegistry?.list?.() || []).some((w) => w.path === cwd)) return writeJson(res, 400, { ok: false, error: 'cwd must match a registered workspace path' })
                  const record = {
                    sessionId,
                    ...(cwd ? { cwd } : {}),
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
                  if (body.cwd !== undefined) {
                    if (typeof body.cwd !== 'string') return writeJson(res, 400, { ok: false, error: 'cwd must be a workspace path string' })
                    const cwd = body.cwd.trim()
                    if (cwd && !(await wsRegistry?.list?.() || []).some((w) => w.path === cwd)) return writeJson(res, 400, { ok: false, error: 'cwd must match a registered workspace path' })
                    if (cwd) c.cwd = cwd
                    else delete c.cwd
                  }
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
                if (aitlDb && isInboxContact(contact)) {
                  const result = enqueueMessage(aitlDb, {
                    recipient: contact.sessionId, sender: from, body: message,
                    maxPending: aitlInboxCfg.maxPending, maxChars: aitlInboxCfg.maxChars,
                  })
                  return writeJson(res, result.ok ? 200 : 409, { ...result, contact: contactName, delivery: 'inbox' })
                }
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
          {
            path: '/api/agents-in-the-loop/catalog',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return writeJson(res, 200, await readCatalog({ agentCtx, wsCtx, wsRegistry }))
            },
          },
          {
            // v1.11.0 — workspace registry list for the identity picker.
            // Read-only projection of the durable workspace registry (same
            // face the spawner resolves against): id + path + title.
            path: '/api/agents-in-the-loop/workspaces',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              try {
                const workspaces = (wsRegistry?.list?.() ?? [])
                  .filter((w) => w?.id)
                  .map((w) => ({ id: w.id, path: w.path ?? '', title: w.title ?? w.name ?? '' }))
                return writeJson(res, 200, { ok: true, workspaces })
              } catch (e) {
                return writeJson(res, 500, { ok: false, error: e?.message ?? String(e) })
              }
            },
          },
          {
            // v1.11.0 — session-backed identities management API.
            //   GET    → identityManager.status() rows (live/orphan/offline)
            //   POST   → provision: {name, workspaceId, permission}
            //   PUT    → re-provision: {name, workspaceId?, permission?}
            //   DELETE → dispose: ?name=
            // All 503 while identities are disabled, the store is closed, or
            // the manager is unavailable (degraded). identities.enabled is
            // runtime-togglable; enabling constructs the manager on demand.
            path: '/api/agents-in-the-loop/identities',
            handler: async (req, res) => {
              if (!guard(req, res)) return
              try {
                if (!identitiesEff().enabled) return writeJson(res, 503, { ok: false, error: 'identities disabled (identities.enabled=false)' })
                if (!aitlDb) return writeJson(res, 503, { ok: false, error: 'inbox store closed — identities need the SQLite store (mcp.inbox.enabled)' })
                ensureIdentityManager()
                if (!identityManager) return writeJson(res, 503, { ok: false, error: 'identity manager unavailable (module missing or failed to initialize)' })
                if (req.method === 'GET') {
                  const identities = identityManager.status()
                  return writeJson(res, 200, { ok: true, identities: Array.isArray(identities) ? identities : [] })
                }
                if (req.method === 'POST') {
                  const body = await readBody(req)
                  if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
                  const name = normalizeContactName(body.name)
                  if (!name) return writeJson(res, 400, { ok: false, error: 'invalid name (lowercase [a-z0-9._-], ≤64 chars)' })
                  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : ''
                  const permission = typeof body.permission === 'string' && body.permission.trim() ? body.permission.trim() : 'read-only'
                  const idCfg = identitiesEff()
                  if (!idCfg.allowedPermissions.includes(permission)) {
                    return writeJson(res, 400, { ok: false, error: `permission "${permission}" not in identities.allowedPermissions [${idCfg.allowedPermissions.join(', ')}]` })
                  }
                  if (workspaceId && wsRegistry?.get && !wsRegistry.get(workspaceId)) {
                    return writeJson(res, 400, { ok: false, error: `workspace "${workspaceId}" not found in the workspace registry` })
                  }
                  const existing = identityManager.listAll?.() ?? identityManager.status()
                  if (existing.some((x) => x?.name === name)) return writeJson(res, 409, { ok: false, error: `identity "${name}" already exists (use PUT to re-provision)` })
                  if (existing.length >= idCfg.maxIdentities) return writeJson(res, 409, { ok: false, error: `identity cap ${idCfg.maxIdentities} reached (${existing.length} provisioned) — dispose one first` })
                  const r = await identityManager.register(name, workspaceId, { permission })
                  if (!r?.ok) return writeJson(res, 409, { ok: false, error: r?.error ?? 'provision failed' })
                  log(`[agents-in-the-loop] identity provisioned "${name}" → ${r.sessionId}${workspaceId ? ` ws=${workspaceId}` : ''} (${permission})`)
                  return writeJson(res, 200, { ok: true, name, sessionId: r.sessionId, workspaceId: workspaceId || null, permission })
                }
                if (req.method === 'PUT') {
                  const body = await readBody(req)
                  if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
                  const name = normalizeContactName(body.name)
                  if (!name) return writeJson(res, 400, { ok: false, error: 'invalid name' })
                  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : ''
                  const permission = typeof body.permission === 'string' && body.permission.trim() ? body.permission.trim() : ''
                  const idCfg = identitiesEff()
                  if (permission && !idCfg.allowedPermissions.includes(permission)) {
                    return writeJson(res, 400, { ok: false, error: `permission "${permission}" not in identities.allowedPermissions [${idCfg.allowedPermissions.join(', ')}]` })
                  }
                  if (workspaceId && wsRegistry?.get && !wsRegistry.get(workspaceId)) {
                    return writeJson(res, 400, { ok: false, error: `workspace "${workspaceId}" not found in the workspace registry` })
                  }
                  // Re-provision is identityManager.reprovision: NEW session
                  // first, re-point the contact, THEN dispose the old — a
                  // failed create leaves the old identity fully working.
                  const r = await identityManager.reprovision(name, { workspaceId: workspaceId || undefined, permission: permission || undefined })
                  if (!r?.ok) return writeJson(res, 409, { ok: false, error: r?.error ?? 're-provision failed' })
                  log(`[agents-in-the-loop] identity re-provisioned "${name}" → ${r.sessionId}${r.workspaceId ? ` ws=${r.workspaceId}` : ''}`)
                  return writeJson(res, 200, { ok: true, name, sessionId: r.sessionId, workspaceId: r.workspaceId ?? null, reprovisioned: true })
                }
                if (req.method === 'DELETE') {
                  const url = new URL(req.url, 'http://dsh.invalid')
                  const name = normalizeContactName(url.searchParams.get('name'))
                  if (!name) return writeJson(res, 400, { ok: false, error: 'name query param required' })
                  const r = await identityManager.deregister(name)
                  if (!r?.ok) return writeJson(res, 404, { ok: false, error: r?.error ?? `identity "${name}" not found` })
                  log(`[agents-in-the-loop] identity disposed "${name}"`)
                  return writeJson(res, 200, { ok: true, disposed: name })
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
        // MCP endpoint (v1.9.0): JSON-RPC 2.0 surface for EXTERNAL harnesses
        // (Claude Code, Codex, other DSH profiles via mcp_manager_add), hand-
        // rolled in lib/mcp.js on this existing server — zero dependencies.
        // Gated by mcp.enabled (default false); auth = loopback + bearer key.
        const mcpCfg = resolveMcpConfig(config)
        if (mcpCfg.enabled) {
          try {
            disposeRoutes.push(ctx.webServer.register(createMcpRouteLazy({
              mcp: { ...mcpCfg, identityHeader: inboxCfg.identityHeader },
              log,
              toolsService: ctx.get('tools'),
              writeJson,
              readBody,
              identityResolver: (name) => loadContacts(live.contactsFile)[name] ?? null,
              // v1.11.0 — session-backed identity exec: resolveExec returns
              // {ok, exec:{agent:<real handle>}} or {ok:false, error}; mcp.js
              // turns failures into JSON-RPC -32000 (fail-closed).
              identityExecResolver: async (name) => {
                if (!identitiesEff().enabled) return { ok: false, error: 'identities disabled (identities.enabled=false)' }
                try {
                  if (!ensureIdentityManager()) return { ok: false, error: 'identity manager unavailable (store not ready)' }
                  return await identityManager.resolveExec(name)
                } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
              },
          liveFlags: () => ({ allTools: eff('mcp.allTools') === true, panel: eff('mcp.inbox.panel.enabled') === true }),
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
            loadContacts: () => loadContacts(live.contactsFile),
            saveContacts: (contacts) => saveContacts(live.contactsFile, contacts),
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
        `[agents-in-the-loop] ready v1.10.0 — session_message=${live.sessionMessage} contacts=${live.contactsEnabled} spawn=${spawnCfg.enabled} mcp=${mcpState.enabled ? mcpState.path : 'off'} store=${live.contactsFile}`,
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
        try {
          disposeInboxTool?.()
        } catch {}
        for (const dispose of disposeRoutes) {
          try { dispose?.() } catch {}
        }
      }
    })
  })
}
