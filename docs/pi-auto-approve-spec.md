# Pi Auto Approve: A Configurable Safety Net for Pi

Status: implementation specification  
Target: Pi coding-agent extension, Linux/WSL, Bash  
Package name: `pi-auto-approve`  
Release: `0.1.0`

## 1. Purpose

Pi Auto Approve adds an optional approval layer to a workflow where agent tool calls would otherwise run without approval. Its first job is to provide the framework: intercept an action, apply the user's rules, ask Jev for a recommendation when appropriate, and either continue or ask the user.

This is a best-effort safety net. It should help catch serious mistakes without routinely interrupting ordinary development. It does not need to prove that a command is safe before allowing it.

The motivating workflow is a user who normally runs in unrestricted mode and is comfortable with the agent editing files, deleting obsolete code, running tests, and installing dependencies, but would appreciate a warning before something like deleting a production database.

Different users will draw that line differently. Configuration, rather than a fixed definition of acceptable risk, is central to the design.

## 2. Goals and limits

The extension should:

- Intercept supported Pi tool calls before execution.
- Support simple user-defined allow, ask, and block rules.
- Send unmatched supported calls to Jev for an `approve` or `ask` recommendation.
- Let users describe their workflow and the actions they want flagged.
- Offer one-time approval prompts.
- Provide shadow mode to observe recommendations without changing execution.
- Record decisions so users can assess missed dangers and unnecessary prompts.
- Make inactive protection and errors visible without unexpectedly stopping work.

It is acceptable for every supported call to go through Jev when no rule matches. A sophisticated command analyser is not a prerequisite.

This extension is not a sandbox or a security boundary. It can miss dangerous actions. Users may disable it, override global settings in a project, or continue when classification fails.

Jev judges the information it receives. `./cleanup.sh` does not reveal the script's contents; a database command may not reveal whether its connection points to production. Jev can still offer a useful prediction, but approval is not proof of safety.

Limits:

- Do not promise protection against malicious repositories, other extensions, or deliberate bypasses.
- Do not promise coverage of execution paths outside supported Pi tool calls.
- Do not automatically inspect arbitrary scripts or resolve database connections.
- Do not impose immutable restrictions on workspace boundaries, network access, package scripts, deletion, or privilege changes.
- Do not assume every deletion or overwrite deserves a prompt.
- Do not treat Git tracking as proof that current file contents are recoverable.
- Defer shell AST analysis, session-wide approvals, decision caching, and sandbox integration.

## 3. Default behaviour

Ship with:

- `mode: shadow`.
- Empty allow, ask, and block lists.
- Jev enabled for unmatched supported calls.
- An editable rubric focused on major destructive mistakes.
- `classifier.on_error: allow`.
- `approval.non_interactive: allow`.

Shadow mode records recommendations and executes the original action without prompting or blocking. Users select `enforce` to make recommendations and rules affect execution. Disabled mode delegates without classification.

Permissive fallback defaults preserve the existing workflow. Users can choose stricter handling. Show the active mode and fallbacks at startup and through `/guard-status`.

## 4. Decision flow

Keep recommendations separate from actual outcomes.

```ts
type Recommendation = "approve" | "ask" | "block";

interface PolicyDecision {
  recommendation: Recommendation;
  source: "rule" | "jev" | "fallback";
  reason: string;
  ruleIds?: string[];
}
```

Jev may return only `approve` or `ask`. Blocking comes from an explicit local rule or configured fallback, never directly from Jev.

For each supported call:

1. Capture its name, arguments, actual working directory, and available user context.
2. Capture the effective configuration for this evaluation.
3. If disabled or inactive because configuration failed, delegate unchanged.
4. Match local rules: matching block rules win over ask rules, which win over allow rules.
5. If no rule matches and Jev is enabled, classify the action.
6. If Jev is disabled, use `unmatched: allow|ask|block`.
7. On classifier failure, use `classifier.on_error: allow|ask|block`.
8. In shadow mode, record the proposed decision and delegate unchanged.
9. In enforce mode, approve, prompt, or block.
10. Record actual handling and execution outcome where available.

An allow rule bypasses Jev unless an ask or block rule also matches. A block rule stops execution in enforce mode without an override prompt; users can change the rule or mode. An ask rule offers a one-time choice.

Distinguish execution, user rejection, policy blocking, cancellation, and shadow execution in outcome records. Agent cancellation must never be converted into approval by a permissive error fallback.

## 5. Configuration

### Locations and merging

