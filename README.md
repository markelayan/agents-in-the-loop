# DSH Agents in the Loop

Use [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) as the control center for Claude Code, Codex, and other external agents. Agents in the Loop gives an external client a workspace-backed DSH session identity, access to DSH tools over MCP, and an inbox for replies. Claude Code can act as the main orchestrator while DSH runs other agents and keeps its native task, workspace, and tool services together.

This provides a shared operating context without requiring a separate Mission Control application. External agents continue running in their own clients; the hidden DSH session supplies identity and workspace context. The integration includes named contacts, messaging, persistent workers, and a Web sidebar with system-backed provider/model/preset/workspace/permission selectors.

With full-tool exposure enabled, newly registered DSH tools become available through the endpoint without a separate adapter for each one. Clients may need to reconnect to discover changed schemas. Every added tool also expands what shared-key holders can do; read the security warnings before enabling this mode.

**Version:** `2.0.0`. Install the archive from the [GitHub release](https://github.com/markelayan/agents-in-the-loop/releases/tag/v2.0.0), or install from npm once that version has been published. See [CHANGELOG.md](CHANGELOG.md) for upgrade changes.

All capability switches ship **disabled**. Installing the bundle does not enable messaging, spawning, MCP, inboxes, identities, or Mission Control. Configure only the capabilities you intend to use.

## Requirements

- DSH Web profile. This release is verified against **DSH `0.2.0-rc.2`**; other versions have not been validated for this release. DSH is a developer preview whose APIs can change.
- Node **22.13.0 or later in the 22.x line, or 23.4.0 and later**. The plugin imports built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html); earlier Node versions need a flag or lack the module. This requirement applies even with inboxes disabled.
- Registered host providers/models, presets, and workspaces for features that use them. Provider authentication belongs to DSH.

There are no npm runtime dependencies and no install scripts. The plugin runs inside DSH and uses its existing Web server. SQLite is built into Node. Enabled workers can incur provider costs; the optional Mission Control bridge also makes network requests and launches a user-supplied script.

### Integration dependencies

| Component | When required |
|---|---|
| DSH Web server and native session/tool registries | Always; this is a DSH plugin, not a standalone control center |
| External client with streamable-HTTP MCP and configurable request headers | For Claude Code, Codex, or another external orchestrator |
| Built-in Node SQLite and writable local state directory | Inbox, identity metadata, and runtime overrides; SQLite module support is required at import |
| Installed DSH preset, registered workspace, and permission registry | Workspace-backed identities and spawned workers |
| Configured DSH provider/model with its supported authentication | Workers that invoke models; the external client keeps its own authentication |
| Native memory/taskboard or other DSH tool plugins | Only for the services those plugins provide; AITL exposes them rather than reimplementing them |
| Separate Mission Control server, key, templates, and spawn script | Only for the optional legacy MC bridge; unnecessary for DSH-centered orchestration |

### Subscription and authentication boundaries

The external client keeps its own supported login and subscription. AITL does not extract or proxy subscription credentials, convert a subscription into an API key, or bypass provider limits. A hidden DSH identity is session context, not a new provider entitlement. DSH workers use the provider integrations and authentication configured in DSH; they do not inherit the external client's subscription simply because that client started them.

