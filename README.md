# Pi Auto Approve

A configurable, best-effort safety net for Pi. It checks tool calls against your rules and can ask before allowing an action.

Milestone 1 is implemented: configuration, local rules, approval prompts, modes, logging, and built-in tool wrappers. **Jev integration is next.** There are no external classification requests yet.

## Install

Requires Node.js 22.19+ and Pi 0.86.1.

```sh
npm install
npm run check
pi install /absolute/path/to/pi-auto-approve
```

Start a new Pi session, or use Pi's `/reload` in an existing session. Then run `/guard-status`.

For a single session without installing:

```sh
pi -e ./src/index.ts
```

Do not load the same extension both through an installed package and an explicit path.

## Configure

User settings: `~/.pi/agent/pi-auto-approve.yaml` (or the agent directory selected through `PI_CODING_AGENT_DIR`).

Project settings: `.pi/auto-approve.yaml` in Pi's session working directory. Parent directories are not searched.

Start from [the example](examples/pi-auto-approve.yaml). A minimal active configuration is:

```yaml
version: 1
mode: enforce
classifier:
  enabled: false
unmatched: allow
rules:
  ask:
    - id: infrastructure-destruction
      tool: bash
      command_contains: terraform destroy
      reason: Confirm infrastructure destruction.
  block:
    - id: known-prod-database
      tool: bash
      command_contains: dropdb production
      reason: Do not delete this production database.
```

Rules match literal strings, not shell behaviour. Different spelling or quoting can evade a substring rule, and harmless text can also match. Use these as workflow preferences, not guarantees.

- Matching block rules win over ask rules, which win over allow rules.
- Allow rules execute without classification.
- Ask rules offer `Allow once` and `Reject`, with full argument inspection.
- Block rules stop the call; change the configuration or mode to allow it.
- Rules accept `command_exact` or `command_contains` for Bash, and `path_exact` for filesystem tools. Omitting the matcher covers the named tool.
- Project settings override user settings. Objects merge by key; arrays replace earlier arrays. An empty array clears inherited rules.
- Project settings may disable protection. Set user-only `load_project_config: false` to ignore them.
- Invalid configuration produces a warning and turns approval checks off until a valid reload.

By default, mode is `shadow`: decisions are recorded but calls run normally. `enforce` applies decisions; `disabled` skips policy evaluation and audit records.

The spec defaults to enabling the classifier. Until Milestone 2, the extension visibly reports it as unavailable and uses `classifier.on_error` (default `allow`). Set `classifier.enabled: false` to use local rules with `unmatched` handling instead.

In sessions without an approval UI, `approval.non_interactive` controls ask decisions: `allow` by default, or `block`. RPC sessions have a UI protocol and receive approval requests; their client must answer them.

## Commands

- `/guard-status`: show mode, configuration, fallback choices, and tool coverage.
- `/guard-mode shadow|enforce|disabled`: change this session's mode without editing files.
- `/guard-reload`: reload configuration and clear the session mode override.
- `/guard-last [1..100]`: show recent in-memory audit records.

File changes take effect on startup or explicit reload. Pending decisions retain their original settings. Cancelling a call cancels its approval and never authorizes delayed execution.

## Tool compatibility

The extension wraps standard local `bash`, `read`, `write`, `edit`, `find`, `grep`, and `ls` tools. It preserves the active tool selection, Pi's configured local shell path/prefix, image resizing, rendering, metadata, streaming, and cancellation.

Existing extension/SDK custom tools are left unchanged when Pi identifies them as custom. Detectable SDK base-tool substitutions are also skipped. Unsupported tools appear in status. Wrapping an existing delegate is supported internally, but automatically recovering arbitrary custom execution backends is outside this release. Embedded SDK users with custom base tools should not assume coverage; normal local Pi CLI sessions are the supported setup.

Other extensions can replace tools later. Direct user shell commands and tools outside the supported set are not covered. This extension is not a sandbox.

## Logs

Default: `~/.pi/agent/logs/pi-auto-approve.jsonl`, with user-only file permissions.

Records contain decision/outcome metadata, rule IDs, configuration and action hashes, and user responses. File bodies and raw provider responses are not logged. Optional redacted action summaries are off by default; redaction is best effort.

Set `audit.enabled: false` to disable recording. Logging failures warn and let normal handling continue.

## Test

```sh
npm run check
```

The automated suite covers configuration validation/merging, rules, fake classifier routing, thresholds and timeouts, prompt queues, cancellation, argument inspection, audit privacy, Pi loading, and real native tool delegation.

After installing, run the optional live checks:

```sh
npm run test:live
```

These spawn headless Pi using your existing credentials and may incur model costs. They use harmless marker commands in disposable temporary directories, exercise RPC approval/rejection and print-mode handling, and remove their fixtures afterwards. They do not edit your global approval policy or call Jev.

See [the specification](pi-auto-approve-spec.md) for the full plan.
