import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Evaluate the shipped client, then drive its React element callbacks with
// a minimal hook renderer. No browser, React dependency, or network required.
const source = await readFile(new URL('../lib/client.bundled.js', import.meta.url), 'utf8')
function harness(respond) {
  let hooks = [], cursor = 0, effects = [], first = true, main
  const requests = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((x) => x !== false && x != null) }),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = initial
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
    },
    useEffect(fn) { if (first) effects.push(fn) },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const slots = {
    inject: (_, fn) => fn(),
    register: (definition, component) => { if (definition.name === 'main') main = component },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply({ slots }) } },
    fetch: async (url, options) => {
      const request = { path: url.replace('/api/agents-in-the-loop', ''), method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : undefined }
      requests.push(request)
      const result = respond(request)
      return { ok: result.status === undefined || result.status < 400, status: result.status || 200,
        text: async () => result.raw === undefined ? JSON.stringify(result.body) : result.raw }
    },
  })
  const render = (component, props = {}) => { cursor = 0; const tree = component(props); first = false; return tree }
  const app = main({}).type
  const appTree = render(app)
  const find = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return []
    return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap((child) => find(child, predicate))]
  }
  // App conditionally renders its tabs: switch its first state before
  // extracting the Contacts function, then reset hooks for that component.
  hooks[0] = 'contacts'
  const contacts = find(render(app), (n) => n.type?.name === 'ContactsTab')[0].type
  const inbox = find(appTree, (n) => n.type?.name === 'InboxTab')[0].type
  hooks = []; effects = []; first = true
  return {
    requests, render, find, contacts, inbox,
    async initialize(component, props) {
      render(component, props)
      for (const effect of effects) effect()
      await new Promise((resolve) => setImmediate(resolve))
      return render(component, props)
    },
    async settle() { await new Promise((resolve) => setImmediate(resolve)) },
  }
}

const ws = { id: 'workspace-a', title: 'Project A', path: '/project-a' }
const identity = { name: 'codex', identity: true, kind: 'local', sessionId: 'session-real-id', workspaceId: ws.id, identityMeta: { permission: 'read-only' } }
function contactsResponse({ path, method }) {
  if (method !== 'GET') return { body: { ok: true } }
  if (path === '/contacts') return { body: { contacts: [identity] } }
  if (path === '/config') return { body: { effective: { identities: { enabled: true, preset: 'standard', allowedPermissions: ['read-only', 'full'] } } } }
  if (path === '/identities') return { body: { identities: [{ name: identity.name, workspaceId: ws.id, live: true }] } }
  if (path === '/workspaces') return { body: { workspaces: [ws] } }
  throw new Error(`Unexpected request ${path}`)
}
const props = { notify() {}, reloadSessions() {}, globalQuery: '', sessions: [], mode: 'identities' }

test('real-session identity displays workspace and uses lifecycle controls', async () => {
  const ui = harness(contactsResponse)
  const tree = await ui.initialize(ui.contacts, props)
  assert.equal(ui.find(tree, (n) => n.type?.name === 'IdentityBadge')[0].props.st.live, true)
  assert.equal(ui.find(tree, (n) => n.type === 'div' && n.children.includes('Project A')).length, 1)
  const labels = ui.find(tree, (n) => n.type === 'button').flatMap((n) => n.children)
  assert.ok(labels.includes('Re-provision'))
  assert.ok(labels.includes('Dispose'))
  assert.ok(!labels.includes('Edit'))
  assert.ok(!labels.includes('Delete'))
})

test('ordinary contact retains editing without an unsupported provision action', async () => {
  const ui = harness((request) => request.path === '/contacts'
    ? { body: { contacts: [{ name: 'maintainer', sessionId: 'session-maintainer' }] } }
    : contactsResponse(request))
  const tree = await ui.initialize(ui.contacts, { ...props, mode: 'contacts' })
  const labels = ui.find(tree, (n) => n.type === 'button').flatMap((n) => n.children)
  assert.ok(labels.includes('Edit'))
  assert.ok(labels.includes('Delete'))
  assert.ok(!labels.includes('Provision identity'))
  assert.ok(!labels.includes('+ New identity'))
  assert.ok(!ui.requests.some((r) => r.path === '/identities'))
})

test('reprovision preserves current workspace despite new-identity workspace selection', async () => {
  const ui = harness(contactsResponse)
  let tree = await ui.initialize(ui.contacts, props)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('+ New identity'))[0].props.onClick()
  tree = ui.render(ui.contacts, props)
  assert.ok(ui.find(tree, (n) => n.type === 'div' && n.children.includes('Preset: standard')).length)
  ui.find(tree, (n) => n.type === 'select' && n.props.title)[0].props.onChange({ target: { value: 'workspace-b' } })
  tree = ui.render(ui.contacts, props)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('Re-provision'))[0].props.onClick()
  tree = ui.render(ui.contacts, props)
  await ui.find(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.deepEqual(ui.requests.find((r) => r.method === 'PUT').body, { name: 'codex' })
})

test('provision new identity without adding a manual contact', async () => {
  const ui = harness(contactsResponse)
  let tree = await ui.initialize(ui.contacts, props)
  assert.equal(ui.find(tree, (n) => n.type === 'form').length, 0)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('+ New identity'))[0].props.onClick()
  tree = ui.render(ui.contacts, props)
  ui.find(tree, (n) => n.type === 'input' && n.props.placeholder === 'codex-testing')[0].props.onChange({ target: { value: 'new-agent' } })
  ui.find(tree, (n) => n.type === 'select' && n.props.title)[0].props.onChange({ target: { value: ws.id } })
  tree = ui.render(ui.contacts, props)
  ui.find(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await ui.settle()
  assert.deepEqual(ui.requests.find((r) => r.method === 'POST').body, { name: 'new-agent', permission: 'read-only', workspaceId: ws.id })
  assert.ok(!ui.requests.some((r) => r.path === '/contacts' && r.method === 'POST'))
})

