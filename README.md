# Pi Auto Approve

A configurable, best-effort approval layer for Pi. It checks every supported tool call against your rules, asks [Jev](https://docs.typesafe.ai) — a probabilistic decision model — for a recommendation on everything else, and prompts you before risky actions run. It ships in shadow mode: recommendations are recorded but nothing is blocked until you switch to enforce.

It is not a sandbox or a security boundary. It catches serious mistakes like deleting a production database, not deliberate bypasses.

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

## Quick start

1. `/guard-login` — paste a Jev API key (Vercel AI Gateway or direct TypeSafe). Takes effect immediately.
2. Use Pi normally in the default **shadow** mode for a while.
3. `/guard-last 50` to review what would have been approved or asked.
4. `/guard-mode enforce` (session only) or `mode: enforce` in the config file when the recommendations look right.

## How decisions are made

For each supported tool call, in order:

1. **Local rules** match first: block wins over ask, which wins over allow.
2. **No rule matched** and the classifier is enabled: the call is sent to Jev, which answers `approve` or `ask` with a probability. `approve` counts only at or above `approve_probability_min` (default 0.8); anything else asks. Jev never blocks.
3. **Classifier disabled**: the `unmatched` setting applies.
4. **Classifier errors** (missing key, HTTP failure, malformed answer, timeout, oversized input): the `classifier.on_error` setting applies. An error never becomes an approval of a prompt you did not configure.
5. **Shadow mode** records the decision and runs the call. **Enforce** applies it. **Disabled** skips evaluation entirely.

Cancelling a call cancels its approval and never authorizes delayed execution.

An unanswered approval prompt expires after `approval.prompt_timeout_ms` (default 600000 ms, ten minutes). One deadline covers the whole request, including payload inspection; when it passes, the call falls back to `approval.non_interactive`.

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

- Rules accept `command_exact` or `command_contains` for Bash, and `path_exact` for filesystem tools. Omitting the matcher covers the named tool.
- Ask rules offer `Allow once` and `Reject`, with full argument inspection.
- Block rules stop the call; change the configuration or mode to allow it.
- Project settings override user settings. Objects merge by key; arrays replace earlier arrays. An empty array clears inherited rules.
- Project settings may disable protection. Set user-only `load_project_config: false` to ignore them.
- Invalid configuration produces a warning and turns approval checks off until a valid reload.

The editable `classifier.instructions` rubric (see the example config) tells Jev what routine work looks like for you and what counts as major irreversible loss. Tune it to your workflow; keep the threshold at 0.8 unless evaluation suggests otherwise.

## Credentials

The classifier needs an API key. Two options:

- **Vercel AI Gateway** (free tier): set `AI_GATEWAY_API_KEY`, leave `TYPESAFE_API_KEY` and `TYPESAFE_API_URL` unset. Calls route through `https://ai-gateway.vercel.sh/typesafe/v1/systemone` as model `typesafe-ai/jev` and appear in your Vercel usage. Note the gateway requires a credit card on file for your Vercel team before serving requests, including free ones.
- **Direct TypeSafe**: set `TYPESAFE_API_KEY`. Calls go to `https://api.typesafe.ai/v1/systemone` with the pinned model `jev-1.13.0`.

Or skip env vars: run `/guard-login` in a Pi session and paste a key. It takes effect immediately, is stored with user-only permissions (0600) in `~/.pi/agent/pi-auto-approve-auth.json`, and `/guard-logout` removes it. Shell-exported keys win over saved ones; `TYPESAFE_API_KEY` wins over `AI_GATEWAY_API_KEY`. `/guard-status` reports which credential is active.

`TYPESAFE_API_URL` overrides the endpoint (for example, a proxy or stub).

## Jev and privacy

Jev is an external service. When a call is classified, this extension sends it to the endpoint above.

Sent: the tool name, the redacted command or filesystem arguments (path and content sizes, never bodies), the working directory, the omission/truncation flags, your editable `classifier.instructions` rubric, and — when `classifier.input.include_user_context` is true — the latest user messages up to `max_user_context_chars`.

Never sent: file contents, edit replacement text, environment values, provider credentials, and raw local configuration.

Redaction covers recognizable credentials, authorization headers, tokens, URL userinfo, and query strings, and is best effort. Commands, filenames, and messages can contain private information that cannot be recognized as a secret. Omitting content also limits detection: classifying a script write by path and size cannot reveal what the script does.

To avoid external requests entirely, set `classifier.enabled: false` and use `unmatched`. To keep classification without sending user context, set `classifier.input.include_user_context: false`.

## Commands

- `/guard-status`: show mode, rules, credentials, fallbacks, and tool coverage.
- `/guard-mode shadow|enforce|disabled`: change this session's mode without editing files.
- `/guard-reload`: reload configuration and clear the session mode override.
- `/guard-last [1..100]`: show recent calls — one line per call with the decision, outcome, and the command or path.
- `/guard-login`: save a Jev API key (Vercel AI Gateway or direct TypeSafe) for this and future sessions.
- `/guard-logout`: remove saved Jev API keys from the session and saved settings.

In sessions without an approval UI, `approval.non_interactive` controls ask decisions: `allow` by default, or `block`. RPC sessions have a UI protocol and receive approval requests; their client must answer them.

File changes take effect on startup or explicit reload. Pending decisions retain their original settings.

## Tool compatibility

The extension wraps standard local `bash`, `read`, `write`, `edit`, `find`, `grep`, and `ls` tools. It preserves the active tool selection, Pi's configured local shell path/prefix, image resizing, rendering, metadata, streaming, and cancellation.

Existing extension/SDK custom tools are left unchanged when Pi identifies them as custom. Detectable SDK base-tool substitutions are also skipped; both show up under `skipped` in `/guard-status`. Other extensions can replace tools later. Direct user shell commands and tools outside the supported set are not covered.

## Logs

Default: `~/.pi/agent/logs/pi-auto-approve.jsonl`, with user-only file permissions.

Records contain decision/outcome metadata, rule IDs, configuration and action hashes, and user responses. File bodies and raw provider responses are not logged. Optional redacted action summaries are off by default; redaction is best effort.

Set `audit.enabled: false` to disable recording. Logging failures warn and let normal handling continue.

## Testing and evaluation

```sh
npm run check          # typecheck + full offline suite (36 tests, no network, no quota)
npm run test:live      # optional: real headless Pi sessions; Jev path via local stub only
npm run test:eval      # live Jev evaluation; needs a credential
npm run test:eval -- tuning
```

The offline suite covers configuration validation/merging, rules, classifier routing, thresholds and timeouts, prompt queues, cancellation, argument inspection, audit privacy, Pi loading, and real native tool delegation. Classifier results, approval choices, and model responses are hardcoded test doubles; no Pi subprocess, provider contact, or quota use.

`test:eval` runs the labelled evaluation set (tuning and held-out groups) and reports missed dangerous actions, unnecessary prompts, errors, and latency. Current results: [docs/evaluation.md](docs/evaluation.md).

See [the specification](docs/pi-auto-approve-spec.md) for the design and its rationale.
