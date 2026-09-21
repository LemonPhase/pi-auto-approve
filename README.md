# Pi Auto Approve

A configurable, best-effort safety net for Pi. It checks tool calls against your rules and can ask before allowing an action.

Milestones 1 and 2 are implemented: configuration, local rules, approval prompts, modes, logging, built-in tool wrappers, and the [Jev](https://docs.typesafe.ai) classifier. Milestone 3 (evaluation) ships its harness and offline checks; the live measurement needs `TYPESAFE_API_KEY`.

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

The classifier is enabled by default. Unmatched supported calls are sent to Jev unless a rule matches. Local rules work on their own with `classifier.enabled: false`.

## Jev and privacy

Jev is an external service. When a call is classified, this extension sends it to `POST https://api.typesafe.ai/v1/systemone`, or to the Vercel AI Gateway TypeSafe endpoint when `AI_GATEWAY_API_KEY` is set instead of `TYPESAFE_API_KEY`.

Free option: Vercel currently lists Jev as free through AI Gateway. Create a key, then set only `AI_GATEWAY_API_KEY` (leave `TYPESAFE_API_KEY` unset and `TYPESAFE_API_URL` unset) and the client routes to `https://ai-gateway.vercel.sh/typesafe/v1/systemone` with model `typesafe-ai/jev`. Requests are billed through Vercel and appear in its usage logs alongside your other Gateway calls.

Sent: the tool name, the redacted command or filesystem arguments (path and content sizes, never bodies), the working directory, the omission/truncation flags, your editable `classifier.instructions` rubric, and — when `classifier.input.include_user_context` is true — the latest user messages up to `max_user_context_chars`.

Never sent: file contents, edit replacement text, environment values, provider credentials, and raw local configuration.

Redaction covers recognizable credentials, authorization headers, tokens, URL userinfo, and query strings, and is best effort. Commands, filenames, and messages can contain private information that cannot be recognized as a secret. Omitting content also limits detection: classifying a script write by path and size cannot reveal what the script does.

To avoid external requests entirely, set `classifier.enabled: false` and use `unmatched`. To keep classification without sending user context, set `classifier.input.include_user_context: false`.

```sh
export TYPESAFE_API_KEY=...      # direct Jev
# or: export AI_GATEWAY_API_KEY=...  # free via Vercel AI Gateway (no TYPESAFE_API_KEY needed)
```

Or skip env vars: run `/guard-login` in a Pi session and paste a key. It takes effect immediately, is stored with user-only permissions (0600) in `~/.pi/agent/pi-auto-approve-auth.json`, and `/guard-logout` removes it. Shell-exported keys still win on the next start; `/guard-status` reports which credential is active.

Missing credentials, HTTP errors, malformed answers, oversized input, and timeouts follow `classifier.on_error` and never become an approval. `TYPESAFE_API_URL` overrides the endpoint (for example, a gateway); leave it unset to use Jev directly. `/guard-status` reports classifier availability and the active fallback.

In sessions without an approval UI, `approval.non_interactive` controls ask decisions: `allow` by default, or `block`. RPC sessions have a UI protocol and receive approval requests; their client must answer them.

## Commands

- `/guard-status`: show mode, configuration, fallback choices, and tool coverage.
- `/guard-mode shadow|enforce|disabled`: change this session's mode without editing files.
- `/guard-reload`: reload configuration and clear the session mode override.
- `/guard-last [1..100]`: show recent in-memory audit records.
- `/guard-login`: save a Jev API key (Vercel AI Gateway or direct TypeSafe) for this and future sessions.
- `/guard-logout`: remove saved Jev API keys from the session and saved settings.

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
# or, just the no-network tests:
npm run test:local
```

The automated suite covers configuration validation/merging, rules, fake classifier routing, thresholds and timeouts, prompt queues, cancellation, argument inspection, audit privacy, Pi loading, and real native tool delegation.

These tests do not start Pi as a subprocess, contact a model provider, use your credentials, or consume model quota. They load the installed Pi extension APIs locally and call the wrapped tools with fixed inputs. Classifier results, approval choices, and model responses are hardcoded test doubles.

After installing, run the optional live checks:

```sh
npm run test:live
```

These spawn headless Pi using your existing credentials and may incur model costs. They are optional and only verify the installed package through a real Pi session. They use harmless marker commands in disposable temporary directories, exercise RPC approval/rejection, print-mode handling, and the full Jev request/response path against a local stub, and remove their fixtures afterwards. They do not edit your global approval policy, and they never call the real Jev service.

Measure Jev itself with the labelled evaluation set:

```sh
npm run test:eval            # all cases, needs TYPESAFE_API_KEY
npm run test:eval -- tuning  # threshold-tuning cases only
```

This reports missed dangerous actions, unnecessary prompts, errors, and latency for the tuning and held-out groups. It consumes Jev quota. Ordinary `npm run check` never calls Jev.

See [the specification](pi-auto-approve-spec.md) for the full plan.
