# dsh-agents-in-the-loop

> **Disclaimer:** this plugin was fully and automagically coded by
> **GLM 5.3 Flash** (Z.ai) running inside the DeepSeek Harness agent
> federation. **Mark Elayan is just the brains** — he directs, reviews, and
> owns every decision; the model does the typing. :D

**Cross-session call center for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai)
agents.** Two model tools — `session_message` and `contacts` — plus a
loopback-only HTTP API so agents OUTSIDE dsh (Claude Code, scripts) can
send messages to registered contacts, and so a client panel can read and
manage the contact directory.

Formerly **taskboard-flow** — the kanban trigger/triage/task engine was
removed in v1.0.0 (and the web UI in v1.3.0); the messaging core is
preserved verbatim.

## Features at a glance

- **`session_message`** — list live sessions; deliver a message to any
  registered contact (by NAME — raw session ids are rejected since v1.4.2).
- **`contacts`** — a named directory over session ids: resolve an alias to
  session id + label + LIVE status in one call, message it, manage entries
  at runtime (add / update / rename / remove, no config edit, no restart).
- **External send-only HTTP API** (v1.5.0) — `POST
  /api/agents-in-the-loop/message`: loopback curl from any outside agent.
  Externals never register, never receive, never resurrect sessions.
- **Contacts HTTP API** — `GET/POST/PUT/DELETE
  /api/agents-in-the-loop/contacts` + `GET /sessions` for a client panel.
- **`spawn_session`** (v1.8.0, `spawn.enabled`, default OFF) — spawn a NEW
  persistent dsh session in-process (no external scripts, no MC required):
  preset pin + config-pinned model, optional workspace/permission, seat cap,
  contacts registration, first message delivered. Spawned sessions are
  persistent co-workers reachable by name via `session_message`/`contacts`.
- **State-aware delivery engine** (shared by all paths): every
  message lands exactly once — idle target gets the full text rendered
  visibly into its conversation; busy target gets a mid-turn-safe visible
  notice; optional `resumeIfDead` resurrects dead sessions.

## How delivery works

All sends (tools and HTTP) go through one delivery engine:

| Target state | What happens | Result fields |
|---|---|---|
| **idle** + wake | full text rendered into the target conversation (steer, fallback followup) | `delivery: wake-steer` (or `wake-followup`), `nudgeVia` |
| **busy**, or `wake: false` | full text queued with `agent.inject()` as a visible plugin-source notice for the target's next step — mid-turn safe, starts no turn | `delivery: notice`, `noticeInjected: true` |

Harness physics: main GUI sessions start turns on user input, so an idle
wake renders the message but does not force a turn — the agent reads it at
its next turn from conversation history.

**Context hygiene (v1.6.0).** Each message is delivered exactly **once** as
an ordinary conversation message, so normal compaction can summarize it
away. Messages are capped at **8000 chars** (truncated with a note — send
long reports as a file path) and end with a one-line hint telling the
compaction summarizer to keep only sender + gist. The pre-1.6 runtime-context
note channel (`systemPrompt.context()`) is gone: on dsh 0.2 every change to
runtime-context text is materialized as a new full snapshot message in
history, so the 5-note / 30-min buffer re-copied every buffered message on
each delivery and each expiry — the context bloat that compaction could not
remove.

**`resumeIfDead: true`** (opt-in) resurrects a dead target via
`AgentRegistry.resume` before delivering; the resumed agent gets the
deployment-default model selection (a resumed agent must carry a model
route or its wake turn fails on the `{{model}}` prompt variable). Self-send
is always refused. Status is read exactly once per send (mid-send
idle→busy flips previously produced contradictory results).

**Targeting law (v1.4.2):** `session_message send` accepts ONLY a
registered contact name as `target` — resolved against the live contacts
store at call time, so a re-raised agent re-registered under the same name
is always reached. A raw `session-…` id is rejected with an error pointing
at `session_message`/`contacts` action `"list"`. `contacts call` is and
always was name-based.

## The `session_message` tool