test('reprovision can explicitly change workspace and permission together', async () => {
  const ui = harness(contactsResponse)
  let tree = await ui.initialize(ui.contacts, props)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('Re-provision'))[0].props.onClick()
  tree = ui.render(ui.contacts, props)
  const selects = ui.find(tree, (n) => n.type === 'select')
  selects[0].props.onChange({ target: { value: ws.id } })
  selects[1].props.onChange({ target: { value: 'full' } })
  tree = ui.render(ui.contacts, props)
  await ui.find(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.deepEqual(ui.requests.find((r) => r.method === 'PUT').body, { name: 'codex', workspaceId: ws.id, permission: 'full' })
})

test('identity service errors are surfaced and lifecycle actions disabled', async () => {
  const ui = harness((request) => request.path === '/identities'
    ? { status: 503, body: { ok: false, error: 'identity manager unavailable' } }
    : contactsResponse(request))
  const tree = await ui.initialize(ui.contacts, props)
  assert.ok(ui.find(tree, (n) => n.type?.name === 'ErrorBanner').some((n) => n.props.error?.includes('identity manager unavailable')))
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Re-provision'))[0].props.disabled, true)
})

test('inbox selects real-session maildrop and suggests local reply contacts', async () => {
  const ui = harness(({ path }) => {
    if (path === '/config') return { body: { effective: { mcp: { inbox: { enabled: true, panel: { enabled: false } } } } } }
    if (path === '/contacts') return { body: { contacts: [identity, { name: 'maintainer', sessionId: 'session-maintainer' }] } }
    if (path === '/inbox?format=json') return { body: { externals: [{ name: 'codex', sessionId: 'session-real-id' }], identity: null, messages: [] } }
    if (path.endsWith('&identity=codex')) return { body: { messages: [{ id: 17, sender: 'maintainer', body: 'Reply', status: 'pending' }] } }
    throw new Error(`Unexpected request ${path}`)
  })
  const tree = await ui.initialize(ui.inbox, props)
  assert.equal(ui.find(tree, (n) => n.type === 'select')[0].props.value, 'codex')
  const suggestions = ui.find(tree, (n) => n.type === 'datalist')[0].children.map((n) => n.props.value)
  assert.ok(suggestions.includes('maintainer'))
  assert.ok(ui.find(tree, (n) => n.type === 'td' && n.children.includes('17')).length)
})

test('plain-text 404 reports the unavailable route without a JSON parsing error', async () => {
  const ui = harness((request) => request.path === '/identities'
    ? { status: 404, raw: 'Not Found' } : contactsResponse(request))
  const tree = await ui.initialize(ui.contacts, props)
  const errors = ui.find(tree, (n) => n.type?.name === 'ErrorBanner').map((n) => n.props.error).filter(Boolean)
  assert.ok(errors.some((message) => message.includes('/identities is unavailable') && message.includes('HTTP 404')))
  assert.ok(errors.every((message) => !message.includes('Unexpected token')))
})

test('disabled identities show capability guidance and prevent provisioning', async () => {
  const ui = harness((request) => request.path === '/config'
    ? { body: { effective: { identities: { enabled: false } } } } : contactsResponse(request))
  const tree = await ui.initialize(ui.contacts, props)
  assert.ok(ui.find(tree, (n) => n.type?.name === 'Notice').some((n) => n.props.text.includes('identities.enabled')))
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('+ New identity'))[0].props.disabled, true)
  assert.ok(!ui.requests.some((r) => r.path === '/identities'))
})

test('disabled inbox shows capability guidance without querying the mailbox route', async () => {
  const ui = harness(({ path }) => {
    if (path === '/config') return { body: { effective: { mcp: { inbox: { enabled: false } } } } }
    if (path === '/contacts') return { body: { contacts: [] } }
    throw new Error(`Unexpected request ${path}`)
  })
  const tree = await ui.initialize(ui.inbox, props)
  assert.ok(ui.find(tree, (n) => n.type?.name === 'Notice').some((n) =>
    n.props.text.includes('plugin startup configuration') && n.props.text.includes('mcp.inbox.enabled') && n.props.text.includes('reload the plugin')))
  assert.ok(!ui.requests.some((r) => r.path.startsWith('/inbox')))
  assert.equal(ui.find(tree, (n) => n.type === 'form').length, 0)
})

test('blank identity preset warns about unverified fallback before provisioning', async () => {
  const ui = harness((request) => request.path === '/config'
    ? { body: { effective: { identities: { enabled: true, preset: '', allowedPermissions: ['read-only'] } } } }
    : contactsResponse(request))
  const tree = await ui.initialize(ui.contacts, props)
  assert.ok(ui.find(tree, (n) => n.type?.name === 'Notice').some((n) =>
    n.props.text.includes('aitl-identity') && n.props.text.includes('has not been verified') && n.props.text.includes('identities.preset')))
  assert.ok(ui.find(tree, (n) => n.type === 'span' && n.children.includes('Preset: aitl-identity (fallback; unverified)')).length)
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('+ New identity'))[0].props.disabled, true)
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Re-provision'))[0].props.disabled, true)
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Dispose'))[0].props.disabled, false)
})
