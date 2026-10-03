// Delivery smoke test with a mock cordis ctx (no DSH needed):
//   node --test test/
// Asserts every session_message lands exactly ONCE in the target and that
// nothing is registered on systemPrompt.context() (dsh 0.2 snapshots).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function makeAgent(id, status) {
  const calls = []
  return {
    id, status, calls,
    steer: (m) => calls.push(['steer', m]),
    followup: (m) => calls.push(['followup', m]),
    inject: (m) => calls.push(['inject', m]),
    ctx: { inject: () => { throw new Error('systemPrompt context must not be used') } },
  }
}

function setup(agents) {
  const dir = mkdtempSync(join(tmpdir(), 'aitl-'))
  const file = join(dir, 'contacts.json')
  writeFileSync(file, JSON.stringify({ version: 1, contacts: Object.fromEntries(
    agents.map((a) => [a.id.replace('session-', ''), { sessionId: a.id }])) }))
  const tools = {}
  const map = new Map(agents.map((a) => [a.id, a]))
  const agentsSvc = { get: (id) => map.get(id), list: () => [...map.values()] }
  const ctx = {
    inject: (_deps, fn) => fn(ctx),
    get: (name) => (name === 'tools' ? { register: (t) => { tools[t.name] = t; return () => {} } } : undefined),
    on: () => () => {},
    effect: () => {},
    agents: agentsSvc,
    webServer: { register: () => () => {} },
  }
  apply(ctx, { contacts: { file } })
  return tools
}

const send = (tools, from, args) =>
  tools.session_message.execute({ action: 'send', ...args }, { agent: { id: from } }).then((r) => JSON.parse(r.text))

test('idle target: exactly one steer, no inject', async () => {
  const b = makeAgent('session-b', 'idle')
  const tools = setup([makeAgent('session-a', 'idle'), b])
  const r = await send(tools, 'session-a', { target: 'b', message: 'hello' })
  assert.equal(r.ok, true)
  assert.deepEqual(b.calls.map((c) => c[0]), ['steer'])
  assert.match(b.calls[0][1].content[0].text, /hello/)
})

test('busy target: exactly one inject notice', async () => {
  const b = makeAgent('session-b', 'running')
  const tools = setup([makeAgent('session-a', 'idle'), b])
  const r = await send(tools, 'session-a', { target: 'b', message: 'hi' })
  assert.equal(r.delivery, 'notice')
  assert.deepEqual(b.calls.map((c) => c[0]), ['inject'])
  assert.equal(b.calls[0][1].source.kind, 'plugin:agents-in-the-loop')
})

test('wake:false on idle target: one queued inject, no wake', async () => {
  const b = makeAgent('session-b', 'idle')
  const tools = setup([makeAgent('session-a', 'idle'), b])
  await send(tools, 'session-a', { target: 'b', message: 'later', wake: false })
  assert.deepEqual(b.calls.map((c) => c[0]), ['inject'])
})

test('oversized message is truncated and carries the summary hint', async () => {
  const b = makeAgent('session-b', 'idle')
  const tools = setup([makeAgent('session-a', 'idle'), b])
  await send(tools, 'session-a', { target: 'b', message: 'x'.repeat(20000) })
  const text = b.calls[0][1].content[0].text
  assert.ok(text.length < 8600, `len ${text.length}`)
  assert.match(text, /truncated 12000 chars/)
  assert.match(text, /When summarizing\/compacting/)
})
