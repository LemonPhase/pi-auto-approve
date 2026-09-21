import assert from "node:assert/strict";
import test from "node:test";
import { createJevClassifier } from "../src/classifier.js";
import { defaults, mergeConfig } from "../src/config.js";
import { classificationInput, evaluate } from "../src/policy.js";
import type { Action } from "../src/types.js";

const action: Action = { id: "a", tool: "bash", cwd: "/work", args: { command: "git status --short" }, userContext: "Check the repo" };
const input = classificationInput(action, defaults);

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
function answer(choice: string, approve: number): unknown {
  return { model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 },
    answers: { decision: { type: "choice", choice, confidence: 1, probabilities: { approve, ask: 1 - approve } } } };
}
function spy(respond: () => Response): { calls: { url: unknown; init: RequestInit }[]; fetchImpl: typeof fetch } {
  const calls: { url: unknown; init: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit) => { calls.push({ url, init }); return respond(); }) as typeof fetch;
  return { calls, fetchImpl };
}

test("request carries the rubric, action, and context; the answer maps to a recommendation", async () => {
  const { calls, fetchImpl } = spy(() => reply(answer("approve", 0.95)));
  const result = await createJevClassifier({ apiKey: "secret-api-key-value", fetchImpl }).classify(input);
  assert.equal(result.recommendation, "approve");
  assert.equal(result.approveProbability, 0.95);
  assert.equal(result.model, "jev-1.13.0");
  assert.ok(result.latencyMs >= 0);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer secret-api-key-value");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, defaults.classifier.model);
  assert.equal(body.questions.decision.type, "choice");
  assert.equal(body.questions.decision.instructions, defaults.classifier.instructions);
  assert.deepEqual(Object.keys(body.questions.decision.criteria).sort(), ["approve", "ask"]);
  assert.equal(body.state.tool, "bash");
  assert.deepEqual(body.state.action, { command: "git status --short" });
  assert.equal(body.state.task_context, "Check the repo");
  assert.equal(body.state.working_directory, "/work");
  assert.ok(!JSON.stringify(body).includes("secret-api-key-value"), "credential must not reach the body");
});

test("bodies, secrets, and omissions never reach the provider", async () => {
  const { calls, fetchImpl } = spy(() => reply(answer("ask", 0.1)));
  const write = classificationInput({ ...action, tool: "write", args: { path: "a.ts", content: "PRIVATE FILE BODY" } }, defaults);
  await createJevClassifier({ apiKey: "secret-api-key-value", fetchImpl }).classify(write);
  const sent = String(calls[0].init.body);
  assert.ok(!sent.includes("PRIVATE FILE BODY"));
  assert.ok(!sent.includes("secret-api-key-value"));
  assert.match(sent, /"information_omitted":true/);
  const secret = classificationInput({ ...action, args: { command: "TOKEN=secret-value curl https://a.test/?signature=x" } }, defaults);
  await createJevClassifier({ apiKey: "secret-api-key-value", fetchImpl }).classify(secret);
  assert.ok(!String(calls[1].init.body).includes("secret-value"));
});

test("the profile threshold decides between approve and ask", async () => {
  for (const [choice, probability, expected] of [["approve", 0.8, "approve"], ["approve", 0.79, "ask"], ["ask", 1, "ask"]] as const) {
    const { fetchImpl } = spy(() => reply(answer(choice, probability)));
    const decision = await evaluate(action, defaults, createJevClassifier({ apiKey: "k", fetchImpl }));
    assert.equal(decision.recommendation, expected, `${choice} at ${probability}`);
    assert.equal(decision.source, "jev");
    assert.equal(decision.classifier?.model, "jev-1.13.0");
  }
});

