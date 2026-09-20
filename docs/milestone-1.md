# Milestone 1 — Configurable approval framework

Implemented configuration validation and merging, literal allow/ask/block rules, shadow/enforce/disabled modes, one-time prompts, cancellation, prompt serialization, non-interactive fallbacks, audit records, and the four guard commands. Seven standard local Pi tools are wrapped. Jev remains Milestone 2; an injected fake classifier exercises that route in tests.

## Verification

- `npm run check`: TypeScript checks and automated tests of configuration, policy, fake classification, UI, queues, cancellation, logs, Pi extension loading, and real native tools.
- Installed the local package using `pi install /home/jack_zhang/Programs/pi-auto-approve`.
- Spawned Pi 0.86.1 in RPC mode using the existing configured provider and credentials. Verified installed-package loading, enforced blocking, one-time approval, rejection, shadow execution, invalid-config pass-through, and recovery on reload.
- Spawned Pi in print mode and verified that an ask decision with `non_interactive: block` prevents execution.
- Live checks used harmless marker files in temporary directories and removed those fixtures afterwards. No global approval configuration was changed, no credentials were printed, and no Jev calls were made.

The local package is registered in the user's Pi settings. New sessions use the default shadow mode unless configuration overrides it. Existing sessions need Pi's `/reload` to load the extension; `/guard-reload` reloads only approval configuration.

## Limits and next step

RPC prompt handling was verified with a real headless client. Interactive terminal layout has automated formatting/pagination coverage, but has not been manually visually reviewed.

Custom tool overrides are skipped when identifiable; arbitrary SDK execution backends are not a supported integration. Other extensions can replace tools later. Literal rules and redaction are best effort.

Next is Milestone 2: implement the real Jev client using the tested classifier interface. Local rules already work independently by setting `classifier.enabled: false`.
