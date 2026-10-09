// Client UI for agents-in-the-loop (v1.10.0) — sidebar entry "AITL" +
// main page: Inbox (external maildrops, poll/ack) + Contacts (live status).
// Pattern follows dsh-keyword-injector: sidebar.panellist entry selects a
// keyed `main` page; React via the host module loader; theme via inherit.
// Data source: the plugin's own loopback JSON API (same origin, loopback
// guard — no bearer key in the browser).

window.__ModuleLoader__.load({
  id: 'dsh-agents-in-the-loop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = {
      wrap: { padding: 16, fontFamily: 'inherit', color: 'inherit' },
      h2: { margin: '0 0 12px', fontSize: 18, fontWeight: 600 },
      h3: { margin: '18px 0 8px', fontSize: 14, fontWeight: 600, opacity: 0.8 },
      btn: { padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer', marginLeft: 6 },
      btnPrimary: { padding: '4px 10px', borderRadius: 6, border: 'none', background: '#247bbf', color: '#fff', cursor: 'pointer' },
      select: { padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.2)', verticalAlign: 'top' },
      status: { padding: '1px 8px', borderRadius: 10, fontSize: 11 },
      empty: { opacity: 0.6, padding: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
    }
    const statusColor = (s) => (s === 'acked' ? '#3a9' : s === 'delivered' ? '#d90' : '#888')

    function App() {
      const [externals, setExternals] = React.useState([])
      const [identity, setIdentity] = React.useState('')
      const [messages, setMessages] = React.useState([])
      const [sessions, setSessions] = React.useState([])
      const [busy, setBusy] = React.useState(false)

      const loadSummary = React.useCallback(async () => {
        try {
          const r = await fetch('/api/agents-in-the-loop/inbox?format=json')
          const d = await r.json()
          setExternals(d.externals ?? [])
          setIdentity((cur) => cur || (d.externals?.[0]?.name ?? ''))
        } catch {}
      }, [])
      const loadMessages = React.useCallback(async (who) => {
        if (!who) { setMessages([]); return }
        try {
          const r = await fetch(`/api/agents-in-the-loop/inbox?format=json&identity=${encodeURIComponent(who)}`)
          const d = await r.json()
          setMessages(d.messages ?? [])
        } catch {}
      }, [])
      const loadSessions = React.useCallback(async () => {
        try {
          const r = await fetch('/api/agents-in-the-loop/sessions')
          const d = await r.json()
          setSessions(d.sessions ?? d.count ?? [])
        } catch {}
      }, [])

      React.useEffect(() => { loadSummary(); loadSessions() }, [loadSummary, loadSessions])
      React.useEffect(() => { loadMessages(identity) }, [identity, loadMessages])

      const ack = async (id) => {
        setBusy(true)
        try {
          await fetch('/api/agents-in-the-loop/inbox?format=json&op=ack', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ identity, id }),
          })
          await loadMessages(identity); await loadSummary()
        } finally { setBusy(false) }
      }

      const liveIds = new Set(Array.isArray(sessions) ? sessions.map((s) => s.id) : [])
      const contactRows = externals.map((e) => h('tr', { key: e.name }, [
        h('td', { key: 'n', style: CSS.td }, e.name),
        h('td', { key: 's', style: CSS.td }, h('code', null, e.sessionId)),
        h('td', { key: 'p', style: CSS.td }, h('span', { style: { ...CSS.status, background: e.pending ? '#d90' : 'transparent', color: e.pending ? '#fff' : 'inherit' } }, `${e.pending} pending`)),
      ]))

      const msgRows = messages.length ? messages.map((m) => h('tr', { key: m.id }, [
        h('td', { key: 'id', style: CSS.td }, String(m.id)),
        h('td', { key: 'snd', style: CSS.td }, m.sender),
        h('td', { key: 't', style: CSS.td }, m.threadId),
        h('td', { key: 'st', style: CSS.td }, h('span', { style: { ...CSS.status, background: statusColor(m.status), color: '#fff' } }, m.status)),
        h('td', { key: 'at', style: CSS.td }, m.createdAt),
        h('td', { key: 'b', style: { ...CSS.td, maxWidth: '52ch' } }, h('pre', { style: { whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' } }, m.body)),
        h('td', { key: 'a', style: CSS.td }, m.status !== 'acked' ? h('button', { style: CSS.btn, disabled: busy, onClick: () => ack(m.id) }, 'ack') : null),
      ])) : [h('tr', { key: 'e' }, h('td', { colSpan: 7, style: CSS.empty }, identity ? 'no messages' : 'select an identity'))]

      return h('div', { style: CSS.wrap }, [
        h('h2', { key: 'h', style: CSS.h2 }, 'Agents in the Loop'),
        h('div', { key: 'toolbar', style: CSS.row }, [
          h('button', { key: 'r', style: CSS.btnPrimary, onClick: () => { loadSummary(); loadSessions(); loadMessages(identity) } }, 'Refresh'),
          h('span', { key: 'pick', style: { opacity: 0.7 } }, 'Maildrop:'),
          h('select', { key: 'sel', style: CSS.select, value: identity, onChange: (e) => setIdentity(e.target.value) },
            externals.map((e) => h('option', { key: e.name, value: e.name }, `${e.name} (${e.pending})`)),
          ),
        ]),
        h('h3', { key: 'ih', style: CSS.h3 }, 'Inbox — external maildrops'),
        h('table', { key: 'it', style: CSS.table }, [
          h('thead', { key: 'th' }, h('tr', null, ['id', 'sender', 'thread', 'status', 'created', 'body', ''].map((t, i) => h('th', { key: i, style: { ...CSS.td, textAlign: 'left', opacity: 0.6 } }, t)))),
          h('tbody', { key: 'tb' }, msgRows),
        ]),
        h('h3', { key: 'ch', style: CSS.h3 }, 'External contacts'),
        h('table', { key: 'ct', style: CSS.table }, [
          h('thead', { key: 'th2' }, h('tr', null, ['name', 'session', 'pending'].map((t, i) => h('th', { key: i, style: { ...CSS.td, textAlign: 'left', opacity: 0.6 } }, t)))),
          h('tbody', { key: 'tb2' }, contactRows),
        ]),
        h('h3', { key: 'sh', style: CSS.h3 }, 'Live dsh sessions'),
        h('div', { key: 'sd', style: CSS.row }, Array.isArray(sessions) && sessions.length
          ? sessions.map((s) => h('span', { key: s.id, style: { ...CSS.status, background: 'rgba(128,128,128,.25)' } }, `${s.id.slice(0, 13)}… ${s.status ?? ''}`))
          : h('span', { style: CSS.empty }, 'none')),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'agents-in-the-loop', order: 60,
          icon: h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, style: { color: 'currentColor' } },
            h('path', { d: 'M2 3h12v8H5l-3 3V3z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 })),
          label: 'AITL',
        }, 'agents-in-the-loop'))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'agents-in-the-loop',
        }, App))
      },
    }
  },
})
