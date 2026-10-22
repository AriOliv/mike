import { describe, expect, it } from "vitest";
import type { PlaybookContent } from "../playbooks.operations";
import { mergeBatchReviews, playbookReviewBatches, REVIEW_BATCH_RULES } from "../playbooks.batches";

const rule = (id: string) =>
  ({
    id,
    name: `Rule ${id}`,
    concept: "c",
    scope: "clause",
    required: false,
    guidance: "",
    standard: null,
    fallbacks: [],
    unacceptable: [],
    conditions: [],
    actions: [],
    sourceRefs: [],
  }) as PlaybookContent["rules"][number];
const topic = (id: string, ruleIds: string[]) => ({ id, name: `Topic ${id}`, rules: ruleIds.map(rule) });
const playbook = (topics: ReturnType<typeof topic>[], loose: string[] = []): PlaybookContent => ({
  name: "NDA",
  description: "d",
  representedParty: "Us",
  documentTypes: ["NDA"],
  jurisdictions: ["Brasil"],
  rules: loose.map(rule),
  topics,
});
const ids = (content: PlaybookContent) => [
  ...content.rules.map((r) => r.id),
  ...content.topics.flatMap((t) => t.rules.map((r) => r.id)),
];
const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe("playbookReviewBatches", () => {
  it("keeps a short playbook in one call, unchanged", () => {
    const content = playbook([topic("a", range("a", 3)), topic("b", range("b", 5))]);
    expect(playbookReviewBatches(content)).toEqual([content]);
  });

  it("splits a long playbook into batches of whole topics, every rule once and in order", () => {
    // The NDA playbook's shape: 10 + 4 + 5 + 3 rules.
    const content = playbook([
      topic("geral", range("g", 10)),
      topic("cenario", range("c", 4)),
      topic("eixos", range("e", 5)),
      topic("escala", range("x", 3)),
    ]);
    const batches = playbookReviewBatches(content);
    expect(batches.flatMap(ids)).toEqual(ids(content));
    for (const batch of batches) {
      expect(ids(batch).length).toBeLessThanOrEqual(REVIEW_BATCH_RULES);
      expect(batch).toMatchObject({ name: "NDA", representedParty: "Us", documentTypes: ["NDA"], jurisdictions: ["Brasil"] });
    }
    // A topic larger than a batch is cut, keeping its id and name in each part.
    expect(batches[0].topics).toEqual([{ ...content.topics[0], rules: content.topics[0].rules.slice(0, 8) }]);
    expect(batches[1].topics[0]).toMatchObject({ id: "geral", rules: content.topics[0].rules.slice(8) });
    // Smaller topics share a batch while they fit, and are never split.
    expect(batches.map((b) => b.topics.map((t) => t.id))).toEqual([["geral"], ["geral", "cenario"], ["eixos", "escala"]]);
  });

  it("batches loose rules on their own", () => {
    const content = playbook([topic("t", range("t", 2))], range("r", 10));
    const batches = playbookReviewBatches(content, 4);
    expect(batches.flatMap(ids)).toEqual(ids(content));
    expect(batches.map((b) => [b.rules.length, b.topics.length])).toEqual([[4, 0], [4, 0], [2, 0], [0, 1]]);
  });
});

describe("mergeBatchReviews", () => {
  const content = playbook([topic("a", ["a1", "a2"]), topic("b", ["b1", "b2"])]);

  it("puts findings back in the playbook's order and joins the summaries", () => {
    const merged = mergeBatchReviews(content, [
      { summary: "Second half.", findings: [{ ruleId: "b2" }, { ruleId: null, note: "outside" }, { ruleId: "b1" }] },
      { summary: " First half. ", findings: [{ ruleId: "a2" }, { ruleId: "a1" }] },
    ]);
    expect(merged.findings.map((f) => f.ruleId)).toEqual(["a1", "a2", "b1", "b2", null]);
    expect(merged.summary).toBe("Second half.\n\nFirst half.");
  });

  it("returns a single call's result as it was", () => {
    const only = { summary: "s", findings: [{ ruleId: "b1" }, { ruleId: "a1" }] };
    expect(mergeBatchReviews(content, [only])).toBe(only);
  });
});
