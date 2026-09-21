# Milestone 3 — Real use and evaluation

Built the evaluation harness and ran everything that does not need Jev credentials. The live measurement is the one remaining step and is blocked on `TYPESAFE_API_KEY`.

## Harness

- `test/evals/cases.ts`: 20 labelled cases, 10 tuning and 10 held-out, covering routine edits/builds/tests/installation, production database and infrastructure destruction, broad filesystem and personal-data deletion, irreversible disk writes, dangerous actions inside compound shell commands, and reassuring task context attached to a named-dangerous action. The comment header records the rule that held-out cases are not edited to fit results.
- `test/evals/score.ts`: pure scoring for missed dangers, unnecessary prompts, errors, and p50/max latency, grouped so tuning and held-out results stay separate.
- `scripts/eval.ts` (`npm run test:eval`): runs the cases through the real policy and Jev client, prints a per-case line and the grouped summary, and exits non-zero on errors or missing credentials.
- `test/eval.test.ts`: offline checks that the case set is well formed, the scoring is correct, and the pipeline consumes every case. Runs in `npm run check` and never touches the network.

## Verification

- `npm run check`: 35/35 tests, including the three evaluation tests.
- Dry run of `scripts/eval.ts` against a local always-approve stub: 20/20 cases ran, 0 errors, latency reported, and the summary correctly flagged 10 missed dangers (all five tuning and all five held-out `expected: ask` cases) with 0 unnecessary prompts. This is the expected false-negative baseline for a classifier that always approves, and confirms the harness measures what it claims.
- `npm run test:live`: real headless Pi RPC and print-mode sessions, including the Jev pipeline against a local stub (see Milestone 2).

## Not done: the live measurement

`TYPESAFE_API_KEY` is absent, so no case has been scored by Jev itself. The acceptance check "evaluation reports include missed dangers and unnecessary prompts" is satisfied by the harness and its dry run, but the honest report of where Jev helps and where it misses requires the key.

To finish: set `TYPESAFE_API_KEY` and run `npm run test:eval` (and `npm run test:eval -- tuning` while adjusting the rubric). Expect the tuning group to be tuned first, then report the held-out group unchanged. The dry-run stub result establishes the baseline that Jev has to beat: any `expected: ask` case Jev approves is a missed danger, and that count is the number this milestone exists to reduce.

## Limits

- The case set is small and judgement-based; it is not a measured safety guarantee.
- Shadow-mode measurement of real usage still needs a person running real sessions and reading the audit log.
- No threshold tuning has happened yet, because tuning without live results would be guesswork.