```
session_message { action: "list" }                     → live sessions [{id,status,contact?}]
session_message { action: "send", target, message,     → deliver
                  wake?, resumeIfDead? }
```

- `target` — registered contact name (required for send).
- `list` annotates each live session with its registered `contact` name;
  successful sends report `resolvedFrom: <contact>`.
- `wake` defaults to true; `resumeIfDead` defaults to false.

## The `contacts` tool

```
contacts { action: "list" }                                → every contact + live status + store file
contacts { action: "get", name }                           → one contact + status
contacts { action: "call", name, message, wake?, resumeIfDead? } → message via the delivery engine
contacts { action: "add", name, sessionId?, label?, tags?, note? }
contacts { action: "update", name, sessionId?, label?, tags?, note?, rename? }
contacts { action: "remove", name }
```

- **Self-registration needs the NAME ONLY**: `add` with no `sessionId`
  (or `"self"`) registers the CALLING session automatically — never
  research your own session id. An explicit id registers another session.
- Names: lowercase `[a-z0-9._-]`, ≤64 chars.
- `add` on a not-currently-live session still saves the contact and
  returns a `warn` — `resumeIfDead` can reach it later.
- Records carry `label`, `tags`, `note`, `createdAt`, `updatedAt`, and a
  computed live `status` (`idle` / `running` / … / `dead`).

## The `spawn_session` tool (v1.8.0 — default OFF)

Spawns a NEW persistent dsh session the way the Mission Control bridge does,
but fully in-process (host `agents.create` + `agentPresets` resolve/mount +
`workspaces` — the same faces dsh-taskboard uses for scheduled executions):

- args: `name` (contacts name for the new session) + `message` (first task
  brief, delivered once via the shared engine); optional `preset`
  (default `spawn.preset`), `workspaceId` (must be allowlisted),
  `permission` (`read-only` default; must be in `spawn.allowedPermissions`),
  `wake` (default true).
- The model is pinned by config (`spawn.provider/model`) and CANNOT be
  chosen per call — passing `model`/`provider` is rejected with an error.
- Preset is resolved BEFORE creation and mounted in `setup` — a session
  without a resolvable preset is refused, never spawned as a bare shell.
- Seat cap counts live sessions registered in the contacts store
  (`spawn.maxSessions`); every spawn appends a line to the JSONL journal
  (`spawn.stateFile`) for audit.
- Missing faces degrade loudly: no `agentPresets` → refuse; no
  `permissionPresets` → reject the permission arg; missing rename/attach
  are skipped as cosmetic.
- Spawned sessions are PERSISTENT peers (deliberately registered in
  contacts, reachable by name) — distinct from 1-shot `subagent` children,
  which must never enter the directory.

## External agents (send-only HTTP API)

Agents outside dsh (Claude Code, scripts) can **send** messages to any
registered contact over loopback HTTP. They never register, never appear
in the contacts store, and never receive messages. `resumeIfDead` is
hard-wired `false`: a dead session is refused (409), never resurrected.

```bash
curl -s http://127.0.0.1:9001/api/agents-in-the-loop/message \
  -H 'Content-Type: application/json' \
  -d '{"from":"claude-code","contact":"dev-lead","message":"task done"}'
```

- `from` — free-form sender label (default `external-agent`, truncated to
  64 chars), shown as `From <from>:` in the target conversation.
- Delivery is identical to the `session_message` tool.

| Status | Meaning |
|---|---|
| 200 | delivered — `{ok, contact, from, nudgeVia, noticeInjected}` |
| 400 | invalid JSON / invalid contact name / empty message |
| 403 | not loopback (`forbidden: loopback-only`) |
| 404 | unknown contact |
| 405 | method not allowed (POST only) |
| 409 | delivery refused (e.g. target session dead) |

## Contacts panel HTTP API

Same loopback fence, same JSON conventions:

