# Milestone 2 — Jev

Implemented the real Jev client in `src/classifier.ts`. Unmatched supported calls now reach Jev when `classifier.enabled` is true.

## Behaviour

- `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`, no automatic retries.
- One `choice` question named `decision` offering `approve` and `ask`. The user's editable `classifier.instructions` rubric is the question instructions; the action, working directory, task context, and omission/truncation flags are the `state`.
- The pinned `classifier.model` is sent per request, so the profile keeps thresholds tied to a version.
- The choice maps to a recommendation; `approve` still has to clear `approve_probability_min` in `src/policy.ts`, otherwise the decision is `ask`. Jev can never produce a block.
- Response validation covers the resolved model, answer type, the chosen option, and every probability (finite, in range 0–1). Anything malformed is an error, not a decision.
- Errors map to categories: `missing_credentials`, `unauthorized`, `rate_limited`, `provider_error`, `invalid_response`, plus the existing `input_limit` and `timeout`. All follow `classifier.on_error`.
- The caller's abort signal is forwarded, so the existing total-timeout and cancellation handling covers the HTTP request.

## Privacy

Bodies were already excluded by `classificationInput`; the client only serializes that prepared input. Credentials stay in the `Authorization` header and never enter the body. `TYPESAFE_API_URL` overrides the endpoint for gateways and for the stub-based verification. Documented in the README under "Jev and privacy".

## Verification

- `npm run check`: 35/35 tests. New `test/classifier.test.ts` covers the request shape (rubric in instructions, action/context in state, credential never in the body), body/secret exclusion, threshold boundaries, 401/403/429/422/500/529 mapping, eight malformed-response shapes, non-JSON bodies, missing credentials without a network call, signal forwarding, timeout, and endpoint override.
- Headless RPC session against a local stub with the real request/response shape: Jev approve executes without prompting; Jev ask prompts and honours `Allow once`; a 401 with `on_error: block` prevents execution; shadow mode records the ask recommendation and executes without prompting. The stub verified the authorization header, the rubric in the request, and that no credential appears in any body.

## Limits

- No live Jev call was made: `TYPESAFE_API_KEY` is not set in this environment, and Jev access is waitlisted. The client is verified against the documented shape and a stub, not against production.
- Redaction is best effort; the README states the residual risk.
- No caching, batching, or retries, per the specification.
