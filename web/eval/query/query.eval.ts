// Runs every question in ./cases.ts through the real parseInput and the
// real Claude API, against the fake calendar in ./dataset.ts, and prints a
// score per group for each answering strategy. Report-only: it doesn't fail
// on wrong answers, since the point is comparing scores.
//
//   npm run eval:query --workspace=web          # both strategies
//   EVAL_STRATEGIES=select npm run eval:query --workspace=web
//
// Needs ANTHROPIC_API_KEY (from the environment or web/.env.local). Costs
// roughly $0.30 per full run on Claude Haiku 4.5.
import { describe, it, vi, beforeAll, afterAll } from "vitest";
import { CASES, type QueryCase } from "./cases";
import { EVENTS, REFERENCE_DATE, TIMEZONE, listEventsInRange } from "./dataset";

vi.mock("../../src/lib/google-calendar", () => ({
  listEvents: async (_userId: string, _calendarId: string, timeMin: string, timeMax: string) =>
    listEventsInRange(timeMin, timeMax),
}));
vi.mock("../../src/lib/user-settings", () => ({
  getUserSettings: async () => ({ timezone: TIMEZONE, defaultCalendarId: "eval", defaultEventDurationMin: 30 }),
}));
vi.mock("../../src/lib/llm-log", () => ({ logLlmCall: () => {} }));

const { parseInput } = await import("../../src/lib/parse");

type Strategy = "select" | "keyword";
const STRATEGIES = (process.env.EVAL_STRATEGIES ?? "select,keyword")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Strategy => s === "select" || s === "keyword");
const CONCURRENCY = 4;

interface Outcome {
  testCase: QueryCase;
  pass: boolean;
  got: string[];
  gotYesNo?: string;
  intent?: string;
  usedLlm?: boolean;
  error?: string;
}

function seriesOf(id: string): string {
  return id.replace(/-\d{4}$/, "");
}

export function judge(testCase: QueryCase, got: string[], gotYesNo: string | undefined): boolean {
  if (testCase.yesNo && gotYesNo !== testCase.yesNo) return false;
  const sameSet = (want: string[]) => want.length === got.length && want.every((id) => got.includes(id));
  const { expect } = testCase;
  if ("events" in expect) return sameSet(expect.events);
  if ("oneOf" in expect) return expect.oneOf.some(sameSet);
  const occurrences = EVENTS.filter((e) => seriesOf(e.id) === expect.next && Date.parse(e.end) > REFERENCE_DATE.getTime());
  return got.includes(occurrences[0].id) && got.every((id) => seriesOf(id) === expect.next);
}

async function runCase(testCase: QueryCase): Promise<Outcome> {
  try {
    const result = await parseInput("eval-user", { kind: "text", text: testCase.question }, "eval");
    const got = result.intent === "query" ? (result.queryEvents ?? []).map((e) => e.id) : [];
    const gotYesNo = result.answerLead === "Yes." ? "yes" : result.answerLead === "No." ? "no" : undefined;
    return {
      testCase,
      pass: result.intent === "query" && judge(testCase, got, gotYesNo),
      got,
      gotYesNo,
      intent: result.intent,
      usedLlm: result.usedLlm,
    };
  } catch (err) {
    return { testCase, pass: false, got: [], error: String(err) };
  }
}

async function runAll(): Promise<Outcome[]> {
  const outcomes: Outcome[] = new Array(CASES.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < CASES.length) {
        const i = next++;
        outcomes[i] = await runCase(CASES[i]);
      }
    }),
  );
  return outcomes;
}

function describeExpectation(testCase: QueryCase): string {
  const { expect } = testCase;
  const base =
    "events" in expect
      ? expect.events.join(", ") || "(nothing)"
      : "oneOf" in expect
        ? expect.oneOf.map((set) => `[${set.join(", ")}]`).join(" or ")
        : `next ${expect.next}`;
  return testCase.yesNo ? `${testCase.yesNo.toUpperCase()} + ${base}` : base;
}

const results = new Map<Strategy, Outcome[]>();

describe("query eval", () => {
  beforeAll(() => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set (export it or put it in web/.env.local)");
    }
    // Only Date is faked, so parseInput's "now" is the dataset's reference
    // time while network timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(REFERENCE_DATE);
  });

  afterAll(() => {
    vi.useRealTimers();
    const groups = [...new Set(CASES.map((c) => c.group))];
    const lines: string[] = ["", "Query eval — score by group", ""];
    lines.push(["group".padEnd(18), ...STRATEGIES.map((s) => s.padStart(10))].join(""));
    for (const group of [...groups, "TOTAL"]) {
      const cells = STRATEGIES.map((strategy) => {
        const outcomes = (results.get(strategy) ?? []).filter((o) => group === "TOTAL" || o.testCase.group === group);
        return `${outcomes.filter((o) => o.pass).length}/${outcomes.length}`.padStart(10);
      });
      lines.push([group.padEnd(18), ...cells].join(""));
    }
    for (const strategy of STRATEGIES) {
      lines.push("", `Misses — ${strategy}:`);
      for (const o of results.get(strategy) ?? []) {
        if (o.pass) continue;
        const got = o.error
          ? `ERROR ${o.error}`
          : `${o.gotYesNo ? `${o.gotYesNo.toUpperCase()} + ` : ""}${o.got.join(", ") || "(nothing)"}${o.intent !== "query" ? ` [intent=${o.intent}]` : ""}${o.usedLlm === false ? " [fast path]" : ""}`;
        lines.push(`  ✗ ${o.testCase.question}`, `      want: ${describeExpectation(o.testCase)}`, `      got:  ${got}`);
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
  });

  for (const strategy of STRATEGIES) {
    it(`strategy: ${strategy}`, async () => {
      process.env.QUERY_ANSWER_STRATEGY = strategy;
      results.set(strategy, await runAll());
    }, 600_000);
  }
});