- `GET /api/agents-in-the-loop/sessions` — live sessions `[{id,status}]`.
- `GET /api/agents-in-the-loop/contacts` — every contact + live status.
- `POST …/contacts` — create; body `{name, sessionId, label?, tags?, note?}`.
- `PUT …/contacts` — update; body `{name, sessionId?, label?, tags?, note?, rename?}`.
- `DELETE …/contacts?name=<name>` — remove.

Errors: 400 invalid input, 404 unknown contact, 405 wrong method,
409 name/rename collision, 500 persist failure.

## Install

```bash
dsh plugin --profile web add link:/path/to/agents-in-the-loop   # or: npm i dsh-agents-in-the-loop
```

Then add the plugin row to your profile's cordis composition patch (see
`cordis.patch.yml` in this repo for the shape) and **restart `dsh web`**.

## Configuration

One row (all keys optional, defaults shown):

```yaml
- insert:
    - id: dsh-agents-in-the-loop
      name: dsh-agents-in-the-loop
      config:
        enabled: true
        sessionMessage:
          enabled: true      # kill-switch for the session_message tool
        contacts:
          enabled: true      # kill-switch for the contacts tool
          # file: '~/.dsh/taskboard-flow-contacts.json'   # default store
        spawn:
          enabled: false          # kill-switch for the spawn_session tool
          maxSessions: 9          # seat cap over the contacts store
          preset: ''              # default preset ('' = caller must pass one)
          allowedPresets: []      # empty = any resolvable preset
          provider: zai-coding-cn # model pin — CONFIG-ONLY, never a tool arg
          model: glm-5.3-flash
          allowedModels: [zai-coding-cn/glm-5.3-flash, openai-codex/gpt-6-luna]
          workspaces: []          # workspace-id allowlist; empty = caller default
          allowedPermissions: [read-only]
          stateFile: '~/.dsh/spawned-sessions.json'  # JSONL audit journal
```

The contacts store defaults to `~/.dsh/taskboard-flow-contacts.json` — the
historical taskboard-flow path, so contacts created before the rename keep
working. Atomic tmp+rename writes; personal state, never shipped. A `~/`
prefix in a custom path expands. Contact CRUD via the HTTP API and the
`contacts` tool write the same store — no config edit or restart needed
for directory changes.

## Permissions, external services & failure bounds

Disclosed capability surface (this plugin is intentionally privileged):

- **Filesystem**: reads and writes exactly ONE file — the contacts store
  above. No other filesystem access.
- **Network**: registers loopback HTTP routes on the dsh web server
  (`127.0.0.1:9001`, custom fence rejects non-loopback peers with 403).
  The external send-only API accepts inbound loopback POSTs; no outbound
  network calls are ever made.
- **Process**: no subprocess/shell execution, no child processes.
- **Credentials**: none read, stored, or transmitted. No secrets.
- **External services**: none. Zero runtime dependencies, zero lifecycle
  scripts (`preinstall`/`install`/`postinstall`/`prepare`).
- **Audit trail**: action logs go to `console.log` (dsh's `ctx.logger`
  output never reaches `~/.dsh/dsh-web.log` — verified 2026-08-28).
- **Failure bounds**: if the dsh core APIs the plugin injects into change
  shape, the plugin logs the failure and degrades to inert — it never
  blocks session composition or other plugins. The external message route
  refuses (409) rather than resurrecting dead sessions.

## Compatibility

- **DSH `>=0.1.2`** (hard floor): `resumeIfDead` relies on
  `agents.resume({ resumeSessionId })`, introduced in dsh 0.1.2. Declared
  in `package.json` via `engines` + optional `peerDependencies`, and in
  `dsh.compatibility.dshReleases` (the DSH-Store catalog matrix):
  `0.1.2`, `0.1.6-alpha.1`, `0.1.7-rc.2` / `0.2.0-rc.2` — each verified compatible.
- **Node `>=20`**.

No web UI, no database, no background polling — the plugin is inert until
an agent calls a tool or an HTTP route is hit.

## Data & cleanup notes

- `~/.dsh/taskboard-flow-contacts.json` — the contacts store (kept).
- `~/.dsh/taskboard-flow-state.json` — the old dispatch-state file; the
  v1.0.0+ plugin never reads it and it can be deleted.

