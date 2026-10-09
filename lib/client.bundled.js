// Client UI for agents-in-the-loop (v2.0.0) — sidebar entry "AITL" + keyed
// main page with three local tabs: Inbox | Contacts | Config, plus a global
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

    async function apiGet(path) {
      const r = await fetch(BASE + path)
      if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`)
      const d = await r.json()
      if (d && d.ok === false) throw new Error(d.error || `GET ${path} → ok:false`)
      return d
    }
    async function apiSend(path, method, body) {
      const r = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let d = null
      try { d = await r.json() } catch { /* non-JSON body */ }
      if (!r.ok) throw new Error((d && d.error) || `${method} ${path} → HTTP ${r.status}`)
      if (d && d.ok === false) throw new Error(d.error || `${method} ${path} → ok:false`)
      return d || {}
    }

    // kind may be absent on legacy rows — infer external from session-ext-.
    const isExternal = (c) => Boolean(c && (c.kind
      ? c.kind === 'external'
      : String(c.sessionId || '').startsWith('session-ext-')))

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
      const [messages, setMessages] = React.useState([])
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState(globalQuery || '')

      // The header search feeds the active tab's local filter.
      React.useEffect(() => { setQuery(globalQuery) }, [globalQuery])

      const [compose, setCompose] = React.useState({ target: '', message: '', subject: '', threadId: '' })
      const [sending, setSending] = React.useState(false)

      const load = React.useCallback(async (who) => {
        setBusy(true)
        setError(null)
        try {
          const q = who ? `&identity=${encodeURIComponent(who)}` : ''
          const d = await apiGet(`/inbox?format=json${q}`)
          setExternals(Array.isArray(d.externals) ? d.externals : [])
          setIdentity((cur) => d.identity || who || cur)
          setMessages(Array.isArray(d.messages) ? d.messages : [])
        } catch (e) {
          setError(`Inbox load failed: ${e.message}`)
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => { load('') }, [load]) // initial load (server default identity)

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

      return h('div', null,
        h(ErrorBanner, { error, onDismiss: () => setError(null) }),
        h('div', { style: { ...S.rowFlex, marginBottom: 12 } },
          h('label', { style: { ...S.formLabel, marginRight: 4 } }, 'Maildrop'),
          h('select', {
            value: identity, onChange: (e) => pickIdentity(e.target.value),
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
                style: S.input, list: 'aitl-contact-names', value: compose.target,
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
              maildropOptions.map((ex) => h('option', { key: ex.name, value: ex.name }))))),
      )
    }

    // ==================================================================
    // CONTACTS TAB
    // ==================================================================
    const EMPTY_FORM = { name: '', sessionId: '', label: '', tags: '', note: '', cwd: '' }

    function ContactsTab({ notify, globalQuery, sessions, reloadSessions }) {
      const [contacts, setContacts] = React.useState([])
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [query, setQuery] = React.useState(globalQuery || '')
      React.useEffect(() => { setQuery(globalQuery) }, [globalQuery])

      const [editing, setEditing] = React.useState(null) // null + formOpen = add mode; string = original name
      const [formOpen, setFormOpen] = React.useState(false)
      const [form, setForm] = React.useState(EMPTY_FORM)
      const [saving, setSaving] = React.useState(false)
      const [confirmDelete, setConfirmDelete] = React.useState(null)

      const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const d = await apiGet('/contacts')
          setContacts(Array.isArray(d.contacts) ? d.contacts : [])
        } catch (e) {
          setError(`Contacts load failed: ${e.message}`)
        } finally { setLoading(false) }
      }, [])

      React.useEffect(() => { load() }, [load])

      const sessionOnline = (sessionId) => {
        const hit = (sessions || []).find((s) => s.id === sessionId)
        if (!hit) return undefined
        const st = String(hit.status || '').toLowerCase()
        return st === '' ? undefined : (st === 'online' || st === 'active' || st === 'running' || st === 'live')
      }

      const openAdd = () => { setEditing(null); setForm(EMPTY_FORM); setFormOpen(true) }
      const openEdit = (c) => {
        setEditing(c.name)
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
        setSaving(true)
        setError(null)
        try {
          const payload = {
            name: form.name.trim(),
            sessionId: form.sessionId.trim(),
          }
          if (form.label.trim()) payload.label = form.label.trim()
          if (form.tags.trim()) payload.tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean)
          if (form.note.trim()) payload.note = form.note.trim()
          if (form.cwd.trim()) payload.cwd = form.cwd.trim()
          if (editing) {
            await apiSend('/contacts', 'PUT', { ...payload, rename: editing })
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
      const filtered = q
        ? contacts.filter((c) =>
          [c.name, c.sessionId, c.label, Array.isArray(c.tags) ? c.tags.join(' ') : c.tags, c.note]
            .some((v) => String(v || '').toLowerCase().includes(q)))
        : contacts

      return h('div', null,
        h(ErrorBanner, { error, onDismiss: () => setError(null) }),
        h('div', { style: { ...S.rowFlex, marginBottom: 12 } },
          h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: openAdd }, '+ Add contact'),
          h('button', { style: S.btn, onClick: load, disabled: loading }, loading ? 'Loading…' : 'Refresh'),
          h('div', { style: S.spacer }),
          h('span', { style: S.muted }, `${filtered.length}${q ? ' / ' + contacts.length : ''} contact${filtered.length === 1 ? '' : 's'}`)),
        h('input', {
          style: S.search, type: 'search', placeholder: 'Search contacts — name, session, label, tags…',
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
              h('input', { style: { ...S.input, ...S.mono }, value: form.sessionId, placeholder: 'session-ext-… for external, else dsh session id', onChange: (e) => setForm((f) => ({ ...f, sessionId: e.target.value })) })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Label'),
              h('input', { style: S.input, value: form.label, placeholder: 'human-friendly label', onChange: (e) => setForm((f) => ({ ...f, label: e.target.value })) })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Tags (comma-separated)'),
              h('input', { style: S.input, value: form.tags, placeholder: 'dev, review', onChange: (e) => setForm((f) => ({ ...f, tags: e.target.value })) })),
            h('div', { style: S.formRow },
              h('label', { style: S.formLabel }, 'Workspace (cwd)'),
              h('input', { style: { ...S.input, ...S.mono }, value: form.cwd, placeholder: '/path/to/workspace', onChange: (e) => setForm((f) => ({ ...f, cwd: e.target.value })) }))),
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
          ? h(Empty, { text: q ? 'No contacts match the search.' : 'No contacts registered yet.' })
          : h('div', { style: S.tableWrap },
            h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', null, 'Name'), h('th', null, 'Session ID'), h('th', null, 'Kind'),
                h('th', null, 'Status'), h('th', null, 'Label'), h('th', null, 'Tags'),
                h('th', null, 'Note'), h('th', null, 'Updated'), h('th', null, ''))),
              h('tbody', null, filtered.map((c) => {
                const external = isExternal(c)
                const online = external ? sessionOnline(c.sessionId) : undefined
                return h('tr', { key: c.name },
                  h('td', { style: { ...S.td, fontWeight: 600 } }, String(c.name || '—')),
                  h('td', { style: { ...S.td, ...S.mono } }, h('div', { style: S.truncate }, String(c.sessionId || '—'))),
                  h('td', { style: S.td }, h(KindBadge, { external })),
                  h('td', { style: S.td }, external ? h(LiveBadge, { online }) : h('span', { style: S.muted }, '—')),
                  h('td', { style: { ...S.td, ...S.muted } }, String(c.label || '—')),
                  h('td', { style: S.td },
                    Array.isArray(c.tags) && c.tags.length
                      ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                        c.tags.map((t) => h('span', { key: String(t), style: BADGE_NEUTRAL() }, String(t))))
                      : h('span', { style: S.muted }, '—')),
                  h('td', { style: { ...S.td, ...S.muted } }, h('div', { style: S.truncate }, String(c.note || '—'))),
                  h('td', { style: { ...S.td, ...S.muted, whiteSpace: 'nowrap' } }, fmtTime(c.updatedAt)),
                  h('td', { style: S.td },
                    h('div', { style: { display: 'flex', gap: 6, whiteSpace: 'nowrap' } },
                      h('button', { style: { ...S.btn, ...S.btnSmall }, onClick: () => openEdit(c) }, 'Edit'),
                      confirmDelete === c.name
                        ? h('button', { style: { ...S.btn, ...S.btnSmall, ...S.btnDanger }, onClick: () => doDelete(c.name) }, 'Confirm delete')
                        : h('button', { style: { ...S.btn, ...S.btnSmall, ...S.btnDanger }, onClick: () => setConfirmDelete(c.name) }, 'Delete'))))
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

    function ConfigRow({ row, overrides, restartRequired, notify, onSaved }) {
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

      const save = async () => {
        setSaving(true); setErr(null)
        try {
          let out
          if (isBool) out = (value === true || value === 'true')
          else if (isNum) {
            const n = Number(value)
            if (Number.isNaN(n)) throw new Error(`"${value}" is not a number`)
            out = n
          } else if (Array.isArray(row.value)) out = value.split(',').map((s) => s.trim()).filter(Boolean)
          else out = value
          const d = await apiSend('/config', 'POST', { path: row.path, value: out })
          notify(`${row.path} saved${d && d.restartRequired ? ' (restart required)' : ''}`, 'ok')
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
          isBool
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
          h('button', {
            style: { ...S.btn, ...S.btnSmall, ...(dirty ? S.btnPrimary : {}) },
            disabled: saving || (!dirty && !isBool) || (isBool && !dirty),
            onClick: save, title: `POST /config {path:"${row.path}"}`,
          }, saving ? '…' : 'Save'),
          hasOverride && h('button', {
            style: { ...S.btn, ...S.btnSmall }, disabled: saving, onClick: reset,
            title: 'DELETE /config — clear override, revert to boot default',
          }, 'Reset')),
        err && h('div', { style: { marginTop: 4, fontSize: '12px', color: C.danger } }, `Error: ${err}`))
    }

    function ConfigTab({ notify, globalQuery }) {
      const [tree, setTree] = React.useState(null)
      const [overrides, setOverrides] = React.useState({})
      const [restartRequired, setRestartRequired] = React.useState([])
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [query, setQuery] = React.useState(globalQuery || '')
      React.useEffect(() => { setQuery(globalQuery) }, [globalQuery])

      const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const d = await apiGet('/config')
          setTree(d.effective || {})
          setOverrides(d.overrides || {})
          setRestartRequired(Array.isArray(d.restartRequired) ? d.restartRequired : [])
        } catch (e) {
          setError(`Config load failed: ${e.message}`)
        } finally { setLoading(false) }
      }, [])

      React.useEffect(() => { load() }, [load])

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
        h(Notice, { text: 'Paths marked “restart required” only take effect after a dsh restart. “Reset” clears a stored override and reverts to the boot default.' }),
        h('div', { style: { ...S.rowFlex, marginBottom: 8 } },
          h('button', { style: S.btn, onClick: load, disabled: loading }, loading ? 'Loading…' : 'Refresh'),
          h('div', { style: S.spacer }),
          h('span', { style: S.muted }, `${overrideCount} override${overrideCount === 1 ? '' : 's'}${q ? ` · ${filteredGroups.length} matching group${filteredGroups.length === 1 ? '' : 's'}` : ''}`)),
        !tree && h(Empty, { text: 'No config loaded.' }),
        filteredGroups.map((g) => h('div', { key: g.title },
          h('div', { style: S.sectionTitle }, g.title),
          h('div', { style: { border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg } },
            g.rows.map((row) => h(ConfigRow, {
              key: row.path, row, overrides, restartRequired, notify, onSaved: rowOnSaved,
            }))))),
        tree && filteredGroups.length === 0 && h(Empty, { text: 'No config paths match the search.' }))
    }

    // ==================================================================
    // APP — header + global search + three local tabs
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
            h('div', { style: S.subtitle }, 'External agent maildrops, contacts, and plugin configuration — everything editable.')),
          h('div', { style: S.headerActions },
            h('input', {
              style: { ...S.input, width: 260, padding: '6px 10px' }, type: 'search',
              placeholder: 'Search this page…', value: globalQuery,
              onChange: (e) => setGlobalQuery(e.target.value),
            }))),
        h('div', { style: S.tabs },
          ['inbox', 'contacts', 'config'].map((t) => h('button', {
            key: t, style: S.tab(tab === t), onClick: () => setTab(t),
          }, t === 'inbox' ? 'Inbox' : t === 'contacts' ? 'Contacts' : 'Config'))),
        toast && h(Notice, { text: toast.text, tone: toast.tone }),
        tab === 'inbox' && h(InboxTab, { notify, globalQuery }),
        tab === 'contacts' && h(ContactsTab, { notify, globalQuery, sessions, reloadSessions }),
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
