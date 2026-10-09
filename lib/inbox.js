// Inbox / callcenter store for dsh-agents-in-the-loop (v1.10.0).
//
// ONE SQLite database (~/.dsh/aitl.db by default) backs BOTH the contacts
// directory (replacing the JSON file — drop-in loadContacts/saveContacts
// semantics) and the external-harness inbox (messages queued for MCP
// clients that poll at the start of their turns). node:sqlite is built
// into Node 22+ — zero npm dependencies, nothing for pnpm to prune.
//
// Identity model (Mark decision D1/D6): ONE shared bearer key for auth.
// Per-harness identity = the contact the harness registered for itself,
// whose sessionId is `session-ext-<name>` (kind external). MCP callers
// present `X-Aitl-Identity: <contact-name>`; the endpoint resolves it to
// that contact's session id and the caller's exec.agent.id becomes it.
// Spoofing risk is inherent to the shared key and accepted (loopback +
// key = trust boundary), documented in the plan §9-G1.
//
// Delivery semantics (D2-D4, §9): dsh→external session_message to an
// external contact ENQUEUES (pending → delivered on poll → acked;
// at-least-once with redeliver window after redeliverAfterMin; per-thread
// FIFO by id; TTL retentionDays; maxPending cap per recipient — send
// REJECTS oversize and over-cap, never truncates). external→dsh keeps the
// proven direct path. Poll is ONE synchronous transaction (BEGIN IMMEDIATE
// … COMMIT, no await inside) so two pollers cannot double-take.

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, renameSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SCHEMA_VERSION = 1
export const EXTERNAL_SESSION_RE = /^session-ext-[a-z0-9][a-z0-9-]{1,62}$/

export function isExternalSession(sessionId) {
  return typeof sessionId === 'string' && EXTERNAL_SESSION_RE.test(sessionId)
}

export function resolveInboxConfig(config = {}) {
  const raw = config.mcp?.inbox ?? {}
  const home = homedir()
  const p = (v, dflt) => (typeof v === 'string' && v ? (v.startsWith('~/') ? join(home, v.slice(2)) : v) : dflt)
  return {
    enabled: raw.enabled === true,
    file: p(raw.file, join(home, '.dsh', 'aitl.db')),
    maxChars: Number.isFinite(raw.maxChars) && raw.maxChars > 0 ? raw.maxChars : 8000,
    maxPending: Number.isFinite(raw.maxPending) && raw.maxPending > 0 ? raw.maxPending : 100,
    retentionDays: Number.isFinite(raw.retentionDays) && raw.retentionDays > 0 ? raw.retentionDays : 7,
    redeliverAfterMin: Number.isFinite(raw.redeliverAfterMin) && raw.redeliverAfterMin > 0 ? raw.redeliverAfterMin : 5,
    identityHeader: typeof raw.identityHeader === 'string' && raw.identityHeader ? raw.identityHeader.toLowerCase() : 'x-aitl-identity',
    panel: raw.panel?.enabled === true,
  }
}

let dbCache = { file: null, db: null }

