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
  hooks[0] = 'config'
  const config = find(render(app), (n) => n.type?.name === 'ConfigTab')[0].type
  const inbox = find(appTree, (n) => n.type?.name === 'InboxTab')[0].type
  hooks = []; effects = []; first = true
  return {
    requests, render, find, contacts, inbox, config,
    mount(component, props) { hooks = []; effects = []; first = true; return render(component, props) },
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

test('ordinary idle and busy sessions are shown live instead of offline', async () => {
  for (const status of ['idle', 'busy']) {
    const ui = harness((request) => request.path === '/contacts'
      ? { body: { contacts: [{ name: 'worker', sessionId: 'session-worker' }] } } : contactsResponse(request))
    const tree = await ui.initialize(ui.contacts, { ...props, mode: 'contacts', sessions: [{ id: 'session-worker', status }] })
    assert.equal(ui.find(tree, (n) => n.type?.name === 'LiveBadge')[0].props.online, true)
  }
})

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

const catalog = {
  models: [{ provider: 'provider-a', model: 'model-a', label: 'Model A' }, { provider: 'provider-b', model: 'model-b', label: 'Model B' }],
  presets: [{ id: 'standard', title: 'Standard' }], workspaces: [ws], permissions: ['read-only', 'workspace-write'], errors: {},
}
const configTree = { spawn: { provider: 'provider-a', model: 'model-a', preset: 'standard', allowedModels: ['provider-a/model-a'], workspaces: [ws.id] },
  identities: { provider: '', model: '', preset: 'standard', allowedPermissions: ['read-only'] },
  mc: { provider: 'provider-a', model: 'model-a', projects: { sample: { workspaceId: ws.id, model: { provider: 'provider-b', model: 'model-b' } } } } }
async function configUI(overrides = {}) {
  const ui = harness(({ path }) => {
    if (path === '/config') return { body: { effective: configTree, overrides: {}, restartRequired: [] } }
    if (path === '/catalog') return { body: { ok: true, ...catalog, ...overrides } }
    throw new Error(`Unexpected request ${path}`)
  })
  const tree = await ui.initialize(ui.config, props)
  return { ui, tree, rows: ui.find(tree, (n) => n.type?.name === 'ConfigRow') }
}

test('semantic configuration uses live system choices including nested MC paths', async () => {
  const { ui, rows } = await configUI()
  for (const path of ['spawn.provider', 'spawn.model', 'spawn.preset', 'spawn.allowedModels', 'spawn.workspaces', 'identities.model', 'identities.provider', 'identities.allowedPermissions', 'mc.projects.sample.workspaceId', 'mc.projects.sample.model.provider', 'mc.projects.sample.model.model']) {
    const row = rows.find((n) => n.props.row.path === path)
    assert.ok(row, path)
    const tree = ui.mount(row.type, row.props)
    assert.equal(ui.find(tree, (n) => n.type === 'select').length, 1, path)
    assert.equal(ui.find(tree, (n) => n.type === 'input' && n.props.type === 'text').length, 0, path)
  }
})

test('model choices follow edited provider and require provider save first', async () => {
  const { ui, rows } = await configUI()
  const row = rows.find((n) => n.props.row.path === 'spawn.model')
  const tree = ui.mount(row.type, { ...row.props, drafts: { 'spawn.provider': 'provider-b' } })
  const select = ui.find(tree, (n) => n.type === 'select')[0]
  assert.ok(select.children.some((n) => n.props.value === 'model-b' && !n.props.disabled))
  assert.ok(select.children.some((n) => n.props.value === 'model-a' && n.props.disabled && n.children[0].includes('unavailable')))
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Save'))[0].props.disabled, true)
})

test('catalog errors disable choices and never become selectable values', async () => {
  const { ui, rows } = await configUI({ models: [], errors: { models: 'Model registry unavailable' } })
  const row = rows.find((n) => n.props.row.path === 'spawn.model')
  const tree = ui.mount(row.type, row.props)
  const select = ui.find(tree, (n) => n.type === 'select')[0]
  assert.equal(select.props.disabled, true)
  assert.ok(select.children.every((n) => n.props.value !== 'Model registry unavailable'))
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Save'))[0].props.disabled, true)
})

test('partial catalog failure preserves available model choices', async () => {
  const { ui, rows } = await configUI({ errors: { models: 'One provider is unavailable' } })
  const row = rows.find((n) => n.props.row.path === 'spawn.model')
  const tree = ui.mount(row.type, row.props)
  assert.equal(ui.find(tree, (n) => n.type === 'select')[0].props.disabled, false)
  assert.ok(ui.find(tree, (n) => n.type === 'option').some((n) => n.props.value === 'model-a'))
})

test('allowlists use multiple selection and support clearing unavailable values', async () => {
  const { ui, rows } = await configUI()
  const row = rows.find((n) => n.props.row.path === 'spawn.workspaces')
  const rowProps = { ...row.props, row: { path: row.props.row.path, value: ['missing-workspace'] }, onDraft() {} }
  let tree = ui.mount(row.type, rowProps)
  assert.equal(ui.find(tree, (n) => n.type === 'select')[0].props.multiple, true)
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Save'))[0].props.disabled, true)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('Clear selection'))[0].props.onClick()
  tree = ui.render(row.type, rowProps)
  assert.equal(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Save'))[0].props.disabled, false)
})

test('contact editor chooses registered sessions and workspace paths', async () => {
  const ui = harness(contactsResponse)
  const contactProps = { ...props, mode: 'contacts', sessions: [{ id: 'session-one', title: 'Maintainer', status: 'active' }] }
  let tree = await ui.initialize(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('+ Add contact'))[0].props.onClick()
  tree = ui.render(ui.contacts, contactProps)
  const selects = ui.find(tree, (n) => n.type === 'select')
  assert.ok(selects.some((s) => s.children.some((o) => o.props?.value === 'session-one')))
  assert.ok(selects.some((s) => s.children.some((o) => o.props?.value === ws.path && o.children[0] === `${ws.title} · ${ws.path}`)))
  assert.equal(ui.find(tree, (n) => n.type === 'input' && n.props.placeholder === '/path/to/workspace').length, 0)
  assert.ok(ui.find(tree, (n) => n.type === 'button' && n.children.includes('Refresh sessions')).length)
})

test('contact rename keeps original lookup name and explicitly clears workspace override', async () => {
  const ui = harness((request) => request.path === '/contacts' && request.method === 'GET'
    ? { body: { contacts: [{ name: 'old-name', sessionId: 'session-one', cwd: ws.path }] } }
    : contactsResponse(request))
  const contactProps = { ...props, mode: 'contacts', sessions: [{ id: 'session-one' }] }
  let tree = await ui.initialize(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('Edit'))[0].props.onClick()
  tree = ui.render(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'input' && n.props.placeholder === 'unique contact name')[0].props.onChange({ target: { value: 'new-name' } })
  ui.find(tree, (n) => n.type === 'select' && n.props.value === ws.path)[0].props.onChange({ target: { value: '' } })
  tree = ui.render(ui.contacts, contactProps)
  await ui.find(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.deepEqual(ui.requests.find((r) => r.method === 'PUT').body, { name: 'old-name', rename: 'new-name', sessionId: 'session-one', cwd: '', label: '', tags: [], note: '' })
})

test('create contact submits the selected session and registered workspace path', async () => {
  const ui = harness(contactsResponse)
  const contactProps = { ...props, mode: 'contacts', sessions: [{ id: 'session-one' }] }
  let tree = await ui.initialize(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('+ Add contact'))[0].props.onClick()
  tree = ui.render(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'input' && n.props.placeholder === 'unique contact name')[0].props.onChange({ target: { value: 'new-contact' } })
  const selects = ui.find(tree, (n) => n.type === 'select')
  selects[0].props.onChange({ target: { value: 'session-one' } })
  selects[1].props.onChange({ target: { value: ws.path } })
  tree = ui.render(ui.contacts, contactProps)
  await ui.find(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.deepEqual(ui.requests.find((r) => r.method === 'POST').body, { name: 'new-contact', sessionId: 'session-one', cwd: ws.path, label: '', tags: [], note: '' })
})

test('invalid legacy external ID blocks contact creation before API submission', async () => {
  const ui = harness(contactsResponse)
  const contactProps = { ...props, mode: 'contacts' }
  let tree = await ui.initialize(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'button' && n.children.includes('+ Add contact'))[0].props.onClick()
  tree = ui.render(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'input' && n.props.placeholder === 'unique contact name')[0].props.onChange({ target: { value: 'new-contact' } })
  ui.find(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } })
  tree = ui.render(ui.contacts, contactProps)
  ui.find(tree, (n) => n.type === 'input' && n.props.placeholder === 'session-ext-…')[0].props.onChange({ target: { value: 'session-ext-Invalid_id' } })
  tree = ui.render(ui.contacts, contactProps)
  await ui.find(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.ok(!ui.requests.some((r) => r.method === 'POST'))
  tree = ui.render(ui.contacts, contactProps)
  assert.ok(ui.find(tree, (n) => n.type?.name === 'ErrorBanner').some((n) => n.props.error?.includes('lowercase')))
})
