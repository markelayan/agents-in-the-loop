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
- **State-aware delivery engine** (shared by all three paths): every
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
  `0.1.2`, `0.1.6-alpha.1`, `0.1.7-rc.2` — each verified compatible.
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