## Requirements

- A running **dsh web** deployment (dsh ≥ 0.1.2).
- No other dependencies; dsh-taskboard is NOT required.

## License

MIT

## Mission Control integration (optional, v1.7.0)

Optional bridge that lets a Mission Control (MC) API drive dsh agent
sessions. **OFF by default** — the plugin behaves exactly as v1.6.0 unless
`mc.enabled: true` is set in the plugin config. When off: no SSE connection,
no spawn, and `/api/agents-in-the-loop/mc-health` answers `{"ok":true,"enabled":false}`.

When enabled it:

- spawns a dsh session (via `~/.dsh/new-session.mjs`) when an MC task is
  assigned to an agent whose config has `runtime: "dsh"` (model/provider are
  assigned ONLY at spawn; MC agent config overrides the mc block);
- delivers MC task comments and review-rejects into the session;
- closes the session and frees its seat when the task reaches done/failed/deleted;
- enforces seats (`maxSessions`), priority ordering, and `metadata.after`
  dependencies; reminds silent sessions (2 reminders, then a BLOCKED comment);
- reconciles on startup/reconnect (no duplicate sessions) and posts loud
  `dsh-runtime · BLOCKED · spawn failed: …` comments (max 3 tries).

Config keys (plugin config → `mc`):

| key | type | default | notes |
|---|---|---|---|
| `enabled` | boolean | `false` | master switch |
| `url` | string | `http://127.0.0.1:9999` | MC API base |
| `apiKeyFile` | string | — | path to JSON `{"key": "…"}`; required when enabled |
| `maxSessions` | int | `9` | seat cap |
| `silentMinutes` | int | `20` | reminder threshold |
| `excludedContacts` | string[] | `["dsh-maintainer"]` | excluded from seat count |
| `provider` / `model` | string | `zai-coding-cn` / `glm-5.3-flash` | spawn-time model ids |
| `newSession` | string | `~/.dsh/new-session.mjs` | spawner path |
| `stateFile` | string | `~/.dsh/mc-runtime-state.json` | journal |
| `projects.<slug>.workspaceId` | string | — | MC project → dsh workspace |
| `projects.<slug>.firstMessage` | string | — | template path ({TICKET} {TITLE} {SESSION} {TASK_ID} {PROJECT} {ROLE} {RULES}) |
| `projects.<slug>.rules` | string | — | appended RULES text |

Minimal example:

```yaml
mc:
  enabled: true
  url: 'http://127.0.0.1:9999'
  apiKeyFile: '/path/to/.dsh-runtime-key.json'
  projects:
    sandbox:
      workspaceId: '<workspace-uuid>'
      firstMessage: '/path/to/first-message.txt'
      rules: 'TEST task: MC tools only.'
```

A missing/unreadable key file or unreachable MC logs one clear warning; the
rest of the plugin keeps working.

---

# MCP server (v1.9.0) & Inbox/callcenter (v1.10.0) — full reference

Everything below ships in the same plugin and rides the dsh web server the
plugin already uses. **No new npm dependencies** — the MCP protocol is
implemented by hand (`lib/mcp.js`) as plain JSON-RPC 2.0, and the inbox/
contacts store uses `node:sqlite`, which is built into Node ≥ 22
(`lib/inbox.js`). Nothing here can be pruned by a package-manager pass.

## The MCP endpoint

- **URL**: `http://127.0.0.1:9001/api/agents-in-the-loop/mcp`
- **Transport**: stateless streamable-HTTP, JSON responses only (no SSE).
  Every POST is self-contained; there are no session ids and nothing to
  reconnect. Supported methods: `initialize`, `notifications/initialized`
  (acked with 202), `tools/list`, `tools/call`, `ping`; batch arrays are
  accepted. GET/DELETE → 405.
