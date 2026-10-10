// Client UI for agents-in-the-loop (v2.0.0) — sidebar entry "AITL" + keyed
// main page with local tabs: Inbox | Identities | Contacts | Config, plus a global
// search box that filters the active tab. Registration shapes follow the
// QA-verified pattern from dsh-keyword-injector/lib/client.js:
//   sidebar.panellist entry (id: 'agents-in-the-loop') → keyed `main` page
//   (key: 'agents-in-the-loop' — `main` is KEYED, `key:` not `id:`).
// All data goes over the plugin's loopback JSON API (same origin, loopback
// guard — no auth header needed from the browser).
// Theming: colors come ONLY from DSH shell tokens (--dsw-alias-*) via
// color-mix tints — zero hex values, so everything flips with light/dark.

window.__ModuleLoader__.load({
  id: 'dsh-agents-in-the-loop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------------
    // Tokens (see dsh-keyword-injector/lib/ui.js for the verified mapping)
    // ------------------------------------------------------------------
    const T = (name) => `var(--dsw-alias-${name})`
    const tint = (name, pct) => `color-mix(in srgb, ${T(name)} ${pct}%, transparent)`
    const ink = (name) => `color-mix(in srgb, ${T(name)} 78%, ${T('label-primary')})`
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

    const C = {
      text: T('label-primary'),
      muted: T('label-secondary'),
      bg: T('bg-module-platform'),
      bgBase: T('bg-base'),
      hover: T('interactive-bg-hover'),
      border: T('border-l2'),
      borderStrong: T('border-l3'),
      accent: T('brand-primary'),
      accentText: T('bg-base'),
      danger: ink('state-error-primary'),
      warn: ink('state-warn-primary'),
      ok: ink('state-success-primary'),
      business: ink('state-business-primary'),
    }

    const S = {
      page: { padding: '24px', maxWidth: '1150px', margin: '0 auto', color: C.text, fontFamily: 'inherit', fontSize: '13px', lineHeight: 1.5 },
      headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
      title: { fontSize: 20, fontWeight: 600, margin: 0, color: C.text },
      subtitle: { fontSize: 13, color: C.muted, marginTop: 4 },
      headerActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16, flexWrap: 'wrap' },
      tab: (active) => ({
        padding: '8px 16px', cursor: 'pointer', border: 'none', background: 'transparent',
        color: active ? C.text : C.muted, fontSize: 13, fontWeight: active ? 600 : 500,
        borderBottom: `2px solid ${active ? C.accent : 'transparent'}`, marginBottom: -1,
      }),
      sectionTitle: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.muted, margin: '20px 0 8px' },
      btn: {
        cursor: 'pointer', border: `1px solid ${C.border}`, background: 'transparent', color: C.text,
        padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
      },
      btnPrimary: { background: C.accent, color: C.accentText, borderColor: C.accent },
      btnDanger: { color: C.danger, borderColor: tint('state-error-primary', 45) },
      btnSmall: { padding: '3px 9px', fontSize: 11 },
      input: {
        padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.border}`,
        background: C.bgBase, color: C.text, fontSize: 13, outline: 'none', boxSizing: 'border-box',
      },
      search: {
        width: '100%', padding: '8px 12px', boxSizing: 'border-box', background: C.bgBase,
        border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, fontSize: 13, outline: 'none',
        marginBottom: 12,
      },
      tableWrap: { overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
      th: { textAlign: 'left', padding: '9px 12px', fontWeight: 600, color: C.muted, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' },
      td: { padding: '9px 12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' },
      mono: { fontFamily: MONO, fontSize: '11.5px' },
      truncate: { maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      empty: { padding: '40px 16px', textAlign: 'center', color: C.muted },
      bannerError: { padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: '13px', background: tint('state-error-primary', 10), border: `1px solid ${tint('state-error-primary', 45)}`, color: C.danger },
      bannerInfo: { padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: '13px', background: tint('state-business-primary', 10), border: `1px solid ${tint('state-business-primary', 45)}`, color: C.business },
      bannerOk: { padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: '13px', background: tint('state-success-primary', 10), border: `1px solid ${tint('state-success-primary', 45)}`, color: C.ok },
      card: { border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, padding: 16, marginBottom: 16 },
      formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
      formRow: { display: 'flex', flexDirection: 'column', gap: 4 },
      formLabel: { fontSize: '11px', fontWeight: 600, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.04em' },
      rowFlex: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      muted: { color: C.muted },
      spacer: { flex: 1 },
    }

    const badge = (bgTok, inkCol) => ({
      display: 'inline-block', padding: '2px 8px', fontSize: '11px', fontWeight: 600,
      borderRadius: 999, background: tint(bgTok, 12), border: `1px solid ${tint(bgTok, 45)}`, color: inkCol,
    })
    const BADGE_OK = () => badge('state-success-primary', C.ok)
    const BADGE_WARN = () => badge('state-warn-primary', C.warn)
    const BADGE_ERR = () => badge('state-error-primary', C.danger)
    const BADGE_INFO = () => badge('state-business-primary', C.business)
    const BADGE_NEUTRAL = () => ({
      display: 'inline-block', padding: '2px 8px', fontSize: '11px', fontWeight: 600,
      borderRadius: 999, background: C.bg, border: `1px solid ${C.border}`, color: C.muted,
    })

    // ------------------------------------------------------------------
    // API helpers
    // ------------------------------------------------------------------
    const BASE = '/api/agents-in-the-loop'

    async function apiResponse(r, path) {
      const raw = await r.text()
      let d
      try { d = JSON.parse(raw) } catch {
        const error = new Error(r.ok ? `Unexpected response from ${path}. Refresh after updating the plugin.`
          : r.status === 404 ? `${path} is unavailable in the running plugin (HTTP 404).`
            : `Request to ${path} failed (HTTP ${r.status}).`)
        error.status = r.status
        throw error
      }
      if (!r.ok || d?.ok === false) {
        const error = new Error(d?.error || `Request to ${path} failed (HTTP ${r.status}).`)
        error.status = r.status
        throw error
      }
      return d || {}
    }
    async function apiGet(path) { return apiResponse(await fetch(BASE + path), path) }
    async function apiSend(path, method, body) {
      const r = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return apiResponse(r, path)
    }

    // kind may be absent on legacy rows — infer external from session-ext-.
    const isExternal = (c) => Boolean(c && (c.identity === true || (c.kind
      ? c.kind === 'external'
      : String(c.sessionId || '').startsWith('session-ext-'))))

    const fmtTime = (iso) => {
      if (!iso) return '—'
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return String(iso)
        return d.toLocaleString()
      } catch { return String(iso) }
    }

    // ------------------------------------------------------------------
    // Shared small components
    // ------------------------------------------------------------------
    function ErrorBanner({ error, onDismiss }) {
      if (!error) return null
      return h('div', { style: S.bannerError, role: 'alert' },
        h('span', null, String(error)),
        onDismiss && h('button', { style: { ...S.btn, ...S.btnSmall, marginLeft: 10 }, onClick: onDismiss }, 'Dismiss'))
    }

    function Notice({ text, tone }) {
      if (!text) return null
      const style = tone === 'ok' ? S.bannerOk : tone === 'err' ? S.bannerError : S.bannerInfo
      return h('div', { style }, text)
    }

    function Empty({ text }) {
      return h('div', { style: S.empty }, text)
    }

    function StatusBadge({ status }) {
      const s = String(status || '')
      if (s === 'acked') return h('span', { style: BADGE_OK() }, 'acked')
      if (s === 'delivered') return h('span', { style: BADGE_WARN() }, 'delivered')
      if (s === 'pending') return h('span', { style: BADGE_NEUTRAL() }, 'pending')
      return h('span', { style: BADGE_NEUTRAL() }, s || '—')
    }

    function KindBadge({ external }) {
      return external
        ? h('span', { style: BADGE_INFO() }, 'external')
        : h('span', { style: BADGE_NEUTRAL() }, 'local')
    }

    function IdentityBadge({ st }) {
      if (!st) return h('span', { style: BADGE_NEUTRAL() }, 'identity · status unavailable')
      if (st.orphan) return h('span', { style: BADGE_WARN() }, 'identity · orphan')
      return st.live
        ? h('span', { style: BADGE_OK() }, 'identity · live')
        : h('span', { style: BADGE_NEUTRAL() }, 'identity · offline')
    }

    function LiveBadge({ online }) {
      if (online === undefined) return h('span', { style: BADGE_NEUTRAL() }, 'unknown')
      return online
        ? h('span', { style: BADGE_OK() }, 'live')
        : h('span', { style: BADGE_NEUTRAL() }, 'offline')
    }

    // ==================================================================
    // INBOX TAB
    // ==================================================================
    function InboxTab({ notify, globalQuery }) {
      const [externals, setExternals] = React.useState([])
      const [identity, setIdentity] = React.useState('')
      const [contacts, setContacts] = React.useState([])
      const [messages, setMessages] = React.useState([])
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [disabledReason, setDisabledReason] = React.useState('')
      const [query, setQuery] = React.useState(globalQuery || '')

      // The header search feeds the active tab's local filter.
      React.useEffect(() => { setQuery(globalQuery) }, [globalQuery])

      const [compose, setCompose] = React.useState({ target: '', message: '', subject: '', threadId: '' })
      const [sending, setSending] = React.useState(false)

      const load = React.useCallback(async (who) => {
        setBusy(true)
        setError(null)
        try {
          const config = await apiGet('/config')
          const inbox = config.effective?.mcp?.inbox
          if (!inbox?.enabled) {
            setDisabledReason('Inbox is disabled in the plugin startup configuration. Enable mcp.inbox.enabled there and reload the plugin.')
            setMessages([]); setExternals([]); setIdentity('')
            return
          }
          setDisabledReason('')
          const q = who ? `&identity=${encodeURIComponent(who)}` : ''
          const d = await apiGet(`/inbox?format=json${q}`)
          setExternals(Array.isArray(d.externals) ? d.externals : [])
          const selected = d.identity || (d.externals || [])[0]?.name || ''
          if (!who && selected) {
            const mailbox = await apiGet(`/inbox?format=json&identity=${encodeURIComponent(selected)}`)
            setIdentity(selected)
            setMessages(Array.isArray(mailbox.messages) ? mailbox.messages : [])
            return
          }
          setIdentity(selected)
          setMessages(Array.isArray(d.messages) ? d.messages : [])
        } catch (e) {
          setError(`Inbox load failed: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => { load('') }, [load]) // initial load (server default identity)
      React.useEffect(() => {
        apiGet('/contacts').then((d) => setContacts(Array.isArray(d.contacts) ? d.contacts : []))
          .catch((e) => setError(`Contact suggestions unavailable: ${e.message}`))
      }, [])

      const pickIdentity = (who) => { setIdentity(who); load(who) }

      const ack = async (id) => {
        setBusy(true)
        try {
          await apiSend('/inbox?format=json&op=ack', 'POST', { identity, id })
          notify('Message acknowledged', 'ok')
          load(identity)
        } catch (e) {
          setError(`Ack failed: ${e.message}`)
        } finally { setBusy(false) }
      }

      const send = async (e) => {
        e.preventDefault()
        if (!compose.target.trim() || !compose.message.trim()) {
          setError('Compose: target and message are required.')
          return
        }
        setSending(true)
        setError(null)
        try {
          const body = { target: compose.target.trim(), message: compose.message }
          if (compose.subject.trim()) body.subject = compose.subject.trim()
          if (compose.threadId.trim()) body.threadId = compose.threadId.trim()
          const d = await apiSend('/inbox?format=json&op=send', 'POST', body)
          notify(`Sent to ${compose.target.trim()} (${d.delivery || 'inbox'})`, 'ok')
          setCompose({ target: '', message: '', subject: '', threadId: '' })
          load(identity)
        } catch (e2) {
          setError(`Send failed: ${e2.message}`)
        } finally { setSending(false) }
      }

      const q = query.trim().toLowerCase()
      const filtered = q
        ? messages.filter((m) =>
          [m.sender, m.threadId, m.subject, m.body, String(m.id)]
            .some((v) => String(v || '').toLowerCase().includes(q)))
        : messages

      const maildropOptions = externals.length
        ? externals
        : (identity ? [{ name: identity, pending: messages.filter((m) => m.status !== 'acked').length }] : [])

      if (disabledReason) return h('div', null,
        h(ErrorBanner, { error }),
        h(Notice, { text: disabledReason }),
        h('button', { style: S.btn, disabled: busy, onClick: () => load('') }, busy ? 'Loading…' : 'Refresh'))

      return h('div', null,
        h(ErrorBanner, { error, onDismiss: () => setError(null) }),
        h('div', { style: { ...S.rowFlex, marginBottom: 12 } },
          h('label', { style: { ...S.formLabel, marginRight: 4 } }, 'Maildrop'),
          h('select', {
            value: identity, disabled: busy, onChange: (e) => pickIdentity(e.target.value),
            style: { ...S.input, maxWidth: 320, padding: '6px 8px' },
          },
            maildropOptions.length === 0 && h('option', { value: '' }, '— no external maildrops —'),
            maildropOptions.map((ex) => h('option', { key: ex.name, value: ex.name },
              `${ex.name}${ex.pending ? ` (${ex.pending} pending)` : ''}`))),
          h('button', { style: S.btn, disabled: busy, onClick: () => load(identity) }, busy ? 'Loading…' : 'Refresh'),
          h('div', { style: S.spacer }),
          h('span', { style: S.muted }, `${filtered.length}${q ? ' / ' + messages.length : ''} message${filtered.length === 1 ? '' : 's'}`)),
        h('input', {
          style: S.search, type: 'search', placeholder: 'Search messages — sender, thread, subject, body…',
          value: query, onChange: (e) => setQuery(e.target.value),
        }),
        h('div', { style: { ...S.sectionTitle, marginTop: 8 } }, 'Messages'),
        filtered.length === 0
          ? h(Empty, { text: q ? 'No messages match the search.' : 'No messages in this maildrop.' })
          : h('div', { style: S.tableWrap },
            h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', null, 'ID'), h('th', null, 'Sender'), h('th', null, 'Thread'),
                h('th', null, 'Status'), h('th', null, 'Created'), h('th', null, 'Body'), h('th', null, ''))),
              h('tbody', null, filtered.map((m) => h('tr', { key: m.id },
                h('td', { style: { ...S.td, ...S.mono } }, String(m.id)),
                h('td', { style: S.td }, String(m.sender || '—')),
                h('td', { style: { ...S.td, ...S.mono } }, h('div', { style: S.truncate }, String(m.threadId || '—'))),
                h('td', { style: S.td }, h(StatusBadge, { status: m.status })),
                h('td', { style: { ...S.td, ...S.muted, whiteSpace: 'nowrap' } }, fmtTime(m.createdAt)),
                h('td', { style: S.td },
                  h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: 360 } },
                    m.subject ? h('div', { style: { fontWeight: 600, marginBottom: 2 } }, String(m.subject)) : null,
                    String(m.body || ''))),
                h('td', { style: S.td },
                  m.status !== 'acked'
                    ? h('button', { style: { ...S.btn, ...S.btnSmall }, disabled: busy, onClick: () => ack(m.id) }, 'Ack')
                    : h('span', { style: S.muted }, '—'))))))),
        h('div', { style: S.sectionTitle }, 'Compose'),
        h('form', { style: S.card, onSubmit: send },
          h('div', { style: S.formGrid },
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Target contact'),
              h('input', {
                style: S.input, list: 'aitl-contact-names', value: compose.target, required: true,
                placeholder: 'contact name (external → inbox, dsh → direct)',
                onChange: (e) => setCompose((c) => ({ ...c, target: e.target.value })),
              })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Subject (optional)'),
              h('input', { style: S.input, value: compose.subject, onChange: (e) => setCompose((c) => ({ ...c, subject: e.target.value })) })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Thread ID (optional)'),
              h('input', { style: { ...S.input, ...S.mono }, value: compose.threadId, onChange: (e) => setCompose((c) => ({ ...c, threadId: e.target.value })) }))),
          h('div', { style: { ...S.formRow, marginTop: 10 } },
            h('label', { style: S.formLabel }, 'Message'),
            h('textarea', {
              style: { ...S.input, minHeight: 80, resize: 'vertical', fontFamily: 'inherit' },
              value: compose.message, onChange: (e) => setCompose((c) => ({ ...c, message: e.target.value })),
            })),
          h('div', { style: { ...S.rowFlex, marginTop: 10 } },
            h('button', { type: 'submit', style: { ...S.btn, ...S.btnPrimary }, disabled: sending }, sending ? 'Sending…' : 'Send'),
            h('datalist', { id: 'aitl-contact-names' },
              contacts.map((c) => h('option', { key: c.name, value: c.name }))))),
      )
    }

    // ==================================================================
    // CONTACTS TAB
    // ==================================================================
    const EMPTY_FORM = { name: '', sessionId: '', label: '', tags: '', note: '', cwd: '' }

    function ContactsTab({ notify, globalQuery, sessions, reloadSessions, mode = 'contacts' }) {
      const identityView = mode === 'identities'
      const [contacts, setContacts] = React.useState([])
      const [identities, setIdentities] = React.useState([])
      const [workspaces, setWorkspaces] = React.useState([])
      const [provWorkspace, setProvWorkspace] = React.useState('')
      const [identityName, setIdentityName] = React.useState('')
      const [permission, setPermission] = React.useState('read-only')
      const [identityConfig, setIdentityConfig] = React.useState(null)
      const [identityError, setIdentityError] = React.useState(null)
      const [actionBusy, setActionBusy] = React.useState(false)
      const [identityFormOpen, setIdentityFormOpen] = React.useState(false)
      const [externalContact, setExternalContact] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [query, setQuery] = React.useState(globalQuery || '')
      React.useEffect(() => { setQuery(globalQuery) }, [globalQuery])

      const [editing, setEditing] = React.useState(null) // null + formOpen = add mode; string = original name
      const [formOpen, setFormOpen] = React.useState(false)
      const [form, setForm] = React.useState(EMPTY_FORM)
      const [saving, setSaving] = React.useState(false)
      const [confirmDelete, setConfirmDelete] = React.useState(null)
      const [confirmAction, setConfirmAction] = React.useState(null) // { kind: 'reprov'|'dispose', name }

      const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const d = await apiGet('/contacts')
          setContacts(Array.isArray(d.contacts) ? d.contacts : [])
        } catch (e) {
          setError(`Contacts load failed: ${e.message}`)
        }
        if (!identityView) {
          try {
            const dw = await apiGet('/workspaces')
            setWorkspaces(Array.isArray(dw.workspaces) ? dw.workspaces : [])
          } catch (e) { setError(`Workspace choices unavailable: ${e.message}`) }
          setLoading(false); return
        }
        setIdentityError(null)
        try {
          const cfg = await apiGet('/config')
          const ids = cfg.effective?.identities || {}
          setIdentityConfig(ids)
          setPermission((current) => (ids.allowedPermissions || ['read-only']).includes(current)
            ? current : (ids.allowedPermissions || ['read-only'])[0] || '')
          if (ids.enabled) {
            const di = await apiGet('/identities')
            setIdentities(Array.isArray(di.identities) ? di.identities : [])
          } else setIdentities([])
          const dw = await apiGet('/workspaces')
          setWorkspaces(Array.isArray(dw.workspaces) ? dw.workspaces : [])
        } catch (e) { setIdentityError(`Identity controls unavailable: ${e.message}`) }
        finally { setLoading(false) }
      }, [identityView])

      React.useEffect(() => { load() }, [load])

      const identityStatus = (name) => identities.find((x) => x.name === name) || null
      const isIdentityContact = (c) => c.identity === true || Boolean(identityStatus(c.name))
      const presetReady = Boolean(identityConfig?.preset?.trim())

      const provision = async (name, permission) => {
        setError(null)
        if (!presetReady) { setError('Set identities.preset to an installed preset before provisioning.'); return }
        if (!name.trim() || !provWorkspace) { setError('Identity name and an explicit workspace are required.'); return }
        setActionBusy(true)
        try {
          const body = { name, permission: permission || 'read-only' }
          if (provWorkspace) body.workspaceId = provWorkspace
          await apiSend('/identities', 'POST', body)
          notify(`Identity ${name} provisioned`, 'ok')
          setIdentityName('')
          setIdentityFormOpen(false)
          load(); reloadSessions()
        } catch (e) {
          setError(`Provision failed: ${e.message}`)
        } finally { setActionBusy(false) }
      }

      const reprovision = async (name) => {
        setError(null)
        if (!presetReady) { setError('Set identities.preset to an installed preset before re-provisioning.'); return }
        setActionBusy(true)
        try {
          const body = { name }
          if (confirmAction?.workspaceId) body.workspaceId = confirmAction.workspaceId
          if (confirmAction?.permission) body.permission = confirmAction.permission
          await apiSend('/identities', 'PUT', body)
          notify(`Identity ${name} re-provisioned`, 'ok')
          setConfirmAction(null)
          load(); reloadSessions()
        } catch (e) {
          setError(`Re-provision failed: ${e.message}`)
        } finally { setActionBusy(false) }
      }

      const dispose = async (name) => {
        setError(null)
        setActionBusy(true)
        try {
          await apiSend(`/identities?name=${encodeURIComponent(name)}`, 'DELETE')
          notify(`Identity ${name} disposed`, 'ok')
          setConfirmAction(null)
          load(); reloadSessions()
        } catch (e) {
          setError(`Dispose failed: ${e.message}`)
        } finally { setActionBusy(false) }
      }

      const sessionOnline = (sessionId) => {
        const hit = (sessions || []).find((s) => s.id === sessionId)
        if (!hit) return undefined
        const st = String(hit.status || '').toLowerCase()
        return st === '' ? undefined : (st === 'online' || st === 'active' || st === 'running' || st === 'live')
      }

      const openAdd = () => { setEditing(null); setForm(EMPTY_FORM); setExternalContact(false); setFormOpen(true) }
      const openEdit = (c) => {
        setEditing(c.name)
        setExternalContact(String(c.sessionId || '').startsWith('session-ext-'))
        setForm({
          name: c.name || '',
          sessionId: c.sessionId || '',
          label: c.label || '',
          tags: Array.isArray(c.tags) ? c.tags.join(', ') : (c.tags || ''),
          note: c.note || '',
          cwd: c.cwd || '',
        })
        setFormOpen(true)
      }
      const closeForm = () => { setFormOpen(false); setEditing(null); setForm(EMPTY_FORM) }

      const save = async (e) => {
        e.preventDefault()
        if (!form.name.trim()) { setError('Name is required.'); return }
        if (!form.sessionId.trim()) { setError('Session ID is required (session-ext-… for external contacts, else the dsh session id).'); return }
        if (externalContact && !/^session-ext-[a-z0-9][a-z0-9-]{1,62}$/.test(form.sessionId.trim())) {
          setError('Legacy external IDs require session-ext- followed by 2–63 lowercase letters, digits, or hyphens, starting with a letter or digit.'); return
        }
        setSaving(true)
        setError(null)
        try {
          const payload = {
            name: form.name.trim(),
            sessionId: form.sessionId.trim(),
            cwd: form.cwd.trim(),
            label: form.label.trim(),
            tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
            note: form.note.trim(),
          }
          if (editing) {
            await apiSend('/contacts', 'PUT', { ...payload, name: editing, rename: payload.name })
            notify(`Contact ${editing} updated`, 'ok')
          } else {
            await apiSend('/contacts', 'POST', payload)
            notify(`Contact ${payload.name} added`, 'ok')
          }
          closeForm()
          load(); reloadSessions()
        } catch (e2) {
          setError(`Save failed: ${e2.message}`)
        } finally { setSaving(false) }
      }

      const doDelete = async (name) => {
        setError(null)
        try {
          await apiSend(`/contacts?name=${encodeURIComponent(name)}`, 'DELETE')
          notify(`Contact ${name} deleted`, 'ok')
          setConfirmDelete(null)
          load(); reloadSessions()
        } catch (e) {
          setError(`Delete failed: ${e.message}`)
        }
      }

      const q = query.trim().toLowerCase()
      const visibleContacts = contacts.filter((c) => identityView === isIdentityContact(c))
      const filtered = q
        ? visibleContacts.filter((c) =>
          [c.name, c.sessionId, c.label, c.workspaceId, c.cwd, Array.isArray(c.tags) ? c.tags.join(' ') : c.tags, c.note]
            .some((v) => String(v || '').toLowerCase().includes(q)))
        : visibleContacts

      return h('div', null,
        h(ErrorBanner, { error, onDismiss: () => setError(null) }),
        h(ErrorBanner, { error: identityError }),
        identityView && identityConfig && !identityConfig.enabled && h(Notice, { text: 'Workspace identities are disabled. Enable identities.enabled in Config, then refresh Identities.' }),
        identityView && identityConfig?.enabled && !identityConfig.preset?.trim() && h(Notice, {
          text: 'No identity preset is configured. The plugin falls back to aitl-identity; its availability has not been verified. Set identities.preset to an installed preset before provisioning.',
        }),
        identityView && confirmAction && h('form', { style: S.card,
          onSubmit: (e) => { e.preventDefault(); return confirmAction.kind === 'reprov' ? reprovision(confirmAction.name) : dispose(confirmAction.name) } },
          h('div', { style: { ...S.sectionTitle, marginTop: 0 } }, `${confirmAction.kind === 'reprov' ? 'Re-provision' : 'Dispose'} ${confirmAction.name}`),
          confirmAction.kind === 'reprov'
            ? h('div', { style: S.formGrid },
              h('label', { style: S.formRow }, h('span', { style: S.formLabel }, 'Workspace'),
                h('select', { style: S.input, value: confirmAction.workspaceId || '', disabled: actionBusy,
                  onChange: (e) => setConfirmAction((a) => ({ ...a, workspaceId: e.target.value })) },
                  h('option', { value: '' }, 'Keep current workspace'),
                  workspaces.map((w) => h('option', { key: w.id, value: w.id }, w.title || w.path || w.id)))),
              h('label', { style: S.formRow }, h('span', { style: S.formLabel }, 'Permission'),
                h('select', { style: S.input, value: confirmAction.permission || '', disabled: actionBusy,
                  onChange: (e) => setConfirmAction((a) => ({ ...a, permission: e.target.value })) },
                  h('option', { value: '' }, 'Keep current permission'),
                  (identityConfig?.allowedPermissions || []).map((p) => h('option', { key: p, value: p }, p)))))
            : h('p', { style: S.muted }, 'This removes the identity contact and disposes its session.'),
          h('div', { style: { ...S.rowFlex, marginTop: 12 } },
            h('button', { type: 'submit', disabled: actionBusy || loading || !identityConfig?.enabled || Boolean(identityError) || (confirmAction.kind === 'reprov' && !presetReady),
              style: { ...S.btn, ...(confirmAction.kind === 'dispose' ? S.btnDanger : S.btnPrimary) } },
              actionBusy ? 'Working…' : confirmAction.kind === 'reprov' ? 'Confirm re-provision' : 'Confirm dispose'),
            h('button', { type: 'button', disabled: actionBusy, style: S.btn, onClick: () => setConfirmAction(null) }, 'Cancel'))),
        identityView && identityConfig?.enabled && identityFormOpen && h('form', {
          style: S.card, onSubmit: (e) => { e.preventDefault(); provision(identityName.trim(), permission) },
        },
          h('div', { style: { ...S.sectionTitle, marginTop: 0 } }, 'Provision workspace identity'),
          h('div', { style: { ...S.muted, marginBottom: 10 } }, `Preset: ${identityConfig.preset?.trim() || 'aitl-identity (fallback; unverified)'}`),
          h('div', { style: S.formGrid },
            h('label', { style: S.formRow }, h('span', { style: S.formLabel }, 'Identity name'),
              h('input', { style: S.input, value: identityName, required: true, pattern: '[a-z0-9._-]{1,64}',
                placeholder: 'codex-testing', onChange: (e) => setIdentityName(e.target.value) })),
            h('label', { style: S.formRow }, h('span', { style: S.formLabel }, 'Workspace'),
              h('select', { style: S.input, value: provWorkspace, required: true,
                title: 'Workspace for provisioning new identities', onChange: (e) => setProvWorkspace(e.target.value) },
                h('option', { value: '' }, 'Select workspace'),
                workspaces.map((w) => h('option', { key: w.id, value: w.id }, w.title || w.path || w.id)))),
            h('label', { style: S.formRow }, h('span', { style: S.formLabel }, 'Permission'),
              h('select', { style: S.input, value: permission, onChange: (e) => setPermission(e.target.value) },
                (identityConfig.allowedPermissions || ['read-only']).map((p) => h('option', { key: p, value: p }, p))))),
          h('div', { style: { ...S.rowFlex, marginTop: 10 } },
            h('button', { type: 'submit', style: { ...S.btn, ...S.btnPrimary }, disabled: actionBusy || loading || !presetReady || !permission || !provWorkspace || Boolean(identityError) },
              actionBusy ? 'Working…' : 'Provision'),
            h('button', { type: 'button', style: S.btn, disabled: actionBusy, onClick: () => setIdentityFormOpen(false) }, 'Cancel'))),
        h('div', { style: { ...S.rowFlex, marginBottom: 12 } },
          identityView
            ? h('button', { style: { ...S.btn, ...S.btnPrimary }, disabled: loading || actionBusy || !presetReady || !identityConfig?.enabled || Boolean(identityError),
              onClick: () => { setIdentityFormOpen(true); setConfirmAction(null) } }, '+ New identity')
            : h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: openAdd }, '+ Add contact'),
          h('button', { style: S.btn, onClick: load, disabled: loading }, loading ? 'Loading…' : 'Refresh'),
          identityView && identityConfig?.enabled && h('span', { style: S.muted }, `Preset: ${identityConfig.preset?.trim() || 'aitl-identity (fallback; unverified)'}`),
          h('div', { style: S.spacer }),
          h('span', { style: S.muted }, `${filtered.length}${q ? ' / ' + visibleContacts.length : ''} ${identityView ? 'identities' : 'contacts'}`)),
        h('input', {
          style: S.search, type: 'search', placeholder: identityView ? 'Search identities — name, workspace, session…' : 'Search contacts — name, session, label, tags…',
          value: query, onChange: (e) => setQuery(e.target.value),
        }),
        formOpen && h('form', { style: S.card, onSubmit: save },
          h('div', { style: { ...S.sectionTitle, margin: '0 0 10px' } }, editing ? `Edit contact — ${editing}` : 'New contact'),
          h('div', { style: S.formGrid },
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Name'),
              h('input', { style: S.input, value: form.name, placeholder: 'unique contact name', onChange: (e) => setForm((f) => ({ ...f, name: e.target.value })) })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Session ID'),
              externalContact
                ? h('input', { style: { ...S.input, ...S.mono }, value: form.sessionId, pattern: 'session-ext-[a-z0-9][a-z0-9-]{1,62}',
                  placeholder: 'session-ext-…', onChange: (e) => setForm((f) => ({ ...f, sessionId: e.target.value })) })
                : h('select', { style: S.input, value: form.sessionId,
                  onChange: (e) => setForm((f) => ({ ...f, sessionId: e.target.value })) },
                  h('option', { value: '' }, sessions?.length ? 'Select a session' : 'No sessions loaded — refresh sessions'),
                  form.sessionId && !(sessions || []).some((s) => s.id === form.sessionId) && h('option', { value: form.sessionId, disabled: true }, `${form.sessionId} (unavailable)`),
                  (sessions || []).map((s) => h('option', { key: s.id, value: s.id }, `${s.title || s.id}${s.status ? ` · ${s.status}` : ''}`))),
              h('label', { style: S.rowFlex }, h('input', { type: 'checkbox', checked: externalContact,
                onChange: (e) => { setExternalContact(e.target.checked); setForm((f) => ({ ...f, sessionId: '' })) } }), 'Legacy external contact (advanced)'),
              h('button', { type: 'button', style: { ...S.btn, ...S.btnSmall }, onClick: reloadSessions }, 'Refresh sessions')),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Label'),
              h('input', { style: S.input, value: form.label, placeholder: 'human-friendly label', onChange: (e) => setForm((f) => ({ ...f, label: e.target.value })) })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Tags (comma-separated)'),
              h('input', { style: S.input, value: form.tags, placeholder: 'dev, review', onChange: (e) => setForm((f) => ({ ...f, tags: e.target.value })) })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Workspace (cwd)'),
              h('select', { style: S.input, value: form.cwd, onChange: (e) => setForm((f) => ({ ...f, cwd: e.target.value })) },
                h('option', { value: '' }, 'No workspace override'),
                form.cwd && !workspaces.some((w) => w.path === form.cwd) && h('option', { value: form.cwd, disabled: true }, `${form.cwd} (unavailable)`),
                workspaces.map((w) => h('option', { key: w.id, value: w.path }, w.title ? `${w.title} · ${w.path}` : w.path || w.id))),
              !workspaces.length && h('span', { style: S.muted }, 'No registered workspaces. Refresh after registering a workspace.'))),
          h('div', { style: { ...S.formRow, marginTop: 10 } },
            h('label', { style: S.formLabel }, 'Note'),
            h('textarea', {
              style: { ...S.input, minHeight: 56, resize: 'vertical', fontFamily: 'inherit' },
              value: form.note, onChange: (e) => setForm((f) => ({ ...f, note: e.target.value })),
            })),
          h('div', { style: { ...S.rowFlex, marginTop: 10 } },
            h('button', { type: 'submit', style: { ...S.btn, ...S.btnPrimary }, disabled: saving }, saving ? 'Saving…' : (editing ? 'Update' : 'Add')),
            h('button', { type: 'button', style: S.btn, onClick: closeForm }, 'Cancel'))),
        filtered.length === 0
          ? h(Empty, { text: q ? 'No matches.' : identityView ? 'No workspace identities. Create an identity to give an external agent a workspace and inbox.' : 'No contacts registered yet.' })
          : h('div', { style: S.tableWrap },
            h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', null, 'Name'), h('th', null, 'Session ID'), !identityView && h('th', null, 'Kind'),
                h('th', null, 'Status'), identityView && h('th', null, 'Workspace / permission'), !identityView && h('th', null, 'Label'), !identityView && h('th', null, 'Tags'),
                !identityView && h('th', null, 'Note'), !identityView && h('th', null, 'Updated'), h('th', null, ''))),
              h('tbody', null, filtered.map((c) => {
                const external = isExternal(c)
                const st = identityStatus(c.name)
                const identity = isIdentityContact(c)
                const online = identity ? st?.live : sessionOnline(c.sessionId)
                const workspaceId = st?.workspaceId || c.workspaceId
                const workspace = workspaces.find((w) => w.id === workspaceId)
                return h('tr', { key: c.name },
                  h('td', { style: { ...S.td, fontWeight: 600 } }, String(c.name || '—')),
                  h('td', { style: { ...S.td, ...S.mono } }, h('div', { title: c.sessionId, style: S.truncate }, String(c.sessionId || '—'))),
                  !identityView && h('td', { style: S.td }, h(KindBadge, { external })),
                  h('td', { style: S.td }, identity ? h(IdentityBadge, { st }) : h(LiveBadge, { online })),
                  identityView && h('td', { style: S.td },
                    h('div', { title: workspaceId || c.cwd, style: { fontWeight: 500, wordBreak: 'break-word' } }, workspace?.title || workspace?.path || c.cwd || workspaceId || '—'),
                    workspace?.title && (workspace.path || c.cwd) && h('div', { style: { ...S.mono, ...S.muted, wordBreak: 'break-word' } }, workspace.path || c.cwd),
                    identity && h('div', { style: S.muted }, c.identityMeta?.permission || 'permission unknown')),
                  !identityView && h('td', { style: { ...S.td, ...S.muted } }, String(c.label || '—')),
                  !identityView && h('td', { style: S.td },
                    Array.isArray(c.tags) && c.tags.length
                      ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                        c.tags.map((t) => h('span', { key: String(t), style: BADGE_NEUTRAL() }, String(t))))
                      : h('span', { style: S.muted }, '—')),
                  !identityView && h('td', { style: { ...S.td, ...S.muted } }, h('div', { style: S.truncate }, String(c.note || '—'))),
                  !identityView && h('td', { style: { ...S.td, ...S.muted, whiteSpace: 'nowrap' } }, fmtTime(c.updatedAt)),
                  h('td', { style: S.td },
                    h('div', { style: { display: 'flex', gap: 6, whiteSpace: 'nowrap', flexWrap: 'wrap' } },
                      identity && h('button', { disabled: actionBusy || loading || !presetReady || !identityConfig?.enabled || Boolean(identityError), style: { ...S.btn, ...S.btnSmall },
                        onClick: () => { setIdentityFormOpen(false); setConfirmAction({ kind: 'reprov', name: c.name, workspaceId: '', permission: '' }) } }, 'Re-provision'),
                      identity && h('button', { disabled: actionBusy || loading || !identityConfig?.enabled || Boolean(identityError), style: { ...S.btn, ...S.btnSmall, ...S.btnDanger },
                        onClick: () => { setIdentityFormOpen(false); setConfirmAction({ kind: 'dispose', name: c.name }) } }, 'Dispose'),
                      !identity && h('button', { style: { ...S.btn, ...S.btnSmall }, onClick: () => openEdit(c) }, 'Edit'),
                      !identity && (confirmDelete === c.name
                        ? h('button', { style: { ...S.btn, ...S.btnSmall, ...S.btnDanger }, onClick: () => doDelete(c.name) }, 'Confirm delete')
                        : h('button', { style: { ...S.btn, ...S.btnSmall, ...S.btnDanger }, onClick: () => setConfirmDelete(c.name) }, 'Delete')))))
              })))),
      )
    }

    // ==================================================================
    // CONFIG TAB
    // ==================================================================
    // Flatten the effective config tree into leaf rows: { path, value }.
    function flattenConfig(obj, prefix) {
      const rows = []
      if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
        rows.push({ path: prefix, value: obj })
        return rows
      }
      for (const key of Object.keys(obj)) {
        const val = obj[key]
        const p = prefix ? `${prefix}.${key}` : key
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
          rows.push(...flattenConfig(val, p))
        } else {
          rows.push({ path: p, value: val })
        }
      }
      return rows
    }

    function configChoices(path, catalog, tree, drafts) {
      const group = path.split('.')[0]
      const key = path.split('.').pop()
      const parentPath = path.split('.').slice(0, -1).join('.')
      const providerPath = `${parentPath}.provider`
      const models = Array.isArray(catalog?.models) ? catalog.models : []
      const optional = group === 'identities' || key === 'preset'
      const pair = parentPath.split('.').reduce((value, part) => value?.[part], tree) || {}
      const provider = drafts?.[providerPath] ?? (pair.provider || tree?.[group]?.provider || tree?.spawn?.provider || '')
      if (key === 'provider') return { source: 'models', optional,
        options: [...new Set(models.map((m) => m.provider).filter(Boolean))].map((value) => ({ value, label: value })) }
      if (key === 'model') return { source: 'models', optional,
        blocked: drafts?.[providerPath] !== undefined && drafts[providerPath] !== (pair.provider || ''),
        options: models.filter((m) => m.provider === provider).map((m) => ({ value: m.model, label: m.label || `${m.provider}/${m.model}` })) }
      if (key === 'allowedModels') return { source: 'models', options: models.map((m) => ({ value: `${m.provider}/${m.model}`, label: m.label || `${m.provider}/${m.model}` })) }
      if (key === 'preset' || key === 'allowedPresets') return { source: 'presets', optional,
        options: (catalog?.presets || []).map((p) => ({ value: p.id, label: p.title || p.id })) }
      if (key === 'workspaces' || key === 'allowedWorkspaces' || key === 'workspaceId') return { source: 'workspaces', optional: key === 'workspaceId',
        options: (catalog?.workspaces || []).map((w) => ({ value: w.id, label: w.title ? `${w.title} · ${w.path}` : w.path || w.id })) }
      if (key === 'allowedPermissions') return { source: 'permissions',
        options: (catalog?.permissions || []).map((value) => ({ value, label: value })) }
      return null
    }

    function ConfigRow({ row, overrides, restartRequired, notify, onSaved, catalog, tree, drafts, onDraft }) {
      const original = Array.isArray(row.value) ? row.value.join(', ')
        : (row.value === undefined || row.value === null ? '' : String(row.value))
      const [value, setValue] = React.useState(original)
      const [saving, setSaving] = React.useState(false)
      const [err, setErr] = React.useState(null)
      const hasOverride = Boolean(overrides[row.path])
      const needsRestart = (restartRequired || []).indexOf(row.path) !== -1
      const isBool = typeof row.value === 'boolean'
      const isNum = typeof row.value === 'number'
      const dirty = value !== original
      const choices = configChoices(row.path, catalog, tree, drafts)
      const multiple = Array.isArray(row.value)
      const selected = multiple ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : [String(value)]
      const unavailable = choices ? selected.filter((v) => !(v === '' && choices.optional) && !choices.options.some((o) => o.value === v)) : []
      const catalogProblem = choices && (!catalog || choices.options.length === 0)
      const invalid = choices && (catalogProblem || unavailable.length > 0 || choices.blocked || (!multiple && !choices.optional && !value))
      const change = (next) => { setValue(next); onDraft?.(row.path, next) }
      const emptyListHelp = row.path.endsWith('.allowedPresets') ? 'Empty allows any installed preset.'
        : row.path.endsWith('.allowedModels') ? 'Empty removes the model allowlist restriction.'
          : row.path.endsWith('.workspaces') || row.path.endsWith('.allowedWorkspaces') ? 'Empty removes the workspace allowlist; an omitted workspace uses the caller’s workspace.'
            : row.path.endsWith('.allowedPermissions') ? 'Empty uses the plugin’s read-only permission default.' : ''

      const save = async () => {
        setSaving(true); setErr(null)
        try {
          if (invalid) throw new Error('Choose an available system value before saving. Save a changed provider before its model.')
          let out
          if (isBool) out = (value === true || value === 'true')
          else if (isNum) {
            const n = Number(value)
            if (Number.isNaN(n)) throw new Error(`"${value}" is not a number`)
            out = n
          } else if (Array.isArray(row.value)) out = value.split(',').map((s) => s.trim()).filter(Boolean)
          else out = value
          const d = await apiSend('/config', 'POST', { path: row.path, value: out })
          notify(row.path === 'identities.enabled'
            ? `Workspace identities ${out ? 'enabled' : 'disabled'} — refresh Identities to see current availability`
            : `${row.path} saved${d && d.restartRequired ? ' (restart required)' : ''}`, 'ok')
          setSaving(false)
          onSaved()
        } catch (e) {
          setErr(e.message); setSaving(false)
        }
      }

      const reset = async () => {
        setSaving(true); setErr(null)
        try {
          await apiSend(`/config?path=${encodeURIComponent(row.path)}`, 'DELETE')
          notify(`${row.path} override cleared — reverted to boot default`, 'ok')
          setSaving(false)
          onSaved()
        } catch (e) {
          setErr(e.message); setSaving(false)
        }
      }

      const inputStyle = { ...S.input, padding: '5px 8px', fontSize: '12px', flex: '1 1 180px', minWidth: 120 }

      return h('div', { style: { borderBottom: `1px solid ${C.border}`, padding: '8px 12px' } },
        h('div', { style: S.rowFlex },
          h('code', { style: { ...S.mono, fontWeight: 600, wordBreak: 'break-all' } }, row.path),
          hasOverride && h('span', { style: BADGE_WARN() }, 'override'),
          needsRestart && h('span', { style: BADGE_ERR() }, 'restart required'),
          h('div', { style: S.spacer }),
          choices
            ? h('select', { style: inputStyle, multiple, size: multiple ? Math.min(5, Math.max(2, choices.options.length)) : undefined,
              value: multiple ? selected : value, disabled: saving || Boolean(catalogProblem),
              onChange: (e) => change(multiple ? Array.from(e.target.selectedOptions, (o) => o.value).join(', ') : e.target.value) },
              !multiple && h('option', { value: '', disabled: !choices.optional }, choices.optional ? 'Use configured default / caller selection' : 'Select a system value'),
              unavailable.map((v) => h('option', { key: v, value: v, disabled: true }, `${v} (unavailable)`)),
              choices.options.map((o) => h('option', { key: o.value, value: o.value }, o.label)))
            : isBool
            ? h('label', { style: { ...S.rowFlex, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox', checked: (value === true || value === 'true'),
                onChange: (e) => setValue(e.target.checked),
              }),
              h('span', { style: S.muted }, (value === true || value === 'true') ? 'on' : 'off'))
            : h('input', {
              style: inputStyle, type: isNum ? 'number' : 'text', step: 'any',
              value, onChange: (e) => setValue(e.target.value),
            }),
          choices && multiple && h('button', { style: { ...S.btn, ...S.btnSmall }, disabled: saving || Boolean(catalogProblem), onClick: () => change('') }, 'Clear selection'),
          h('button', {
            style: { ...S.btn, ...S.btnSmall, ...(dirty ? S.btnPrimary : {}) },
            disabled: saving || !dirty || Boolean(invalid),
            onClick: save, title: `POST /config {path:"${row.path}"}`,
          }, saving ? '…' : 'Save'),
          hasOverride && h('button', {
            style: { ...S.btn, ...S.btnSmall }, disabled: saving, onClick: reset,
            title: 'DELETE /config — clear override, revert to boot default',
          }, 'Reset')),
        choices && h('div', { style: { marginTop: 4, fontSize: '12px', color: C.muted } },
          catalogProblem ? `System ${choices.source} unavailable. Refresh choices to retry.`
            : choices.blocked ? 'Save the changed provider before choosing its model.'
              : unavailable.length ? 'Saved value is unavailable. Choose a current system value to replace it.'
                : !choices.options.length ? `No system ${choices.source} found.`
                  : multiple ? `Select multiple with ⌘/Ctrl. ${emptyListHelp}`
                    : row.path.endsWith('.provider') ? 'Save a provider change before choosing its model.' : ''),
        err && h('div', { style: { marginTop: 4, fontSize: '12px', color: C.danger } }, `Error: ${err}`))
    }

    function ConfigTab({ notify, globalQuery }) {
      const [tree, setTree] = React.useState(null)
      const [overrides, setOverrides] = React.useState({})
      const [restartRequired, setRestartRequired] = React.useState([])
      const [catalog, setCatalog] = React.useState(null)
      const [catalogError, setCatalogError] = React.useState(null)
      const [catalogLoading, setCatalogLoading] = React.useState(false)
      const [drafts, setDrafts] = React.useState({})
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [query, setQuery] = React.useState(globalQuery || '')
      React.useEffect(() => { setQuery(globalQuery) }, [globalQuery])

      const loadCatalog = React.useCallback(async () => {
        setCatalogLoading(true); setCatalogError(null)
        try { setCatalog(await apiGet('/catalog')) }
        catch (e) { setCatalog(null); setCatalogError(`System choices unavailable: ${e.message}`) }
        finally { setCatalogLoading(false) }
      }, [])

      const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const d = await apiGet('/config')
          setTree(d.effective || {})
          setOverrides(d.overrides || {})
          setRestartRequired(Array.isArray(d.restartRequired) ? d.restartRequired : [])
          setDrafts({})
        } catch (e) {
          setError(`Config load failed: ${e.message}`)
        } finally { setLoading(false) }
      }, [])

      React.useEffect(() => { load() }, [load])
      React.useEffect(() => { loadCatalog() }, [loadCatalog])

      const rowOnSaved = () => { load() }

      const groups = React.useMemo(() => {
        if (!tree) return []
        const out = []
        for (const key of Object.keys(tree)) {
          const sub = tree[key]
          if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) {
            out.push({ title: 'General', rows: [{ path: key, value: sub }] })
          } else {
            out.push({ title: key, rows: flattenConfig(sub, key) })
          }
        }
        return out
      }, [tree])

      const q = query.trim().toLowerCase()
      const filteredGroups = q
        ? groups.map((g) => ({ ...g, rows: g.rows.filter((r) => String(r.path).toLowerCase().includes(q) || String(r.value).toLowerCase().includes(q)) }))
          .filter((g) => g.rows.length > 0)
        : groups

      if (!tree && loading) return h(Empty, { text: 'Loading config…' })

      const overrideCount = Object.keys(overrides).length

      return h('div', null,
        h(ErrorBanner, { error, onDismiss: () => setError(null) }),
        h(ErrorBanner, { error: catalogError }),
        catalog && Object.entries(catalog.errors || {}).map(([name, message]) => h(Notice, { key: name, text: `${name}: ${message}` })),
        h(Notice, { text: 'Paths marked “restart required” only take effect after a dsh restart. “Reset” clears a stored override and reverts to the boot default.' }),
        h('div', { style: { ...S.rowFlex, marginBottom: 8 } },
          h('button', { style: S.btn, onClick: load, disabled: loading }, loading ? 'Loading…' : 'Refresh'),
          h('button', { style: S.btn, onClick: loadCatalog, disabled: catalogLoading }, catalogLoading ? 'Loading choices…' : 'Refresh system choices'),
          h('div', { style: S.spacer }),
          h('span', { style: S.muted }, `${overrideCount} override${overrideCount === 1 ? '' : 's'}${q ? ` · ${filteredGroups.length} matching group${filteredGroups.length === 1 ? '' : 's'}` : ''}`)),
        !tree && h(Empty, { text: 'No config loaded.' }),
        filteredGroups.map((g) => h('div', { key: g.title },
          h('div', { style: S.sectionTitle }, g.title),
          h('div', { style: { border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg } },
            g.rows.map((row) => h(ConfigRow, {
              key: `${row.path}:${JSON.stringify(row.value)}`, row, overrides, restartRequired, notify, onSaved: rowOnSaved,
              catalog, tree, drafts, onDraft: (path, next) => setDrafts((current) => ({ ...current, [path]: next })),
            }))))),
        tree && filteredGroups.length === 0 && h(Empty, { text: 'No config paths match the search.' }))
    }

    // ==================================================================
    // APP — header + global search + local tabs
    // ==================================================================
    function App() {
      const [tab, setTab] = React.useState('inbox')
      const [globalQuery, setGlobalQuery] = React.useState('')
      const [toast, setToast] = React.useState(null)
      const [sessions, setSessions] = React.useState([])

      const notify = React.useCallback((text, tone) => {
        setToast({ text, tone: tone || 'info' })
        window.clearTimeout(App._toastTimer)
        App._toastTimer = window.setTimeout(() => setToast(null), 4000)
      }, [])

      const reloadSessions = React.useCallback(async () => {
        try {
          const d = await apiGet('/sessions')
          setSessions(Array.isArray(d.sessions) ? d.sessions : [])
        } catch { /* advisory only; contacts tab shows 'unknown' */ }
      }, [])

      React.useEffect(() => { reloadSessions() }, [reloadSessions])

      return h('div', { style: S.page },
        h('div', { style: S.headerRow },
          h('div', null,
            h('h2', { style: S.title }, 'Agents in the Loop'),
            h('div', { style: S.subtitle }, 'Coordinate agents with workspace identities, inboxes, and contacts.')),
          h('div', { style: S.headerActions },
            h('input', {
              style: { ...S.input, width: 260, padding: '6px 10px' }, type: 'search',
              placeholder: 'Search this page…', value: globalQuery,
              onChange: (e) => setGlobalQuery(e.target.value),
            }))),
        h('div', { style: S.tabs },
          ['inbox', 'identities', 'contacts', 'config'].map((t) => h('button', {
            key: t, style: S.tab(tab === t), onClick: () => setTab(t),
          }, t === 'inbox' ? 'Inbox' : t === 'identities' ? 'Identities' : t === 'contacts' ? 'Contacts' : 'Config'))),
        toast && h(Notice, { text: toast.text, tone: toast.tone }),
        tab === 'inbox' && h(InboxTab, { notify, globalQuery }),
        (tab === 'contacts' || tab === 'identities') && h(ContactsTab, { key: tab, mode: tab, notify, globalQuery, sessions, reloadSessions }),
        tab === 'config' && h(ConfigTab, { notify, globalQuery }),
      )
    }

    // ------------------------------------------------------------------
    // Registration — sidebar.panellist entry + keyed main page
    // ------------------------------------------------------------------
    function PanelIcon({ size }) {
      const px = size || 20
      return h('svg', {
        width: px, height: px, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        // chat bubble with an inner loop dot
        h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }),
        h('circle', { cx: 12, cy: 11.5, r: 2.5 }),
      )
    }

    function MainPage(props) {
      return h(App, Object.assign({}, props || {}))
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.slots || ctx.get('slots')
      if (!slots) return

      // Left sidebar entry → selects the keyed `main` page below.
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: 'agents-in-the-loop',
        order: 60,
        label: () => 'AITL',
      }, PanelIcon))

      // Central panel — `main` is KEYED: use `key:`, not `id:`.
      slots.inject('main', () => slots.register({
        name: 'main',
        key: 'agents-in-the-loop',
      }, MainPage))
    }

    return { inject, apply }
  },
})
