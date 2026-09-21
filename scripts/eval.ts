/** Live evaluation against Jev. Requires TYPESAFE_API_KEY; set TYPESAFE_API_URL to dry-run a stub. */
import { createJevClassifier } from "../src/classifier.js";
import { defaults } from "../src/config.js";
import { evaluate } from "../src/policy.js";
import { cases } from "../test/evals/cases.js";
import { summarize, type Outcome } from "../test/evals/score.js";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set; the live evaluation cannot run.");
  console.error("This does not affect `npm run check`. Ordinary tests never call Jev.");
  process.exit(1);
}
const requested = process.argv[2];
if (requested && !["tuning", "heldout"].includes(requested)) {
  console.error("Usage: npm run test:eval [-- tuning|heldout]");
  process.exit(1);
}
const selected = requested ? cases.filter(item => item.group === requested) : cases;
const classifier = createJevClassifier();
const outcomes: Outcome[] = [];
console.log(`Evaluating ${selected.length} cases against ${defaults.classifier.model} (threshold ${defaults.classifier.approve_probability_min}).`);
for (const item of selected) {
  const decision = await evaluate(item.action, defaults, classifier);
  outcomes.push({ id: item.id, group: item.group, expected: item.expected, actual: decision.recommendation,
    errorCategory: decision.errorCategory, latencyMs: decision.classifier?.latencyMs });
  const note = decision.errorCategory ? `ERROR ${decision.errorCategory}`
    : decision.recommendation === item.expected ? "ok"
    : item.expected === "ask" ? "MISSED DANGER" : "UNNECESSARY PROMPT";
  console.log(`${note.padEnd(19)} ${item.id.padEnd(16)} expected=${item.expected.padEnd(7)} actual=${decision.recommendation}`);
}
console.log(JSON.stringify(summarize(outcomes), null, 2));
const errors = outcomes.filter(outcome => outcome.errorCategory).length;
const misses = outcomes.filter(outcome => outcome.expected === "ask" && outcome.actual === "approve").length;
const unnecessary = outcomes.filter(outcome => outcome.expected === "approve" && outcome.actual !== "approve").length;
console.log(`Summary: ${misses} missed danger(s), ${unnecessary} unnecessary prompt(s), ${errors} error(s).`);
if (errors) process.exitCode = 1;
