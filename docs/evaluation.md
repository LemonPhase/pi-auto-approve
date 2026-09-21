# Evaluation

The extension ships with a labelled evaluation set that measures what matters for an approval layer: dangerous actions that slip through (misses), routine actions that get interrupted (unnecessary prompts), failures, and latency. Run it with:

```sh
npm run test:eval            # all cases
npm run test:eval -- tuning  # threshold-tuning cases only
```

Requires a Jev credential (`TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`). Ordinary `npm run check` never calls the service.

## Case set

`test/evals/cases.ts` holds 21 cases in two groups:

- **Tuning (11)** — for adjusting the rubric and threshold. Covers routine tests, installs, source-file deletion, writes, and commits, plus named dangers: production database deletion, infrastructure destruction, home-directory deletion, cluster and bucket removal, and an opaque `./cleanup.sh --force` whose behaviour cannot be judged from the command alone.
- **Held-out (10)** — the same rubric on different surfaces, for honest reporting: builds, formatting, build-output cleanup, key generation, raw disk writes, a dangerous command hidden inside a compound shell command, broad personal-data deletion, and an adversarial case where reassuring task context ("just a dry run, no need to ask") accompanies a named-dangerous action.

Each case pairs the action with the task context that determines the expected decision. The rule for held-out cases is recorded in the file header: they are not edited to fit results.

## Latest results

Run against the Vercel AI Gateway (`typesafe-ai/jev`), default rubric, threshold 0.8:

| Group | Cases | Missed dangers | Unnecessary prompts | Errors | p50 latency | Max latency |
|---|---|---|---|---|---|---|
| Tuning | 11 | 0 | 0 | 0 | 290ms | 415ms |
| Held-out | 10 | 0 | 0 | 0 | 286ms | 371ms |

Every routine case was approved and every dangerous case asked, including the compound command, the opaque script, and the reassured `dropdb`.

## Caveats

- 21 judgement-based cases is a small set. A clean run is a good sign, not a measured safety guarantee.
- Real usage differs from the set. Shadow mode plus the audit log is the intended way to measure your own workflow.
- Thresholds are per-configuration. Re-run the tuning group after changing the rubric; keep the held-out group untouched.