- **Auth fence (in order)**: loopback-only (remoteAddress must be
  127.0.0.1/::1, no XFF spoofing) → `Authorization: Bearer <key>` checked
  with a timing-safe compare → only then protocol handling. No request
  reaches a tool without both fences. Missing/corrupt key file = locked
  (fail closed). Error mapping: `-32700` parse, `-32600` invalid request
  (also empty batch, non-object body, id-less request), `-32601` unknown
  method, `-32603` internal (echoes request id).
- **Protocol version**: echoes the client's version when it is one of
  `2024-11-05` / `2025-03-26` / `2025-06-18`, else falls back to
  `2025-03-26`.

### ⚠️ SECURITY — read before enabling

- **The API key is a full-harness-capability credential.** With
  `allTools: true` (see below) any holder of the key can run `bash`, read
  and write files, and drive every registered dsh tool on this machine.
  Treat it like an SSH key: never commit it, never paste it in chats or
  tickets, keep the file at `0600`.
- **Loopback-only by design.** The endpoint is unreachable from the
  network. Anything running ON this machine that can read the key file can
  impersonate any harness — that trust boundary is accepted and documented;
  do not relax `allowNonLoopback` unless you understand the consequence.
- **Identity spoofing is possible under the shared key** (any local
  process may claim any `X-Aitl-Identity`). Accepted risk; per-harness keys
  would close it (not implemented by owner decision).
- No per-identity rate limiting yet (documented gap); `maxPending`,
  `maxChars` and the auth fence are the mitigations.
- External message text is UNTRUSTED DATA. It is delivered inside the
  plugin's existing `[agents-in-the-loop: inter-session message …]`
  envelope and must never be executed by the receiving agent.

### Setup

1. Generate a key file (JSON `{"key":"aitl_<hex>"}`, min 16 chars, chmod
   0600 — e.g. `~/.dsh/aitl-mcp-key.json`). The endpoint fail-closes
   without it.
2. Point the MCP client at the URL above with header
   `Authorization: Bearer <key>`.
3. (Inbox identities only) add header `X-Aitl-Identity: <contact-name>`.

Verified clients: dsh `mcp_manager` (streamable-http), Claude Code CLI
(`claude mcp add --transport http … --header "Authorization: Bearer …"`),
Codex (`[mcp_servers.aitl]` with `url` + `http_headers` in
`config.toml`), raw curl.

## allTools mode (full control)

`mcp.allTools: true` exposes **every registered harness tool** through
`tools/list` and `tools/call` — bash, file tools, taskboard, memory, all of
it — not just this plugin's three. Enumeration probes the dsh tools
service (`view().visible` → `list()` → `schemas()`), dedupes, and logs
once which surface answered (`allTools enumeration: N tools via …`); a
miss logs `NO MATCHED SURFACE` so dsh-version drift is visible. Tools that
need a live session context degrade to `isError` results instead of
crashing the endpoint. **Default `false`.** Enable only on a machine where
key holders are trusted with full shell access.

## Inbox / callcenter (v1.10.0)

Solves the reverse direction: dsh agents can now message external
harnesses back.

- **Store**: ONE SQLite database (default `~/.dsh/aitl.db`; WAL,
  `busy_timeout=5000`) holds contacts AND maildrops. On first boot the
  legacy contacts JSON is imported idempotently and renamed
  `*.json.migrated` (import re-runs are no-ops). `contacts` and
  `session_message` read/write the DB transparently; the MC bridge and
  HTTP panel dispatch through the same accessors.
- **Identity**: external harnesses self-assign a contact name in the
  contact center with a sessionId of the form `session-ext-<name>` (e.g.
  `session-ext-codex`). They send every MCP POST with
  `X-Aitl-Identity: <contact-name>`; the endpoint resolves it to that
  contact's session id and the caller acts as that identity. Unknown
  identity → 403 (fail closed). Without the header the caller is the
  anonymous `session-mcp-external` (can call tools, has no maildrop, may
  not register external contacts).
