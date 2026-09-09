# agents-in-the-loop

**Cross-session call center for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai)
agents.** Two model tools, nothing else: `session_message` delivers messages
between ANY two sessions on the dsh instance, and `contacts` is a named
directory over session ids so agents reach each other by alias in one call.

Formerly **taskboard-flow** — the kanban trigger/triage/task engine was
removed in v1.0.0; the messaging core is preserved verbatim.

Config is **file-based** (a cordis composition patch). No web UI, no database,
no background polling — the plugin is inert until an agent calls a tool.

## What it gives your agents

- **`session_message`** — list live sessions; send a message to another
  session. Delivery rules (battle-tested, preserved):
  - **Idle target + wake** (default): the FULL message text is rendered into
    the target conversation (steer, followup fallback) AND pushed into its
    runtime context (~30-min TTL). Main GUI sessions start a turn only on
    user input — the text is visible the moment anyone opens the session.
  - **Busy target + wake**: the full text is injected as a plugin-source
    notice — visible immediately, mid-turn safe, starts no turn — plus the
    runtime-context note.
  - `resumeIfDead: true` resurrects a dead target first (opt-in).
  - Self-send is refused.
- **`contacts`** — a named directory over raw session ids (`list` / `get` /
  `call` / `add` / `update` / `remove`):
  - Resolve "advisor" → session id + label + **live status** in ONE call
    (no `session_message list` + guessing).
  - `call` messages the contact through the same delivery engine.
  - **Self-registration needs the NAME ONLY**: `add` with no `sessionId`
    registers the calling session automatically (v1.0.0 carries the
    taskboard-flow v0.7.3 behavior) — never research your own session id.
  - Names: lowercase `[a-z0-9._-]`, ≤64 chars.

## Install

```bash
dsh plugin --profile web add link:/path/to/agents-in-the-loop
cp cordis.patch.yml.example cordis.patch.yml   # then edit
```

Restart `dsh web` afterwards. The tools appear for every session.

## Configuration

One row (see `cordis.patch.yml.example`):

```yaml
- insert:
    - id: agents-in-the-loop
      name: agents-in-the-loop
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
working. Atomic tmp+rename writes; personal state, never shipped.

## Data & cleanup notes

- `~/.dsh/taskboard-flow-contacts.json` — the contacts store (kept).
- `~/.dsh/taskboard-flow-state.json` — the old dispatch-state file; the
  v1.0.0 plugin never reads it and it can be deleted.

## Requirements

- A running **dsh web** deployment (dsh ≥ 0.1.1).
- No other dependencies; no dsh-taskboard needed (the board plugin is no
  longer required by this plugin).

## License

MIT