- User: `~/.pi/agent/pi-auto-approve.yaml`
- Project: `<project>/.pi/auto-approve.yaml`

Apply defaults, then user settings, then project settings. Merge objects by key. Later scalar values override earlier ones. Arrays replace rather than append; empty rule arrays clear inherited lists. Missing values inherit. Reject unsupported null values.

The project directory is Pi's session working directory, resolved to an absolute path. Do not search parent directories. This locates configuration; it is not an enforced filesystem boundary.

Project settings may relax restrictions, replace rules, enable shadow mode, or disable the extension. This is intentional. Status must identify loaded files and effective settings.

Users can set `load_project_config: false` in user configuration. This field is user-only and cannot be overridden by a project.

### Example configuration

```yaml
version: 1
mode: shadow # shadow | enforce | disabled
load_project_config: true # user configuration only
unmatched: allow # when classification is disabled

rules:
  block: []
  ask: []
  allow: []

classifier:
  enabled: true
  model: jev-1.13.0
  timeout_ms: 1500
  on_error: allow # allow | ask | block
  approve_probability_min: 0.8
  instructions: |
    The user normally lets their coding agent work without approval.
    Routine edits, overwrites, source-file deletion, tests, builds,
    and dependency installation are generally acceptable.
    Ask before actions likely to cause major irreversible loss,
    especially deletion of production databases, destruction of
    important external resources, or broad deletion of personal data.
    Judge the available evidence. An unfamiliar command alone is
    not a reason to ask. Missing context is not proof of safety.
  input:
    include_user_context: true
    max_user_context_chars: 8000
    max_action_chars: 12000

approval:
  non_interactive: allow # allow | block
  max_pending_prompts: 20

audit:
  enabled: true
  path: "~/.pi/agent/logs/pi-auto-approve.jsonl"
  include_redacted_action: false
```

The threshold is a tunable starting point, not a measured safety guarantee. The rubric and examples should remain editable plain text.

### Invalid configuration

Validate types, enum values, rule matchers, numeric bounds, and unknown keys. Missing optional files are normal; unreadable files, malformed YAML, unsupported versions, and invalid values are errors.

If either loaded file is invalid, mark the approver inactive, warn with the file and error, and delegate unchanged. State clearly that actions will run without approval checks. Do not silently apply a partial configuration.

Use the same behaviour on explicit reload. Load at startup and through `/guard-reload`; configuration files are not watched automatically. Valid configuration restores normal operation.

## 6. Simple local rules

Start with exact and literal substring matching. Do not build a shell policy language or automatic rule generator.

```yaml
rules:
  block:
    - id: block-known-prod-drop
      tool: bash
      command_contains: "dropdb production"
      reason: "Do not drop this production database."
  ask:
    - id: review-terraform-destroy
      tool: bash
      command_contains: "terraform destroy"
      reason: "Confirm infrastructure destruction."
  allow:
    - id: allow-git-status
      tool: bash
      command_exact: "git status --short"
      reason: "Routine status check."
```

Semantics:

- Require `id`, `tool`, and `reason`.
- Match an exact tool name.
- Accept at most one of `command_exact`, `command_contains`, or `path_exact`.
- A rule without an argument matcher matches that tool generally.
- Command matchers apply to the Bash `command` string.
- Path matching applies to the `path` string on supported filesystem tools.
- Match literally and case-sensitively without whitespace rewriting, shell expansion, or path normalization.
- Reject incompatible matchers and empty substring matchers.
- Collect matches and apply block > ask > allow precedence.

Document that equivalent commands can evade substring rules and harmless text can trigger them. These rules express user preferences; they are not robust analysis of program behaviour. Broad allow rules bypass useful classification.

## 7. Pi integration

Install as a user-level Pi extension. Inspect the installed version and local extension documentation before choosing APIs. The version inspected during planning was 0.85.1.

Use same-name tool wrappers and exported built-in tool factories where appropriate. Supported tools are `bash`, `read`, `write`, `edit`, `find`, `grep`, and `ls`.

The compatibility spike must establish how to preserve active tool settings. Do not assume an API exists to snapshot original implementations.

Wrappers must:

- Evaluate the arguments passed to the delegate.
- Delegate exactly once after approval, never after rejection or blocking.
- Preserve parameters, results, prompt metadata, rendering, streaming, cancellation, and errors.
- Use the actual working directory and execution backend.
- Avoid rewriting the action to make it safer.
- Avoid duplicate evaluation through both wrappers and event handlers.