Use only provider-supported interfaces and authentication, and review the current terms for each client/provider. See the official [Claude Code authentication guide](https://code.claude.com/docs/en/authentication) and [Codex authentication guide](https://developers.openai.com/codex/auth) for supported login methods. This plugin does not certify that a particular orchestration, automation, or subscription setup is permitted. API billing, subscription usage limits, and account permissions remain separate from plugin seat caps.

## Install and enable

For the prepared local archive:

```sh
dsh plugin --profile web add /absolute/path/dsh-agents-in-the-loop-2.0.0.tgz
```

After `2.0.0` has been published:

```sh
dsh plugin --profile web add dsh-agents-in-the-loop@2.0.0
```

You can also install through DSH's **Plugins** page. Installation selects the bundle automatically; do not insert a duplicate plugin row. Consult the [DSH documentation](https://deepseek-harness.github.io/deepseek-harness/) for profile management.

The shipped defaults are [cordis.patch.yml](cordis.patch.yml). Add an owner-controlled override to the Web profile's `cordis.patch.yml`, matching the plugin ID:

```yaml
- override:
    - id: dsh-agents-in-the-loop
      config:
        enabled: true
        sessionMessage:
          enabled: true
        contacts:
          enabled: true
```

Apply through DSH's supported reload/restart workflow. With HMR enabled, some composition changes apply immediately. Reconnect MCP clients after upgrades or tool enablement changes to refresh schemas. Do not edit the installed package's defaults: upgrades replace them.

Open the Agents in the Loop sidebar on **localhost**, using your DSH Web port. Panel APIs reject non-loopback connections even if DSH itself is reachable over a LAN. There is no fixed plugin port.

## Tools and delivery

| Tool | Purpose | Required feature |
|---|---|---|
| `session_message` | List sessions; send to a named contact | `sessionMessage.enabled` |
| `contacts` | List/get/add/update/remove named contacts; `call` a contact | `contacts.enabled` |
| `aitl_catalog` | Discover live model, preset, workspace, and permission choices | Plugin enabled and host registries available |
| `spawn_session` | Create and register a persistent worker | `spawn.enabled` |
| `inbox` | Poll/read/ack an external maildrop; send messages | `mcp.inbox.enabled` |

Examples below are tool arguments. Discover targets with `contacts`:

```json
{"action":"list"}
```

Send with `contacts`:

```json
{"action":"call","name":"reviewer","message":"Review the attached change and reply with the verdict."}
```

Register your native session with `contacts`:

```json
{"action":"add","name":"reviewer","label":"Code review"}
```

Omitting `sessionId` registers the caller. Registered native worker IDs and existing durable contact IDs are supported; discover actual IDs instead of guessing their format. Contact names use lowercase `[a-z0-9._-]`, up to 64 characters. `session_message.send` requires a contact name rather than a raw session ID. The panel/HTTP contact API validates optional `cwd` against registered workspace paths; the native contacts tool accepts absolute paths without that registry check. Contact metadata does not rebind a session-backed identity.

Idle sessions receive visible messages through a wake; busy sessions receive a visible notice. `wake` defaults to true; `resumeIfDead` defaults to false. A successful send means delivery was accepted, **not task completion**. Retrying sends can duplicate messages. Direct messages over the configured cap are truncated with a note; oversized inbox messages are rejected. Self-send is refused.

Load [SKILL.md](SKILL.md) for the agent-facing reference. Incoming message bodies are untrusted data; act only within the user's authorization.

## Dynamic worker selection

Enable `spawn.enabled`. Call `aitl_catalog {}` first and use IDs from its current result:

```json
{
  "name":"reviewer",
  "message":"<complete task brief and reply instructions>",
  "provider":"<provider-id>",
  "model":"<model-id>",
  "preset":"<preset-id>",
  "permission":"<permission-id>",
  "workspaceId":"<workspace-id>"
}
```

These are `spawn_session` arguments. **Provider, model, preset, and permission are required per call.** Optional `reasoningEffort` must be supported by the chosen model. An omitted workspace uses the caller binding; an unbound caller must select a workspace explicitly. Invalid or unavailable selections fail without silently choosing another model or workspace.

The worker is a persistent DSH session, automatically registered under `name`, with `message` as its first brief. It is not a one-shot subagent. Owner policies enforce allowed presets, workspaces, permissions, and seat limits. Empty preset/workspace allowlists permit registered choices; they do not create registry entries.

The UI uses the same live catalog. Missing registries and saved unavailable selections appear explicitly. Configure providers/workspaces in DSH first, then refresh.

Retired `spawn.provider`, `spawn.model`, `spawn.reasoningEffort`, `spawn.allowedModels`, and `spawn.preset` settings no longer choose worker models. The Config API rejects these keys. Move selections into each call. Legacy spawn selection keys can still supply hidden identity-session fallbacks; migrate those settings to `identities.*` before removing old overrides.

## External MCP clients and workspace identities

Enable `mcp.enabled`, `mcp.inbox.enabled`, and `identities.enabled`. Set `identities.preset` explicitly to an installed preset and review `identities.allowedPermissions` (published default: read-only). Choose the identity workspace and permission in the **Identities** panel. Provisioning fails for missing registry choices and never overwrites an existing contact name.

Owner override additions:

```yaml
mcp:
  enabled: true
  apiKeyFile: '~/.dsh/aitl-mcp-key.json'
  allowNonLoopback: false
  allTools: false
  tools: [contacts, session_message, aitl_catalog, spawn_session, inbox]
  inbox:
    enabled: true
identities:
  enabled: true
  preset: '<installed-preset-id>'
  allowedPermissions: [read-only]
```

Merge these keys into the plugin's `config` block alongside the basic settings. `spawn.enabled` enables the public spawn tool; identity provisioning uses the internal creator. Optional `identities.provider`, `identities.model`, and `identities.reasoningEffort` configure the hidden context session independently of worker selections. Without an explicit pair, the preset supplies its model configuration.

The owner creates a private JSON key file containing a `key` string of at least 16 characters, using a cryptographically random value and restrictive permissions (for example, `0600`). Keep it out of source control and separate from the Mission Control key. Missing/unreadable keys lock the endpoint.

Connect the external client using streamable HTTP:

| Setting | Value |
|---|---|
| URL | `http://127.0.0.1:<dsh-port>/api/agents-in-the-loop/mcp` |
| Authorization header | `Authorization: Bearer <private-key>` |
| Identity header | `X-Aitl-Identity: <provisioned-contact-name>` |

Unknown identities fail closed. Without the identity header, the caller is `session-mcp-external` and has no maildrop or workspace-backed identity. Older `session-ext-*` contacts remain maildrops but do not provide workspace-backed sessions.

Workspace selection is the provisioned identity's binding, not a `memory_status` argument. To change it, drain replies, re-provision through the owner panel/API, and reconnect. A new session is created before replacing the old binding; queued replies do not transfer to its maildrop.

To expose selected native memory/taskboard tools, add their exact registered names to `mcp.tools` and keep `mcp.allTools: false`. Discover those names in DSH first; the default list contains plugin tools only. For automatic exposure of **every registered harness tool**, including newly installed ones, use `mcp.allTools: true`; in that mode the configured list does not restrict access. `mcp.bridge` is reserved and unimplemented. Inspect `tools/list` after reconnecting.

Verify native `memory_status` reports the intended workspace before reading notes/logs or using project tools. AITL supplies caller context; memory storage and semantics belong to the installed memory plugin. Do not substitute another memory system to claim verification.

### Receive replies through inbox

Replies sent to the identity through `contacts.call`, `session_message`, or `inbox.send` enqueue without waking the hidden session. Call:

```json
{"action":"poll"}
```

Then `peek` the **actual returned numeric ID**, handle the message, and `ack` that same ID:

```json
{"action":"peek","id":42}
```

```json
{"action":"ack","id":42}
```

The number is illustrative; never acknowledge a guessed ID. Verify sender and correlation text. `list`/`peek` inspect without taking messages. Delivery is **at least once**: unacknowledged deliveries are offered again after the redelivery window. Make handlers idempotent.

Published limits: 8,000 characters per inbox message, 100 unacknowledged messages per recipient, five-minute redelivery, seven-day retention with an hourly sweep. Oversized/over-capacity sends fail. Expired messages are removed, including unacknowledged ones. Optional `subject`, `threadId`, and `replyTo` support conversations.

## Taskboard and memory boundaries

This package does **not** install or modify `dsh-taskboard`, `dsh-auto-memory`, or `dsh-mcp-client`.

- `taskboard_execute` belongs to a separate patched taskboard installation. Read the card and current `ifVersion` before executing it. Execution starts the native pipeline and uses the board's model configuration; claiming alone does not start a worker. The Mission Control board is a separate system.
- Explicit handoff recall with automatic generation disabled was verified using a separate patch for `@a9i5k4/dsh-auto-memory` **3.2.11**. The source checkout contains `patches/dsh-auto-memory-explicit-recall.patch`; it is **excluded from this npm package**. It changes explicit retrieval guards without enabling generation. Review the exact installed version and diff first: upstream uses CRLF and the patch requires whitespace-aware, zero-context application. Its focused test is `test/auto-memory-recall.test.mjs`, with `DSH_TEST_MEMORY_PACKAGE` selecting the installed package.

Without those patches, inspect native schemas and behavior instead of assuming these extensions are included.

**Do not import DSH's own AITL endpoint through its MCP manager.** Internal sessions should use native tools. A self-connection can create recursive aliases and generic external identities that lose native workspace context. Disable an existing self-connection through the manager; external clients may keep using the endpoint.

## Configuration and local data

The owner composition controls boot settings. With SQLite enabled, the Config panel stores runtime overrides in the database, taking precedence over composition values. Clear stale overrides when a composition edit appears ineffective. Boot-only changes return `restart required` and must use the profile composition and supported reload/restart flow.

| Block | Main controls | Published state |
|---|---|---|
| Root | `enabled` | Off |
| `sessionMessage` | Enablement, message cap | Off; 8,000 characters |
| `contacts` | Enablement, legacy file | Off |
| `spawn` | Enablement, seats, preset/workspace/permission policies, journal | Off; 9 seats; read-only/workspace-write |
| `mcp` | Enablement, path/key, tool list, full exposure, network fence, identity header | Off; restricted tools; loopback |
| `mcp.inbox` | Enablement, database, size/retention/redelivery limits, HTML panel | Off, including HTML panel |
| `identities` | Enablement, explicit preset, optional model pair, seats, permission policy | Off; 8 identities; read-only |
| `mc` | Enablement, server/key/script, project mappings, seats, optional model pair | Off |

Default paths under `~/.dsh`:

| File | Purpose |
|---|---|
| `taskboard-flow-contacts.json` | Legacy contacts with inbox off |
| `aitl.db` and WAL/SHM companions | Contacts, inbox bodies, identities, overrides |
| `spawned-sessions.json` | Append-only JSONL spawn journal despite extension |
| `mc-runtime-state.json` | Optional Mission Control state |
| `aitl-mcp-key.json`, `mc-runtime-key.json` | Separate owner-supplied credentials |

SQLite imports legacy contacts idempotently and renames the source to `*.json.migrated`. Schema v3 retains workspace/identity metadata. Back up consistently, including WAL handling, before upgrading; preserve the legacy source and journals. Old releases do not understand the new schema: automatic downgrade/reverse migration is unsupported.

Disabling/removing the plugin does not erase data, credentials, journals, or DSH sessions. Drain replies and dispose unused sessions through supported controls before removal. Manual data cleanup is the owner's responsibility; never delete an open database.

### Optional Mission Control bridge

Enable `mc.enabled` only with an available server, private `mc.apiKeyFile`, explicit `mc.projects` workspace mappings/first-message template paths, and a working `mc.newSession` script. The default script is `~/.dsh/new-session.mjs`; **it is not bundled**.

The bridge uses outbound HTTP/SSE, dispatches assigned tasks, forwards comments, reconciles state, applies seat/dependency limits, and closes sessions for terminal tasks. Assigned agent provider/model choices take precedence over optional `mc.provider`/`mc.model` defaults; missing/unavailable pairs refuse dispatch. Validation runs through the configured script. See `lib/mc-runtime.js` for configuration and `/api/agents-in-the-loop/mc-health` for status.

## Security and operational warnings

- **Host access:** DSH plugin code executes in-process with the host user's access, outside the workspace sandbox. A worker's permission does not sandbox the plugin.
- **Shared-key impersonation:** key holders can claim any configured identity header. Identity names are workspace routing, not independent authentication. There are no per-identity keys or rate limits.
- **Full control:** `allTools: true` can expose shell execution, files, plugin management, and task execution. A read-only hidden identity is not a blanket boundary around those tools.
- **Automatic tool exposure:** installing/enabling another DSH tool expands external access in `allTools` mode. Review new plugins, permissions, and side effects before loading them. Use `allTools: false` with explicit `mcp.tools` names for narrower exposure; this limits tools, not actions within a tool.
- **Orchestrator authority:** an external agent can delegate work, mutate shared task/session state, and access any exposed tool allowed by the host. Other clients using the same key can impersonate it. Use a dedicated profile, minimal presets/permissions, and a separate account or isolated environment when projects have different trust requirements.
- **Local APIs:** panel/config/contact/message/identity APIs use a loopback fence without the MCP bearer key. Loopback does not authenticate browsers or other local processes. Reverse proxies can defeat the address fence; do not publish these routes through a proxy. `allowNonLoopback: true` removes the MCP network restriction and needs a separately secured deployment.
- **Secrets and transport:** local HTTP is unencrypted. Do not transmit credentials over untrusted networks or include them in briefs, logs, screenshots, or issues. Protect key files and DSH provider credentials.
- **Sensitive storage:** inbox bodies/contact notes persist locally without plugin-provided encryption. Workspace access can expose files. Restrict file access and use appropriate disk protection.
- **Costs/lifecycle:** persistent workers can make billable calls. Seat caps are not spending limits. Monitor and dispose unused sessions.
- **Untrusted input:** incoming messages can contain prompt injection. Verify sender, scope, and user authorization before acting.
- **Delivery:** replies can duplicate or expire. Successful delivery/start does not prove completion; require and verify a report.

## Troubleshooting

| Symptom | Check |
|---|---|
| No tools after install | Root/feature switches, selected bundle, preset visibility; reload/reconnect |
| Inbox load error or non-JSON response | Host/client package match, SQLite enablement, localhost, route; this release returns structured `inbox_disabled` errors |
| Provisioning fails | Explicit installed preset, workspace, allowed permission, unique name, seat cap |
| Memory uses wrong workspace | Identity binding/header, native `memory_status`, schema cache, self-MCP import |
| Empty model/workspace selector | Catalog diagnostics; configure host registries and refresh |
| Spawn config rejected | Per-call choices from `aitl_catalog` replace retired settings |
| Reply missing | Contact/identity, inbox enablement, send result, capacity/retention; poll → peek → ack returned ID |
| Panel 403 over LAN | Use localhost; custom APIs require loopback |
| `taskboard_execute` absent | Separate taskboard version/registration and MCP exposure |
| Handoff missing from recall | Installed memory plugin/version; separate patch above |
| Config ignored | SQLite overrides, boot-only setting, reload requirement |

## Development and release checks

Clone the repository and use a supported Node version:

```sh
npm test
npm run release:check
npm pack --ignore-scripts
```

`release:check` verifies versions, disabled switches, restricted/loopback defaults, and allowed archive paths. `prepublishOnly` runs tests and this check before normal source publication. Do not bypass it with `--ignore-scripts` when publishing. Packing above does not install or publish anything.

The archive contains runtime JavaScript (including the prebuilt client), metadata, bundle defaults, README, changelog, MIT license, and agent skill. Tests, compatibility patches, release scripts, Git metadata, credentials, databases, journals, and deployment overlays are excluded. No consumer build step is needed. Edits to `lib/client.js` must update its shipped `lib/client.bundled.js` counterpart.

Before publishing, review the diff/archive, run checks, verify the target DSH version, and test selected features in a disposable profile with your own registries. The maintainer decides when to publish. Unit tests do not establish compatibility with every provider, MC deployment, or DSH version.

This candidate passed **114 plugin tests** and independent Sol code review. Live external/native checks verified workspace memory, dynamic spawning, native taskboard execution, contact callbacks, and inbox poll/read/ack. The separate memory patch passed three focused checks. Rendered browser QA was not completed; UI verification covers source-level selector/contact regressions. The optional MC bridge was not tested end to end in this release run.

Report bugs through [GitHub Issues](https://github.com/markelayan/agents-in-the-loop/issues) with plugin/DSH/Node versions, enabled features, reproduction steps, and sanitized diagnostics. Remove credentials, private paths, and message bodies. Contributions should include focused regressions and documentation for changed behavior.

## License

[MIT](LICENSE).
