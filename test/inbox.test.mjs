// Inbox/callcenter tests (v1.10.0) — node:sqlite, identity, interception.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, loadContactsFromDb, saveContactsToDb, migrateContactsFromJson, enqueueMessage, pollInbox, ackMessage, listInbox, peekMessage, sweepInbox, isExternalSession } from '../lib/inbox.js'

const dir = mkdtempSync(join(tmpdir(), 'aitl-inbox-'))
const dbFile = join(dir, 'aitl.db')
const db = openStore(dbFile)

describe('inbox store (SQLite)', () => {
  test('schema + WAL', () => {
    const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    assert.equal(v.value, '1')
    const wm = db.prepare('PRAGMA journal_mode').get()
    assert.equal(wm.journal_mode, 'wal')
  })
  test('contacts round-trip + kind inference', () => {
    saveContactsToDb(db, {
      homey: { sessionId: 'session-abc123def4', label: 'l', tags: ['a'], note: '', createdAt: 't', updatedAt: 't' },
      codex: { sessionId: 'session-ext-codex', label: '', tags: [], note: '', createdAt: 't', updatedAt: 't' },
    })
    const c = loadContactsFromDb(db)
    assert.equal(c.homey.kind, 'local')
    assert.equal(c.codex.kind, 'external')
    assert.deepEqual(c.homey.tags, ['a'])
  })
  test('enqueue → poll (pending→delivered) → ack; no double-take', () => {
    const e1 = enqueueMessage(db, { recipient: 'session-ext-codex', sender: 'session-agent1', body: 'hello' })
    assert.equal(e1.ok, true)
    const p1 = pollInbox(db, { recipient: 'session-ext-codex' })
    assert.equal(p1.messages.length, 1)
    const p2 = pollInbox(db, { recipient: 'session-ext-codex', redeliverAfterMin: 5 })
    assert.equal(p2.messages.length, 0) // no double-take inside redeliver window
    const a = ackMessage(db, { recipient: 'session-ext-codex', id: e1.id })
    assert.equal(a.ok, true)
    assert.equal(listInbox(db, { recipient: 'session-ext-codex' }).messages.length, 0)
  })
  test('oversize + over-cap + unknown external recipient rejected (never truncated)', () => {
    assert.equal(enqueueMessage(db, { recipient: 'session-ext-codex', sender: 'x', body: 'x'.repeat(8001), maxChars: 8000 }).ok, false)
    assert.equal(enqueueMessage(db, { recipient: 'session-agent1', sender: 'x', body: 'hi' }).ok, false)
    for (let i = 0; i < 100; i++) enqueueMessage(db, { recipient: 'session-ext-codex', sender: 'x', body: `m${i}`, now: () => new Date(Date.now() - 100000 - i).toISOString() })
    assert.match(enqueueMessage(db, { recipient: 'session-ext-codex', sender: 'x', body: 'over' }).error, /inbox full/)
  })
  test('reply_to validated; threadId charset enforced; peek scoped', () => {
    const e = enqueueMessage(db, { recipient: 'session-ext-claude-code', sender: 'session-agent2', body: 'q' })
    assert.equal(enqueueMessage(db, { recipient: 'session-ext-claude-code', sender: 'session-agent2', body: 'r', replyTo: e.id }).ok, true)
    assert.equal(enqueueMessage(db, { recipient: 'session-ext-claude-code', sender: 'session-agent2', body: 'r', replyTo: 99999 }).ok, false)
    assert.equal(enqueueMessage(db, { recipient: 'session-ext-claude-code', sender: 'session-agent2', body: 'r', replyTo: e.id, threadId: 'BAD!' }).ok, false)
    const p = pollInbox(db, { recipient: 'session-ext-claude-code' })
    const peek = peekMessage(db, { recipient: 'session-ext-codex', id: p.messages[0].id })
    assert.equal(peek.ok, false) // not your maildrop
  })
  test('sweep removes expired', () => {
    enqueueMessage(db, { recipient: 'session-ext-sweep', sender: 'x', body: 'old', now: () => new Date(Date.now() - 8 * 86400000).toISOString() })
    const r = sweepInbox(db, { retentionDays: 7 })
    assert.ok(r.expiredAll >= 1)
  })
  test('JSON migration idempotent with .migrated rename', () => {
    const jsonFile = join(dir, 'contacts.json')
    writeFileSync(jsonFile, JSON.stringify({ version: 1, contacts: { claudecode: { sessionId: 'session-ext-claude-code', label: '', tags: [], note: '', createdAt: 't', updatedAt: 't' } } }))
    const r1 = migrateContactsFromJson(db, jsonFile)
    assert.equal(r1.imported, 1)
    assert.ok(r1.migratedFile.endsWith('.migrated'))
    assert.equal(loadContactsFromDb(db).claudecode.kind, 'external')
    const r2 = migrateContactsFromJson(db, jsonFile)
    assert.equal(r2.imported, 0) // json gone → no-op, rows intact
  })
  test('isExternalSession rejects legacy hex ids and bad ext names', () => {
    assert.equal(isExternalSession('session-abc123def4'), false)
    assert.equal(isExternalSession('session-ext-CODEX'), false)
    assert.equal(isExternalSession('session-ext-codex'), true)
  })
})