Use a `tool_call` handler for additional tools only if the spike establishes a compatible approach. Unknown/custom tools may pass through, with coverage limitations shown in status and documentation. Observing a call does not imply enforcing its execution.

Other extensions, custom backends, and directly user-issued commands are not guaranteed to be covered. Do not replace remote execution with local execution as a side effect of installing the extension.

### User context

Use user-authored text from the current session branch: the latest user message plus preceding user messages within the size limit, in chronological order. Exclude tool results and assistant reasoning by default.

Mark missing or truncated context. Preserve preceding task context for short replies such as “continue” when it fits. Missing context does not automatically prevent classification; the user's rubric guides the decision.

### Concurrency

Allow concurrent classification but serialize prompts by tool call ID. Cancellation removes queued prompts and cancels their calls. If the UI is unavailable or the queue is full, apply the non-interactive setting and log why.

Use one configuration snapshot per evaluation. Reloads and mode changes affect subsequent evaluations; they do not retroactively approve queued prompts.

## 8. Jev integration

Keep the provider interface independent of Pi:

```ts
interface ApprovalClassifier {
  classify(input: ClassificationInput, signal?: AbortSignal): Promise<{
    recommendation: "approve" | "ask";
    approveProbability: number;
    model: string;
    latencyMs: number;
  }>;
}
```

Use `POST https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY`, pinning `jev-1.13.0`.

Start with one typed `choice` question offering `approve` and `ask`. Put the user's rubric in question instructions and action/context in `state`.

Approve only when the returned choice is approve and its probability meets the configured minimum. Otherwise ask. Validate required fields, choices, finite probabilities in range, and model metadata. Invalid responses use the configured error fallback.

Use a total request timeout that bounds every attempt. Transient failures (rate limits, provider errors, network failures) are retried with linear backoff, up to three attempts in total, within that budget. Missing credentials, authorization failures, and malformed responses are not retried. Record model version and latency. Treat errors as errors, not successful classifier answers.

Do not require multiple separate risk scores. Add questions only when evaluation shows value. If the provider does not give an explanation, say “Jev recommended asking” rather than inventing one.

### Input and privacy

Explain that action information and optional user context are sent to an external service.

- Bash input includes the command, working directory, and relevant tool options.
- Filesystem input includes operation, path, and content sizes where applicable.
- Omit file bodies and edit replacement text.
- Do not automatically read scripts or referenced files.
- Do not send environment values or provider credentials.
- Redact recognizable credentials, authorization headers, and tokens from commands and context.
- Mark omitted or redacted information.
- If action input exceeds the size limit, use the error fallback rather than classify only a prefix.
- Allow users to disable Jev or user-context transmission.

Redaction is best effort. Commands, filenames, and messages can contain private information that cannot reliably be recognized as a secret.

Omitting content limits detection. For example, classifying a script write by its path and size cannot reveal everything that script would do. This is an accepted limitation.

## 9. Approval UI and commands

An enforce-mode prompt shows:

- Tool name and working directory.
- Exact Bash command or relevant filesystem arguments.
- Rule reason or Jev recommendation and probability.
- Missing context or fallback reason, when relevant.
- `Allow once` and `Reject`.

Make long commands inspectable in full and escape control characters that could hide their meaning. For edits/writes, show path and change size with a way to inspect the payload locally; do not send it to Jev by default.

Closing the prompt means rejection. Return a clear blocked tool result so the agent can continue. Defer reusable session permissions.

Provide:

```text
/guard-status
/guard-mode shadow|enforce|disabled
/guard-reload
/guard-last [count]
```

Mode commands affect the current session without editing files. Reload clears the temporary override and uses file settings. A mode command cannot activate invalid configuration.

Warn visibly about missing credentials and inactive protection. Avoid repeating the same outage warning on every call. Status reports mode, configuration sources, errors, fallback choices, classifier availability, and tool coverage.

## 10. Logging and evaluation

Use append-only JSONL with user-only permissions. One file per session: `audit.path` is the base name and the session id (sanitized, `unknown` when absent) is inserted before the extension, for example `pi-auto-approve-<sessionId>.jsonl`. When a session starts writing, matching session logs older than 30 days in that directory are deleted. Record:

- Timestamp, session ID, tool call ID, tool name, and action hash.
- Mode and effective-configuration fingerprint.
- Matched rule IDs or classifier result.
- Model, probability, latency, and error category.
- Proposed decision and actual handling, including permissive fallbacks.
- User response and execution outcome where available.