export function openStore(file, { log = () => {} } = {}) {
  if (dbCache.file === file && dbCache.db) return dbCache.db
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS contacts (
      name TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      label TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      note TEXT DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'local' CHECK (kind IN ('local','external')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      sender TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      reply_to INTEGER,
      subject TEXT DEFAULT '',
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','acked')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_status ON messages(recipient, status, id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `)
  const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  if (!v) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  dbCache = { file, db }
  log(`[agents-in-the-loop] inbox store open: ${file} (schema v${SCHEMA_VERSION})`)
  return db
}

// ── Contacts backend: drop-in replacement for loadContacts/saveContacts ──
// Records keep the JSON shape ({sessionId,label,tags,note,createdAt,
// updatedAt}) plus an inferred `kind` so existing call sites need no
// changes. saveContacts(fullObject) syncs the whole table in one
// transaction (call sites pass the complete next-state object).

export function loadContactsFromDb(db) {
  const rows = db.prepare('SELECT * FROM contacts ORDER BY name').all()
  const out = {}
  for (const r of rows) {
    let tags = []
    try { tags = JSON.parse(r.tags || '[]') } catch {}
    out[r.name] = {
      sessionId: r.session_id,
      label: r.label,
      tags,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      kind: isExternalSession(r.session_id) ? 'external' : 'local',
    }
  }
  return out
}

export function saveContactsToDb(db, contacts) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM contacts')
    const ins = db.prepare('INSERT INTO contacts (name, session_id, label, tags, note, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [name, c] of Object.entries(contacts)) {
      ins.run(
        name,
        String(c.sessionId ?? ''),
        String(c.label ?? ''),
        JSON.stringify(Array.isArray(c.tags) ? c.tags : []),
        String(c.note ?? ''),
        isExternalSession(c.sessionId) ? 'external' : 'local',
        String(c.createdAt ?? new Date().toISOString()),
        String(c.updatedAt ?? new Date().toISOString()),
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

// One-time idempotent migration: JSON contacts → SQLite. The JSON file is
// renamed to `.migrated` only AFTER a successful import (import re-run with
// the JSON gone and rows already present = no-op).
export function migrateContactsFromJson(db, jsonFile, { log = () => {} } = {}) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM contacts").get()
  if (!existsSync(jsonFile)) return { imported: 0, migratedFile: null, alreadyDone: row.n > 0 }
  let contacts = {}
  try {
    const data = JSON.parse(readFileSync(jsonFile, 'utf-8'))
    contacts = data && typeof data.contacts === 'object' && data.contacts ? data.contacts : {}
  } catch (e) {
    return { imported: 0, error: `unreadable JSON: ${e?.message}` }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const ins = db.prepare('INSERT OR REPLACE INTO contacts (name, session_id, label, tags, note, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [name, c] of Object.entries(contacts)) {
      ins.run(name, String(c.sessionId ?? ''), String(c.label ?? ''), JSON.stringify(Array.isArray(c.tags) ? c.tags : []), String(c.note ?? ''), isExternalSession(c.sessionId) ? 'external' : 'local', String(c.createdAt ?? new Date().toISOString()), String(c.updatedAt ?? new Date().toISOString()))
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    return { imported: 0, error: e?.message ?? String(e) }
  }
  const migratedFile = `${jsonFile}.migrated`
  try { renameSync(jsonFile, migratedFile) } catch (e) {
    return { imported: Object.keys(contacts).length, error: `import ok but rename failed: ${e?.message}` }
  }
  log(`[agents-in-the-loop] contacts migrated to SQLite: ${Object.keys(contacts).length} contacts → ${migratedFile}`)
  return { imported: Object.keys(contacts).length, migratedFile }
}

// ── Maildrop queue (dsh → external) ─────────────────────────────────────

export function enqueueMessage(db, { recipient, sender, body, threadId = null, replyTo = null, subject = '', maxPending = 100, maxChars = 8000, now = () => new Date().toISOString() }) {
  if (!isExternalSession(recipient)) return { ok: false, error: `recipient "${recipient}" is not an external inbox (session-ext-… required)` }
  if (typeof body !== 'string' || body.length === 0) return { ok: false, error: 'body required' }
  if (body.length > maxChars) return { ok: false, error: `body ${body.length} chars exceeds inbox cap ${maxChars} — split the message` }
  const cap = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND status != 'acked'").get(recipient)
  if (cap.n >= maxPending) return { ok: false, error: `inbox full for ${recipient} (${cap.n}/${maxPending} unacked) — recipient must ack` }
  if (threadId != null && !/^[a-z0-9-]{6,64}$/.test(String(threadId))) return { ok: false, error: 'threadId must match [a-z0-9-]{6,64}' }
  if (replyTo != null) {
    const ref = db.prepare('SELECT recipient, sender FROM messages WHERE id = ?').get(Number(replyTo))
    if (!ref) return { ok: false, error: `reply_to ${replyTo} not found` }
    if (ref.sender !== sender && ref.recipient !== sender) return { ok: false, error: `reply_to ${replyTo} is not in this conversation` }
  }
  const tid = threadId ?? `thr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const r = db.prepare('INSERT INTO messages (recipient, sender, thread_id, reply_to, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(recipient, sender, tid, replyTo, String(subject ?? ''), body, 'pending', now())
  return { ok: true, id: Number(r.lastInsertRowid), threadId: tid, recipient, status: 'pending' }
}

// Poll = ONE synchronous transaction. Two concurrent pollers cannot
// double-take: DatabaseSync is synchronous and BEGIN IMMEDIATE serializes.
export function pollInbox(db, { recipient, redeliverAfterMin = 5, limit = 20, now = () => new Date().toISOString() }) {
  if (!isExternalSession(recipient)) return { ok: false, error: `no inbox for "${recipient}" (external identities only)` }
  const cutoff = new Date(Date.now() - redeliverAfterMin * 60_000).toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db.prepare(`
      SELECT id, sender, thread_id AS threadId, reply_to AS replyTo, subject, body, status, created_at AS createdAt
      FROM messages
      WHERE recipient = ? AND (status = 'pending' OR (status = 'delivered' AND delivered_at < ?))
      ORDER BY id ASC LIMIT ?`).all(recipient, cutoff, limit)
    const mark = db.prepare("UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?")
    for (const r of rows) mark.run(now(), r.id)
    db.exec('COMMIT')
    return { ok: true, messages: rows }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    return { ok: false, error: e?.message ?? String(e) }
  }
}

export function ackMessage(db, { recipient, id, now = () => new Date().toISOString() }) {
  const r = db.prepare('SELECT recipient, status FROM messages WHERE id = ?').get(Number(id))
  if (!r || r.recipient !== recipient) return { ok: false, error: `message ${id} not in your inbox` }
  if (r.status === 'acked') return { ok: true, id: Number(id), status: 'acked', already: true }
  db.prepare("UPDATE messages SET status = 'acked', acked_at = ? WHERE id = ?").run(now(), Number(id))
  return { ok: true, id: Number(id), status: 'acked' }
}

export function listInbox(db, { recipient, includeAcked = false }) {
  const where = includeAcked ? '' : " AND status != 'acked'"
  const rows = db.prepare(`
    SELECT id, sender, thread_id AS threadId, subject, status, created_at AS createdAt, length(body) AS bodyChars
    FROM messages WHERE recipient = ?${where} ORDER BY id DESC LIMIT 100`).all(recipient)
  return { ok: true, messages: rows }
}

export function sweepInbox(db, { retentionDays, now = () => new Date().toISOString() }) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
  const r = db.prepare("DELETE FROM messages WHERE acked_at IS NOT NULL AND acked_at < ? OR created_at < ? AND status = 'acked'").run(cutoff, cutoff)
  // hard-delete expired unacked too (TTL beats delivery)
  const r2 = db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff)
  return { expiredAcked: r.changes, expiredAll: r2.changes, at: now() }
}

export function peekMessage(db, { recipient, id }) {
  const r = db.prepare('SELECT id, recipient, sender, thread_id AS threadId, subject, body, status, created_at AS createdAt FROM messages WHERE id = ?').get(Number(id))
  if (!r || r.recipient !== recipient) return { ok: false, error: `message ${id} not in your inbox` }
  return { ok: true, message: r }
}
