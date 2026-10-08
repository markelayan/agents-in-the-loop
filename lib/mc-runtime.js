// mc-runtime — Mission Control drives dsh agents (DSH-MC-1).
//
// Subscribes to MC's SSE event stream and executes MC's decisions in dsh:
// spawn on assign (via ~/.dsh/new-session.mjs — the proven RPC client),
// deliver comments, close on done. MC holds all state; this module only
// executes. One long-lived SSE connection + reconcile on (re)connect, plus
// a 60s scheduler tick for seats/order/silence. Config: cordis.patch.yml
// `mc:` block. No new npm deps.
//
// Never logs the MC key. Never spawns when a contact with the target name
// already exists (reconcile owns resume instead).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const ACTORS_DSH = new Set(['dsh-agents', 'dsh-runtime'])
const SESSION_RE = /^session-[0-9a-fA-F-]{10,}$/
const TICK_MS = 60_000
const DEBOUNCE_MS = 2_000

function expand(p) {
  return typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

function resolveMcConfig(config) {
  const mc = config?.mc ?? {}
  if (mc.enabled !== true) return null // optional feature — OFF unless explicitly enabled
  return {
    url: (mc.url ?? 'http://127.0.0.1:9999').replace(/\/+$/, ''),
    apiKeyFile: expand(mc.apiKeyFile ?? ''),
    maxSessions: Number.isInteger(mc.maxSessions) && mc.maxSessions > 0 ? mc.maxSessions : 9,
    silentMinutes: Number.isInteger(mc.silentMinutes) && mc.silentMinutes > 0 ? mc.silentMinutes : 20,
    excludedContacts: Array.isArray(mc.excludedContacts) ? mc.excludedContacts.map(String) : ['dsh-maintainer'],
    projects: mc.projects && typeof mc.projects === 'object' ? mc.projects : {},
    newSession: expand(mc.newSession ?? '~/.dsh/new-session.mjs'),
    stateFile: expand(mc.stateFile ?? '~/.dsh/mc-runtime-state.json'),
    model: typeof mc.model === 'string' && mc.model ? mc.model : 'glm-5.3-flash',
    provider: typeof mc.provider === 'string' && mc.provider ? mc.provider : 'zai-coding-cn',
  }
}

export function startMcRuntime(ctx, config, handle) {
  const cfg = resolveMcConfig(config)
  if (!cfg) return () => {}
  const { contactsFile, agentCtx, deliverSessionMessage, log } = handle
  const logLine = (...a) => console.log('[mc-runtime]', ...a)

  let apiKey = ''
  try {
    apiKey = String(JSON.parse(readFileSync(cfg.apiKeyFile, 'utf-8')).key ?? '')
  } catch (e) {
    logLine(`FATAL: cannot read MC key file ${cfg.apiKeyFile}: ${e?.message} — runtime disabled`)
    return () => {}
  }
  if (!apiKey) {
    logLine('FATAL: MC key file has no "key" field — runtime disabled')
    return () => {}
  }

  // ── MC API client ─────────────────────────────────────────────────────
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${cfg.url}/api${path}`, {
      method,
      headers: { 'x-api-key': apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`MC ${method} ${path} → HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  // ── state ─────────────────────────────────────────────────────────────
  const taskSessions = new Map() // taskId -> contact name
  const reminders = new Map() // taskId -> { count, lastAt }
  const lastAgentAt = new Map() // taskId -> ts of last agent activity
  const debounces = new Map() // taskId -> timer
  const spawnFails = new Map() // taskId -> { tries, lastError }
  const gateNotes = new Map() // taskId -> last gate error noted on the task
  let agentsCache = new Map() // MC agent name -> { config, name }
  let projectsCache = new Map() // id|slug -> project row
  let mcConnected = false
  let lastEventAt = null
  let disposed = false
  let abort = null

  try {
    const saved = JSON.parse(readFileSync(cfg.stateFile, 'utf-8'))
    for (const [k, v] of Object.entries(saved?.taskSessions ?? {})) taskSessions.set(k, v)
  } catch {}

  function persist() {
    try {
      mkdirSync(join(cfg.stateFile, '..'), { recursive: true })
      const tmp = `${cfg.stateFile}.tmp-${Date.now()}`
      writeFileSync(tmp, JSON.stringify({ version: 1, taskSessions: Object.fromEntries(taskSessions) }, null, 2))
      renameSync(tmp, cfg.stateFile)
    } catch (e) {
      logLine(`state persist failed: ${e?.message}`)
    }
  }

  function readContacts() {
    try {
      return JSON.parse(readFileSync(contactsFile, 'utf-8')).contacts ?? {}
    } catch {
      return {}
    }
  }
  function writeContacts(contacts) {
    const tmp = `${contactsFile}.tmp-${Date.now()}`
    writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), contacts }, null, 2) + '\n')
    renameSync(tmp, contactsFile)
  }
  const isLive = (sid) => Boolean(agentCtx?.agents?.get(sid))
  function seatsUsed() {
    const excluded = new Set(cfg.excludedContacts)
    let n = 0
    for (const [name, c] of Object.entries(readContacts())) {
      if (excluded.has(name)) continue
      if (isLive(c.sessionId)) n++
    }
    return n
  }

  // ── dsh helpers ───────────────────────────────────────────────────────
  function ticketOf(task, project) {
    // display form, exactly as MC shows it: SBX-004
    const prefix = String(project?.ticket_prefix ?? 'task').toUpperCase()
    return `${prefix}-${String(task.project_ticket_no ?? task.id).padStart(3, '0')}`
  }
  function ticketCompact(task, project) {
    // compact form for contact/session names only: sbx0004
    const prefix = String(project?.ticket_prefix ?? 'task').toLowerCase()
    return `${prefix}${String(task.project_ticket_no ?? task.id).padStart(3, '0')}`
  }

  // Dispose a session created by a failed spawn (resume gives us an owned
  // handle whose dispose() unregisters the agent — the only in-process path).
  async function disposeLeakedSession(sessionId) {
    try {
      const handle = await agentCtx.agents.resume({ resumeSessionId: sessionId })
      await handle.dispose()
      logLine(`disposed leaked session ${sessionId}`)
      return true
    } catch (e) {
      logLine(`dispose failed for ${sessionId}: ${e?.message} — left for a human`)
      return false
    }
  }

  // Boot gate: don't spawn until the dsh web RPC answers (validate-only creates no session).
  let dshReadyOk = false
  async function dshWebReady() {
    if (dshReadyOk) return { ok: true, cause: '' }
    const cause = await new Promise((resolve) => {
      execFile(process.execPath, [cfg.newSession, '--validate-only', '--provider', cfg.provider, '--model', cfg.model], { timeout: 20_000 }, (err, stdout, stderr) => {
        if (!err) return resolve('')
        const tail = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' | ')
        const c = `exit ${err?.code ?? '?'}: ${tail || err?.message}`
        logLine(`gate probe failed (${c})`)
        resolve(c)
      })
    })
    if (!cause) {
      dshReadyOk = true
      logLine('dsh web API ready (validate-only probe passed)')
    }
    return { ok: !cause, cause }
  }

  async function spawnSession(task, mcAgent) {
    const project = projectsCache.get(task.project_id) ?? projectsCache.get(String(task.project_id))
    const pcfg = project ? cfg.projects[project.slug] ?? cfg.projects[String(project.id)] : cfg.projects[String(task.project_id)]
    if (!pcfg) return { ok: false, error: 'project not mapped' }
    const preset = mcAgent?.config?.preset
    if (!preset) return { ok: false, error: 'MC agent config has no preset' }
    const ticket = ticketOf(task, project)
    const contact = `${preset}-${ticketCompact(task, project)}`
    const contacts = readContacts()
    if (contacts[contact]) {
      const c = contacts[contact]
      if (isLive(c.sessionId)) return { ok: false, error: `contact ${contact} already live`, existing: contact }
      // stale registration from a previous incarnation — remove, respawn fresh
      const next = { ...contacts }
      delete next[contact]
      writeContacts(next)
    }
    const template = existsSync(pcfg.firstMessage) ? readFileSync(pcfg.firstMessage, 'utf-8') : ''
    const firstMessage = template
      .replaceAll('{TICKET}', ticket)
      .replaceAll('{TITLE}', task.title ?? '')
      .replaceAll('{SESSION}', contact)
      .replaceAll('{TASK_ID}', String(task.id))
      .replaceAll('{PROJECT}', project?.slug ?? String(task.project_id))
      .replaceAll('{ROLE}', mcAgent?.config?.role ?? '')
      .replaceAll('{RULES}', pcfg.rules ?? '')
    // model/provider: assigned ONLY at spawn. MC agent config wins; else mc config (live provider id).
    const args = ['--preset', preset, '--text', firstMessage]
    const model = mcAgent?.config?.model || cfg.model
    const provider = mcAgent?.config?.provider || cfg.provider
    if (model) args.push('--model', model)
    if (provider) args.push('--provider', provider)
    if (pcfg.workspaceId) args.push('--workspace-id', pcfg.workspaceId)
    if (pcfg.cwd) args.push('--cwd', pcfg.cwd)
    logLine('spawn argv: ' + args.map((v, i) => (i > 0 && args[i - 1] === '--text') ? '<first-message>' : v).join(' '))
    const created = await new Promise((resolve) => {
      execFile(process.execPath, [cfg.newSession, ...args], { timeout: 120_000 }, async (err, stdout, stderr) => {
        // A session may exist even when the script failed (e.g. selectModel error):
        // new-session.mjs prints `sessionId:` before the failing step.
        const m = String(stdout ?? '').match(/sessionId:\s*(session-[0-9a-fA-F-]+)/)
        // Real cause: the last `Error:` line of new-session's stderr (Node's
        // err.message is only "Command failed: <argv>"), plus the exit code.
        const errLines = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
        const cause = errLines.reverse().find((l) => l.startsWith('Error:')) ?? errLines[0] ?? ''
        const head = `new-session failed (exit ${err?.code ?? '?'}): ${cause || err?.message} | stderr tail: ${errLines.slice(0, 2).reverse().join(' | ').slice(0, 300)}`
        if (err) {
          if (m) {
            const disposed = await disposeLeakedSession(m[1])
            return resolve({ ok: false, error: head, leaked: !disposed })
          }
          return resolve({ ok: false, error: head })
        }
        if (!m) return resolve({ ok: false, error: `no sessionId in new-session output: ${String(stdout).slice(-200)}` })
        resolve({ ok: true, sessionId: m[1] })
      })
    })
    if (!created.ok) return created
    const next = { ...readContacts() }
    next[contact] = {
      sessionId: created.sessionId,
      label: `${ticket}: ${task.title ?? ''}`,
      tags: [mcAgent?.config?.role ?? 'task', ticket].filter(Boolean),
      note: `atlas MC task ${task.id} (${project?.slug ?? task.project_id}) — spawned by mc-runtime`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writeContacts(next)
    taskSessions.set(String(task.id), contact)
    persist()
    logLine(`spawned ${contact} → ${created.sessionId} (task ${task.id})`)
    return { ok: true, contact, sessionId: created.sessionId, ticket }
  }

  async function deliverTo(contact, text, { resumeIfDead = false } = {}) {
    const c = readContacts()[contact]
    if (!c) return { ok: false, error: `contact ${contact} not found` }
    const r = await deliverSessionMessage({ sid: 'mc-runtime', target: c.sessionId, message: text, wake: true, resumeIfDead })
    return r
  }

  async function mcNote(taskId, text) {
    try {
      await api(`/tasks/${taskId}/comments`, { method: 'POST', body: { content: text, author: 'dsh-runtime' } })
    } catch (e) {
      logLine(`comment on task ${taskId} failed: ${e?.message}`)
    }
  }

  async function setMetadataSession(task, contact) {
    try {
      const metadata = { ...(task.metadata ?? {}), dsh_session: contact }
      await api(`/tasks/${task.id}`, { method: 'PUT', body: { metadata } })
    } catch (e) {
      logLine(`metadata.dsh_session write on task ${task.id} failed: ${e?.message}`)
    }
  }

  async function setStatus(taskId, status) {
    try {
      await api(`/tasks/${taskId}`, { method: 'PUT', body: { status } })
    } catch (e) {
      logLine(`status→${status} on task ${taskId} failed: ${e?.message}`)
    }
  }

  async function closeSession(taskId, reason) {
    const contact = taskSessions.get(String(taskId))
    if (!contact) return
    taskSessions.delete(String(taskId))
    reminders.delete(String(taskId))
    lastAgentAt.delete(String(taskId))
    persist()
    const r = await deliverTo(contact, `CLOSED — ${reason}`)
    logLine(`close ${contact} (task ${taskId}): ${reason} → delivery ${r?.ok ? r.delivery : 'failed: ' + r?.error}`)
    const contacts = readContacts()
    if (contacts[contact]) {
      const next = { ...contacts }
      delete next[contact]
      writeContacts(next)
    }
  }

  // ── queue logic ───────────────────────────────────────────────────────
  async function afterDone(task) {
    const ids = Array.isArray(task?.metadata?.after) ? task.metadata.after : []
    for (const id of ids) {
      try {
        const t = await api(`/tasks/${id}`)
        if (t?.status !== 'done') return false
      } catch {
        return false
      }
    }
    return true
  }

  async function trySpawnWaiting() {
    let waiting = []
    try {
      const assigned = await api('/tasks?status=assigned')
      waiting = Array.isArray(assigned) ? assigned : assigned?.tasks ?? []
    } catch (e) {
      logLine(`queue pull failed: ${e?.message}`)
      return
    }
    if (waiting.length) {
      const { ok, cause } = await dshWebReady()
      if (!ok) {
        logLine('spawn deferred to next tick')
        // loud once per distinct config error per task — a bad mc config must not be silent
        for (const t of waiting) {
          const dshAgent = dshAgentByName(t.assigned_to)
          if (!dshAgent || !projectMapped(t) || t?.metadata?.dsh_session) continue
          if (gateNotes.get(String(t.id)) === cause) continue
          gateNotes.set(String(t.id), cause)
          await mcNote(t.id, `dsh-runtime · BLOCKED · spawn deferred, dsh model gate failing: ${cause.slice(0, 200)}`)
        }
        return
      }
    }
    const candidates = []
    for (const task of waiting) {
      if (taskSessions.has(String(task.id))) continue
      const mcAgent = dshAgentByName(task.assigned_to)
      if (!mcAgent) continue
      if (!projectMapped(task)) continue
      if (task?.metadata?.dsh_session) continue // reconcile owns it
      candidates.push(task)
    }
    candidates.sort((a, b) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      Number(a?.metadata?.queue ?? Infinity) - Number(b?.metadata?.queue ?? Infinity) ||
      Number(a.id) - Number(b.id))
    for (const task of candidates) {
      if (seatsUsed() >= cfg.maxSessions) {
        logLine(`seat cap ${cfg.maxSessions} reached — task ${task.id} waits`)
        break
      }
      if (!(await afterDone(task))) continue
      const mcAgent = dshAgentByName(task.assigned_to)
      const r = await spawnSession(task, mcAgent)
      if (!r.ok) {
        const reason = String(r.error ?? 'unknown')
        if (!/already live/.test(reason)) {
          const st = spawnFails.get(String(task.id)) ?? { tries: 0, lastError: '' }
          if (st.tries >= 3) continue // gave up — left for a human
          st.tries = r.leaked ? 99 : st.tries + 1 // a leaked session must not multiply — no retry
          if (reason !== st.lastError) {
            st.lastError = reason
            await mcNote(task.id, `dsh-runtime · BLOCKED · spawn failed: ${reason.split('\n')[0].slice(0, 200)}${r.leaked ? ' (session could not be disposed — manual cleanup needed)' : ''}`)
          }
          spawnFails.set(String(task.id), st)
          logLine(`spawn task ${task.id} failed (try ${st.tries}/3): ${reason.split('\n')[0]}`)
        }
        continue
      }
      spawnFails.delete(String(task.id))
      await setMetadataSession(task, r.contact)
      await mcNote(task.id, `dsh-runtime · NOTE · spawned ${r.contact}`)
    }
  }

  function dshAgentByName(name) {
    const a = agentsCache.get(String(name ?? '').trim())
    return a?.config?.runtime === 'dsh' ? a : null
  }
  function projectMapped(task) {
    const project = projectsCache.get(task.project_id) ?? projectsCache.get(String(task.project_id))
    if (!project) return false
    return Boolean(cfg.projects[project.slug] ?? cfg.projects[String(project.id)])
  }

  // ── event handlers ────────────────────────────────────────────────────
  function debounce(taskId, fn) {
    clearTimeout(debounces.get(taskId))
    debounces.set(taskId, setTimeout(async () => {
      debounces.delete(taskId)
      try {
        const task = await api(`/tasks/${taskId}`)
        if (task) await fn(task)
      } catch (e) {
        logLine(`task ${taskId} re-get failed: ${e?.message}`)
      }
    }, DEBOUNCE_MS))
  }

  async function onTaskUpsert(task, prevStatus) {
    const id = String(task.id)
    const status = task.status
    const contact = taskSessions.get(id) ?? task?.metadata?.dsh_session ?? null

    // Close conditions
    if (['done', 'failed'].includes(status) || task.assigned_to === null || task.assigned_to === '') {
      if (contact) await closeSession(id, `task ${status || 'removed'}`)
      return
    }

    // QA rejection: back to work
    if (contact && ['assigned', 'in_progress'].includes(status) && ['review', 'quality_review'].includes(prevStatus ?? '')) {
      const r = await deliverTo(contact, `${ticketText(task)} · back to you: read the newest review comment and fix`)
      if (!r.ok) return handleDead(task, contact, r)
      logLine(`QA-reject delivered to ${contact} (task ${id})`)
      return
    }

    // Spawn conditions
    if (status === 'assigned' && !contact && dshAgentByName(task.assigned_to) && projectMapped(task)) {
      await trySpawnWaiting()
    }
  }

  function ticketText(task) {
    const project = projectsCache.get(task.project_id) ?? projectsCache.get(String(task.project_id))
    return project ? ticketOf(task, project) : String(task.id)
  }

  async function handleDead(task, contact, r) {
    if (!/not live/.test(r?.error ?? '')) {
      logLine(`deliver to ${contact} failed: ${r?.error}`)
      return
    }
    const retry = await deliverTo(contact, `${ticketText(task)} · session resume ping — continue your task`, { resumeIfDead: true })
    if (retry.ok) {
      logLine(`resumed dead session ${contact} (task ${task.id})`)
      return
    }
    await mcNote(task.id, `dsh-runtime · BLOCKED · session ${contact} dead`)
    await setStatus(task.id, 'assigned')
    taskSessions.delete(String(task.id))
    persist()
    logLine(`session ${contact} dead and unresumable — task ${task.id} back to assigned`)
  }

  async function onComment(act) {
    const taskId = String(act?.data?.task_id ?? '')
    const actor = String(act?.actor ?? '')
    if (ACTORS_DSH.has(actor)) return
    const contact = taskSessions.get(taskId)
    if (!contact) return
    const contacts = readContacts()[contact]
    if (!contacts) return
    try {
      const comments = await api(`/tasks/${taskId}/comments`)
      const list = Array.isArray(comments) ? comments : comments?.comments ?? []
      const target = list.filter((c) => c.author === actor).at(-1)
      const full = target?.content ?? String(act?.data?.content_preview ?? '')
      if (typeof full === 'string' && full.startsWith(`${contact} · `)) return // agent's own signed note
      const r = await deliverTo(contact, `${ticketText({ project_id: act?.data?.project_id, id: taskId, project_ticket_no: act?.data?.project_ticket_no })} · new comment from ${actor}: ${full}\n\nact on it (mc_list_comments id=${taskId})`)
      if (!r.ok) logLine(`comment delivery to ${contact} failed: ${r?.error}`)
      else logLine(`comment from ${actor} delivered to ${contact} (task ${taskId})`)
    } catch (e) {
      logLine(`comment fetch task ${taskId} failed: ${e?.message}`)
    }
  }

  // ── scheduler: silence reminders + queue re-check ─────────────────────
  let tickTimer = null
  async function tick() {
    if (disposed) return
    try {
      const inProgress = await api('/tasks?status=in_progress')
      const rows = Array.isArray(inProgress) ? inProgress : inProgress?.tasks ?? []
      for (const task of rows) {
        const id = String(task.id)
        const contact = taskSessions.get(id)
        if (!contact) continue
        const c = readContacts()[contact]
        const agent = c ? agentCtx?.agents?.get(c.sessionId) : null
        const idle = !agent || agent.status === 'idle'
        const last = lastAgentAt.get(id) ?? 0
        if (idle && Date.now() - last > cfg.silentMinutes * 60_000) {
          const st = reminders.get(id) ?? { count: 0, lastAt: 0 }
          const due = Date.now() - st.lastAt > 5 * 60_000
          if (due && st.count < 2) {
            st.count += 1
            st.lastAt = Date.now()
            reminders.set(id, st)
            await deliverTo(contact, `${ticketText(task)} · reminder ${st.count}/2: no activity for ${cfg.silentMinutes}+ min — comment or update the task`)
            logLine(`silence reminder ${st.count}/2 → ${contact}`)
          } else if (due && st.count >= 2) {
            await mcNote(task.id, `dsh-runtime · BLOCKED · ${contact} silent after 2 reminders`)
            reminders.set(id, { count: 0, lastAt: Date.now() })
            logLine(`BLOCKED comment posted for ${contact} (task ${id})`)
          }
        } else if (!idle) {
          reminders.delete(id)
        }
      }
      await trySpawnWaiting()
    } catch (e) {
      logLine(`tick failed: ${e?.message}`)
    }
  }

  // ── reconcile ─────────────────────────────────────────────────────────
  async function reconcile() {
    logLine('reconcile start')
    for (const status of ['assigned', 'in_progress', 'review', 'quality_review', 'awaiting_owner']) {
      let rows = []
      try {
        const res = await api(`/tasks?status=${status}`)
        rows = Array.isArray(res) ? res : res?.tasks ?? []
      } catch (e) {
        logLine(`reconcile ${status} pull failed: ${e?.message}`)
        continue
      }
      for (const task of rows) {
        const id = String(task.id)
        const wanted = task?.metadata?.dsh_session
        if (wanted) {
          taskSessions.set(id, wanted)
          const c = readContacts()[wanted]
          if (!c) {
            // contact gone — clear marker so it can respawn
            await setMetadataSession({ ...task, metadata: { ...task.metadata, dsh_session: null } }, null).catch(() => {})
            try {
              const metadata = { ...(task.metadata ?? {}) }
              delete metadata.dsh_session
              await api(`/tasks/${task.id}`, { method: 'PUT', body: { metadata } })
            } catch {}
            taskSessions.delete(id)
          }
        }
      }
    }
    // close sessions whose task is done/failed/gone
    for (const [id, contact] of [...taskSessions.entries()]) {
      let task = null
      try {
        task = await api(`/tasks/${id}`)
      } catch {}
      if (!task || ['done', 'failed'].includes(task.status)) {
        await closeSession(id, task ? `task ${task.status}` : 'task gone')
      }
    }
    await trySpawnWaiting()
    logLine(`reconcile done — tracked ${taskSessions.size}, seats ${seatsUsed()}/${cfg.maxSessions}`)
  }

  // ── SSE ───────────────────────────────────────────────────────────────
  let backoff = 1000
  async function sseLoop() {
    while (!disposed) {
      abort = new AbortController()
      try {
        const res = await fetch(`${cfg.url}/api/events`, {
          headers: { 'x-api-key': apiKey, Accept: 'text/event-stream' },
          signal: abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        mcConnected = true
        backoff = 1000
        logLine('SSE connected')
        await refreshCaches()
        await reconcile()
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            let ev
            try {
              ev = JSON.parse(line.slice(5).trim())
            } catch {
              continue
            }
            if (!ev?.type || ev.type === 'heartbeat' || ev.type === 'connected') continue
            lastEventAt = new Date().toISOString()
            handleEvent(ev).catch((e) => logLine(`event ${ev?.type} failed: ${e?.message}`))
          }
        }
        throw new Error('SSE stream ended')
      } catch (e) {
        mcConnected = false
        if (disposed) return
        logLine(`SSE down (${e?.message}) — reconnect in ${backoff}ms`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  async function refreshCaches() {
    try {
      const agents = await api('/agents')
      const list = Array.isArray(agents) ? agents : agents?.agents ?? []
      agentsCache = new Map(list.map((a) => [String(a.name ?? a.id), a]))
      const projects = await api('/projects')
      const plist = Array.isArray(projects) ? projects : projects?.projects ?? []
      projectsCache = new Map()
      for (const p of plist) {
        projectsCache.set(p.id, p)
        projectsCache.set(String(p.id), p)
        if (p.slug) projectsCache.set(p.slug, p)
      }
      logLine(`caches: ${agentsCache.size} agents, ${projectsCache.size} project keys`)
    } catch (e) {
      logLine(`cache refresh failed: ${e?.message}`)
    }
  }

  async function handleEvent(ev) {
    switch (ev.type) {
      case 'agent.created':
      case 'agent.updated':
      case 'agent.deleted':
        await refreshCaches()
        break
      case 'project.created':
      case 'project.updated':
      case 'project.deleted':
        await refreshCaches()
        break
      case 'task.created':
      case 'task.updated': {
        const task = ev.data ?? ev.task
        if (!task?.id) return
        const prev = taskSessions.get(String(task.id)) ? undefined : ev?.data?.previous_status ?? ev?.previous_status
        debounce(task.id, (fresh) => onTaskUpsert(fresh, prev))
        break
      }
      case 'task.deleted': {
        const id = String(ev?.data?.id ?? ev?.data?.task_id ?? '')
        if (id) await closeSession(id, 'task deleted')
        break
      }
      case 'activity.created': {
        const d = ev.data ?? {}
        if (d.type === 'comment_added') await onComment(ev)
        else {
          const id = String(d?.task_id ?? '')
          if (id && ACTORS_DSH.has(String(ev.actor ?? ''))) lastAgentAt.set(id, Date.now())
        }
        break
      }
      default:
        break
    }
  }

  // ── health route ──────────────────────────────────────────────────────
  let disposeHealth = null
  try {
    disposeHealth = ctx.webServer.register({
      path: '/api/agents-in-the-loop/mc-health',
      handler: async (req, res) => {
        const addr = req.socket?.remoteAddress ?? ''
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: 'forbidden: loopback-only' }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          ok: true,
          mc_connected: mcConnected,
          last_event_at: lastEventAt,
          live_sessions: seatsUsed(),
          maxSessions: cfg.maxSessions,
          tracked_tasks: taskSessions.size,
          waiting_tasks: null,
        }))
      },
    })
  } catch (e) {
    logLine(`health route registration failed: ${e?.message}`)
  }

  // ── start ─────────────────────────────────────────────────────────────
  logLine(`starting — url=${cfg.url} maxSessions=${cfg.maxSessions} silentMinutes=${cfg.silentMinutes} projects=${Object.keys(cfg.projects).join(',') || 'none'}`)
  sseLoop()
  tickTimer = setInterval(tick, TICK_MS)

  return () => {
    disposed = true
    clearInterval(tickTimer)
    for (const t of debounces.values()) clearTimeout(t)
    try {
      abort?.abort()
    } catch {}
    try {
      disposeHealth?.()
    } catch {}
    logLine('stopped')
  }
}