Do not log environment values, provider credentials, file bodies, or raw provider responses. Optional redacted action summaries are off by default. A hash correlates events; it cannot reconstruct the action.

Logging is optional and best effort, not tamper-proof. Logging failure warns but does not stop normal handling.

Build evaluation examples covering:

- Ordinary edits, deletion, tests, builds, and installation.
- Production database deletion and destructive infrastructure changes.
- Broad filesystem deletion.
- Unclear script behaviour or destinations.
- Dangerous actions inside compound shell commands.
- Misleading instructions in commands, filenames, or task context.

Each example includes the rubric and context that determine the expected decision. Measure missed dangerous actions, unnecessary prompts, failures, and latency. Keep threshold-tuning examples separate from held-out examples.

User approval is not a safety label. Shadow mode measures proposed behaviour without preventing execution. Zero misses is not a requirement, and no measured safety guarantee is claimed.

## 11. Implementation structure

Start small:

```text
src/
  index.ts        # Pi registration, wrappers, commands
  config.ts       # Loading, validation, merging
  policy.ts       # Rules, classification routing, fallbacks
  classifier.ts   # Provider interface and Jev client
  approval.ts     # Prompt queue and one-time decisions
  audit.ts        # Redaction and records
  types.ts        # Actions, recommendations, outcomes
test/
  unit/
  integration/
  fixtures/
  evals/
```

Keep policy and classification independent of Pi imports. Inject classifier and approval dependencies for tests. Split files as complexity warrants.

Do not add a shell parser, filesystem capability system, cache, or separately published policy package unless usage shows a need.

## 12. Milestones

### Milestone 0: Compatibility spike

- Inspect installed Pi APIs and documentation.
- Wrap and delegate Bash without changing behaviour.
- Verify arguments, working directory, output, streaming, cancellation, and errors.
- Check interactive/non-interactive execution and custom-backend compatibility.
- Document the chosen approach and coverage limitations.

Exit: a minimal extension observes and delegates Bash correctly. Do not add Jev or enforcement yet.

### Milestone 1: Approval framework

- Implement configuration and project overrides.
- Add local rules and supported native wrappers.
- Add modes, one-time prompts, cancellation, and non-interactive handling.
- Add status, reload, mode controls, and logs.
- Exercise classifier routing using a fake classifier.

Exit: decisions work locally, including invalid-config pass-through and explicit local blocks.

### Milestone 2: Jev

- Implement the choice request, payload preparation, and response validation.
- Add editable rubric and threshold.
- Implement timeout and configured fallback.
- Document transmission and redaction limits.

Exit: unmatched supported calls reach Jev in shadow/enforce mode; failures follow configuration.

### Milestone 3: Real use and evaluation

- Run representative sessions in shadow mode.
- Build labelled examples of routine work and serious mistakes.
- Measure misses, unnecessary prompts, errors, and latency.
- Try enforce mode with the intended permissive workflow.
- Adjust the rubric based on evidence and document weaknesses.

Exit: the framework is usable and there is an honest report of where Jev helps and where it misses.

## 13. Acceptance checks

Before release, verify:

1. Supported wrappers preserve behaviour and delegate at most once.
2. Rule matching and precedence match the documentation.
3. Project settings can override mode and replace rule lists.
4. Invalid configuration warns, marks the approver inactive, and preserves execution.
5. Shadow and disabled modes do not add prompts or blocks.
6. Enforce mode honours rules, recommendations, and user responses.
7. Missing credentials, malformed responses, and timeouts follow the configured fallback.
8. Missing UI and full prompt queues use non-interactive handling.
9. Cancellation never becomes approval or delayed execution.
10. Concurrent prompts stay associated with the correct calls.
11. File bodies and provider credentials are excluded from requests and logs.
12. Status exposes protection state, fallback choices, and coverage.
13. Evaluation reports include missed dangers and unnecessary prompts.

Use mocked provider tests for repeatable behaviour. Run live model evaluations separately; ordinary tests should not depend on a network model's answer.

## 14. Backlog

Potential additions include richer matching, shell parsing, optional script inspection, session permissions, improved task-context selection, recoverable file changes, and sandboxed execution. Add these when usage shows a need.

## 15. References

- Pi extension documentation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi tool-override example: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tool-override.ts>
- TypeSafe API reference: <https://docs.typesafe.ai/api>
- TypeSafe models: <https://docs.typesafe.ai/models>

Use installed Pi documentation as the implementation reference; upstream APIs may differ.