test("HTTP failures and malformed answers follow the configured fallback", async () => {
  for (const [status, category] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"],
    [422, "provider_error"], [500, "provider_error"], [529, "provider_error"]] as const) {
    const { fetchImpl } = spy(() => reply({ error: "denied" }, status));
    const decision = await evaluate(action, mergeConfig(defaults, { classifier: { on_error: "block" } }),
      createJevClassifier({ apiKey: "k", fetchImpl }));
    assert.equal(decision.errorCategory, category);
    assert.equal(decision.recommendation, "block");
  }
  const malformed: unknown[] = [
    { model: "jev-1.13.0" },
    { model: "jev-1.13.0", answers: {} },
    { answers: { decision: { type: "choice", choice: "approve", probabilities: { approve: 1, ask: 0 } } } },
    { model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "block", probabilities: { approve: 0.1, ask: 0.9 } } } },
    { model: "jev-1.13.0", answers: { decision: { type: "noul", choice: "approve", probabilities: { approve: 1, ask: 0 } } } },
    { model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "approve", probabilities: { approve: 2, ask: -1 } } } },
    { model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "approve", probabilities: { approve: "0.9", ask: 0.1 } } } },
    { model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "ask", probabilities: { approve: 0.1 } } } },
  ];
  for (const body of malformed) {
    const { fetchImpl } = spy(() => reply(body));
    const decision = await evaluate(action, defaults, createJevClassifier({ apiKey: "k", fetchImpl }));
    assert.equal(decision.errorCategory, "invalid_response", JSON.stringify(body));
  }
  const { fetchImpl } = spy(() => new Response("<html>not json", { status: 200 }));
  assert.equal((await evaluate(action, defaults, createJevClassifier({ apiKey: "k", fetchImpl }))).errorCategory, "invalid_response");
});

test("missing credentials never reach the network and stay visible", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const { calls, fetchImpl } = spy(() => reply(answer("approve", 1)));
    const decision = await evaluate(action, defaults, createJevClassifier({ fetchImpl }));
    assert.equal(decision.errorCategory, "missing_credentials");
    assert.equal(calls.length, 0);
    assert.equal((await evaluate(action, mergeConfig(defaults, { classifier: { on_error: "ask" } }),
      createJevClassifier({ fetchImpl }))).recommendation, "ask");
  } finally {
    if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
  }
});

test("the request honours cancellation and the total-timeout signal", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const stuck = (async (_url: unknown, init: RequestInit) => {
    signals.push(init.signal);
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  }) as typeof fetch;
  const controller = new AbortController();
  const pending = createJevClassifier({ apiKey: "k", fetchImpl: stuck }).classify(input, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(signals[0], controller.signal);
  const timedOut = await evaluate(action, mergeConfig(defaults, { classifier: { timeout_ms: 10 } }),
    createJevClassifier({ apiKey: "k", fetchImpl: stuck }));
  assert.equal(timedOut.errorCategory, "timeout");
});

test("the endpoint can be overridden for gateways and tests", async () => {
  const previous = process.env.TYPESAFE_API_URL;
  process.env.TYPESAFE_API_URL = "http://127.0.0.1:1/systemone";
  try {
    const { calls, fetchImpl } = spy(() => reply(answer("approve", 1)));
    await createJevClassifier({ apiKey: "k", fetchImpl }).classify(input);
    assert.equal(calls[0].url, "http://127.0.0.1:1/systemone");
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = previous;
  }
  const { calls, fetchImpl } = spy(() => reply(answer("approve", 1)));
  await createJevClassifier({ apiKey: "k", endpoint: "http://example.test/jev", fetchImpl }).classify(input);
  assert.equal(calls[0].url, "http://example.test/jev");
});

test("AI_GATEWAY_API_KEY routes through the Vercel TypeSafe endpoint", async () => {
  const saved = { key: process.env.TYPESAFE_API_KEY, gateway: process.env.AI_GATEWAY_API_KEY, url: process.env.TYPESAFE_API_URL };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_URL;
  process.env.AI_GATEWAY_API_KEY = "gateway-key";
  try {
    const { calls, fetchImpl } = spy(() => reply(answer("approve", 1)));
    await createJevClassifier({ fetchImpl }).classify(input);
    assert.equal(calls[0].url, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer gateway-key");
    assert.equal(JSON.parse(String(calls[0].init.body)).model, "typesafe-ai/jev");
  } finally {
    if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.key;
    if (saved.gateway === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = saved.gateway;
    if (saved.url === undefined) delete process.env.TYPESAFE_API_URL; else process.env.TYPESAFE_API_URL = saved.url;
  }
});