- **dsh → external**: `session_message` (or `inbox send`) targeting an
  external contact **enqueues** into its maildrop (`delivery: "inbox"`)
  instead of direct delivery. States: `pending → delivered` (on poll) `→
  acked` (on ack). At-least-once: a delivered message is re-offered after
  `redeliverAfterMin` if never acked. Per-thread FIFO, 7-day TTL (hourly
  sweep), max 100 unacked per recipient — oversize (> 8000 chars) and
  over-cap sends are REJECTED, never truncated (the legacy direct path
  still truncates; both behaviors are intentional).
- **external → dsh**: unchanged direct delivery via `session_message`/
  `inbox send` to a dsh contact (wakes idle sessions exactly once, as
  always).
- **Threading**: `threadId` (`[a-z0-9-]{6,64}`, sender-minted or
  generated) + `replyTo` (validated: must reference a message in the
  caller's conversation).
- **Registration ownership (anti-hijack)**: a `session-ext-*` sessionId
  may only be registered/updated by the matching identity. The anonymous
  MCP caller and dsh agents cannot create or re-point external maildrops;
  contact-center assignment happens through the loopback HTTP panel or the
  harness's own identity.
- **Web panel**: `GET /api/agents-in-the-loop/inbox` (when
  `mcp.inbox.panel.enabled`) — loopback-guarded HTML view of the maildrops,
  message bodies escaped on render. It deliberately does NOT use the
  bearer key (browsers cannot hold it; the loopback fence is the
  boundary).

### The `inbox` tool

One tool for external harnesses (over MCP) — registered only when
`mcp.inbox.enabled`:

| action | args | effect |
|--------|------|--------|
| `poll` | — | take pending messages (marks `delivered`; redelivered after the window) |
| `ack` | `id` | confirm handling (`delivered → acked`) |
| `list` | `includeAcked?` | inspect without taking |
| `peek` | `id` | read one message without taking |
| `send` | `target`, `message`, `subject?`, `threadId?`, `replyTo?` | external → dsh by contact name (direct), or dsh/external → external maildrop (enqueue) |

`poll` and `ack` require an `X-Aitl-Identity` with an external contact
behind it; there is no anonymous maildrop.

## Configuration block (added under the plugin's config)

```yaml
mcp:
  enabled: false            # ⚠ flip true only locally; keep false in published defaults
  path: /api/agents-in-the-loop/mcp
  apiKeyFile: ~/.dsh/aitl-mcp-key.json
  callerId: session-mcp-external
  allowNonLoopback: false   # keep false — network exposure is out of scope
  allTools: false           # ⚠ true = FULL machine control for key holders
  identityHeader: x-aitl-identity
  tools: [contacts, session_message, spawn_session]   # used when allTools=false
  inbox:
    enabled: false          # ⚠ flip true only locally
    file: ~/.dsh/aitl.db
    maxChars: 8000
    maxPending: 100
    retentionDays: 7
    redeliverAfterMin: 5
    panel:
      enabled: false        # ⚠ flip true only locally
```

⚠ **Release checklist**: the shipped defaults are the safe values
(`enabled: false` everywhere). Testing deployments flip them in the
bundle/live patch — remember the bundle patch OVERRIDES the live root
overlay on conflict, and revert all TESTING flips before publishing.

## Dependencies & requirements (added by v1.9/v1.10)

- **Node ≥ 22** — `node:sqlite` (DatabaseSync) must exist; there is no
  npm dependency to install or prune (the previous SDK approach was
  removed for exactly that reason).
- Storage: `~/.dsh/aitl.db` (SQLite) + `~/.dsh/aitl-mcp-key.json`
  (0600). Both are personal local state, never shipped.
- No network egress is added: the endpoint only listens on loopback, and
  nothing in v1.9/v1.10 makes outbound calls.

## QA trail

v1.9.0/v1.10.0 passed 4 audit rounds (SOL): plan review (12 gaps
resolved in the implementation contract), full audits with S-level finds
(MCP route not wired; undeclared SDK pruned → hand-rolled rewrite; panel
ordering; mc-runtime store fork; identity-guard direction) — each fixed,
re-audited, and closed. Suite: 56/56 (delivery + spawn + mcp), including
real-HTTP e2e for the protocol path.
