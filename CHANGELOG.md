# Changelog

The previous public npm release was `1.6.0`. Versions
`1.7.0` through `1.11.1` were internal development milestones consolidated
into `2.0.0`. Full development records remain in Git history.

## v2.0.0 (2026-10-10)

### Upgrade requirements
- Node requires `^22.13.0 || >=23.4.0` for built-in SQLite without a flag.
  DSH `0.2.0-rc.2` is the verified target; historical compatibility claims
  are removed from the current manifest.
- All capability switches ship disabled. Review profile overrides explicitly.
- Worker provider/model/preset/permission selections are required per
  `spawn_session` call. Use `aitl_catalog` for valid IDs and reconnect clients
  after the schema update.
- SQLite schema v3 holds contacts, inboxes, identities, and overrides.
  Back up before upgrade; automatic downgrade is unsupported.

### Added
- Authenticated streamable-HTTP MCP and external poll/read/ack inboxes.
- Workspace-backed identities with owner provisioning, re-provisioning,
  disposal, and lazy session resume.
- Persistent spawning with dynamic provider/model/workspace/effort choices.
- Web catalog selectors, identity controls, lifecycle forms, and diagnostics
  for unavailable registry selections.
- Optional Mission Control bridge, requiring separate configuration.

### Fixed
- Native worker contact IDs, legacy MCP workspace context, callback routing,
  disabled inbox JSON errors, runtime identity initialization, contact editing,
  and persisted workspace metadata.
- Startup and MCP versions now come from package metadata.

### Release preparation
- Rewritten README covers installation, upgrades, configuration, dynamic tools,
  memory, replies, migration, troubleshooting, and security. Removed stale
  Node 20/no-database/no-UI guidance.
- Described DSH-centered external orchestration, optional third-party MC,
  integration dependencies, supported-authentication/subscription boundaries,
  and the security implications of automatic native-tool exposure.
- Separated taskboard Execute and auto-memory patches from this package;
  documented the self-MCP import hazard.
- Added archive/default checks and a prepublication test/check hook.
- Plugin suite: 114/114 tests passed. Live workspace, worker,
  callback, inbox, and memory checks passed. Archive/default checks passed:
  17 intended files, no bundled dependencies,
  and all capability switches disabled. Independent Sol review passed.
- Rendered UI QA and end-to-end Mission Control remain uncompleted and are
  disclosed in the README.

## v1.6.0 (2026-10-03)

- Simplified direct delivery to one path per send: idle wake uses steer/followup;
  busy targets or sends with wake disabled use a visible notice.
- Added per-message truncation notes and delivery result fields.
- Declared DSH `0.2.0-rc.2` compatibility for that release.

## v1.5.1 (2026-09-28)

- Added the exact DSH release compatibility matrix required by the DSH Store.
- Documented local contacts persistence and the loopback HTTP trust boundary.

## v1.4.2 (2026-09-18)

- Required registered contact names for `session_message` targets.
- Rejected raw session-ID targeting to avoid stale IDs and directory bypass.

## v1.4.1 (2026-09-18)

- First npm publication under `dsh-agents-in-the-loop`.
- Renamed the composition row to `dsh-agents-in-the-loop`; existing profiles
  needed the matching ID or reinstallation.
- Corrected repository issue links.

## Earlier development history

Before the npm publication, the project evolved from taskboard-flow into
agents-in-the-loop. Taskboard trigger/triage/executor logic was removed in
the `1.0.0` pivot; session messaging and named contacts remained. Subsequent
development added name-based targeting, self-registration, dead-session resume,
prompt-template sanitization, and the send-only external HTTP route. Later
internal `1.7.0`–`1.11.1` work introduced the optional MC bridge, spawning,
MCP, inboxes, workspace identities, and UI refinements now released together
as the `2.0.0` release. Historical behavior is not a current API
contract; use the README for current setup and tool semantics.
