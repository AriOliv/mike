// A long playbook is reviewed in batches of rules.
//
// One call per review asks the model for a finding per rule. With a playbook
// of twenty-odd rules over a long contract, models answer the first rules in
// full and stop: the rest come back as "the model did not return a result"
// and someone has to finish the review by hand. Splitting the rules into
// batches — whole topics kept together, so related rules are judged side by
// side — gives each call few enough rules to answer them all. Each batch is a
// playbook of its own (same name, party, types and jurisdictions; only its
// topics), so the prompt, the parsing and the rule ids stay exactly as for a
// single call, and the findings are put back in the playbook's order.

import type { PlaybookContent } from "./playbooks.operations";

/** Rules per call. A playbook with no more than this is reviewed in one call. */
export const REVIEW_BATCH_RULES = 8;

type Topic = PlaybookContent["topics"][number];

const ruleCount = (content: PlaybookContent) =>
  content.rules.length + content.topics.reduce((sum, topic) => sum + topic.rules.length, 0);

/**
 * The playbook as one or more batches of at most `size` rules. Topics are not
 * split unless one alone is larger than a batch; loose rules (outside any
 * topic) form their own batches.
 */
export function playbookReviewBatches(
  content: PlaybookContent,
  size = REVIEW_BATCH_RULES,
): PlaybookContent[] {
  if (ruleCount(content) <= size) return [content];
  const pieces: { rules: PlaybookContent["rules"]; topics: Topic[] }[] = [];
  for (let at = 0; at < content.rules.length; at += size)
    pieces.push({ rules: content.rules.slice(at, at + size), topics: [] });
  const topicPieces: Topic[] = content.topics.flatMap((topic) => {
    if (topic.rules.length <= size) return [topic];
    const parts: Topic[] = [];
    for (let at = 0; at < topic.rules.length; at += size)
      parts.push({ ...topic, rules: topic.rules.slice(at, at + size) });
    return parts;
  });
  let current: Topic[] = [];
  let count = 0;
  for (const topic of topicPieces) {
    if (count && count + topic.rules.length > size) {
      pieces.push({ rules: [], topics: current });
      current = [];
      count = 0;
    }
    current.push(topic);
    count += topic.rules.length;
  }
  if (current.length) pieces.push({ rules: [], topics: current });
  return pieces.map((piece) => ({ ...content, rules: piece.rules, topics: piece.topics }));
}

/** The order rule ids appear in across the whole playbook. */
function ruleOrder(content: PlaybookContent): Map<string, number> {
  const order = new Map<string, number>();
  for (const rule of [...content.rules, ...content.topics.flatMap((topic) => topic.rules)])
    if (rule.id) order.set(rule.id, order.size);
  return order;
}

/**
 * One review from the batches' results: findings in the playbook's rule order
 * (findings outside any rule last, in the order they came), and the batches'
 * summaries joined.
 */
export function mergeBatchReviews<F extends { ruleId: string | null }>(
  content: PlaybookContent,
  results: { summary: string; findings: F[] }[],
): { summary: string; findings: F[] } {
  if (results.length === 1) return results[0];
  const order = ruleOrder(content);
  const findings = results
    .flatMap((result) => result.findings)
    .map((finding, at) => ({ finding, at }))
    .sort((a, b) => {
      const ra = a.finding.ruleId != null ? order.get(a.finding.ruleId) : undefined;
      const rb = b.finding.ruleId != null ? order.get(b.finding.ruleId) : undefined;
      if (ra != null && rb != null) return ra - rb || a.at - b.at;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return a.at - b.at;
    })
    .map(({ finding }) => finding);
  const summary = results
    .map((result) => result.summary.trim())
    .filter(Boolean)
    .join("\n\n");
  return { summary, findings };
}
