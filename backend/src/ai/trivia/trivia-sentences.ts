import { extractJsonObject } from "../../email-receipts/ai/email-receipt-ai.schema";
import type { TriviaFact, TriviaItem, TriviaTopic } from "./trivia.types";

/** The most sentences kept from a model, and the longest one shown. */
const MAX_AI_ITEMS = 16;
const MAX_SENTENCE_CHARS = 240;

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
/**
 * What a figure looks like outside a placeholder, where it could only be the
 * model's own: any script's numerals, a run of CJK numerals (which are letters
 * to Unicode, and alone are ordinary words), a percent or currency sign (the
 * placeholder's value already carries its own), and a brace left by a
 * placeholder that was not written correctly.
 */
const OWN_FIGURE =
  /\p{N}|[零一二三四五六七八九十百千万億亿兆]{2,}|[%\p{Sc}{}]/u;

/** The prompt's list of facts. Names never leave the server, only their meaning. */
export function buildTriviaPrompt(facts: TriviaFact[]): string {
  return facts
    .map((f) => {
      const figures = Object.entries(f.figures).map(([name, figure]) => {
        switch (figure.kind) {
          case "money":
            return `  {${name}}: money, ${figure.value} ${figure.currency}`;
          case "text":
            return `  {${name}}: a name, filled in later`;
          default:
            return `  {${name}}: ${figure.kind}, ${figure.value}`;
        }
      });
      return `Fact ${f.id} (topic ${f.topic}):\n${figures.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * The usable sentences of a model's reply. One is dropped when it could state
 * anything the fact sheet does not: an unknown placeholder, one from the other
 * topic, no placeholder at all, or a figure written outside one.
 */
export function parseTriviaSentences(
  content: string,
  facts: TriviaFact[],
): TriviaItem[] {
  const parsed = extractJsonObject(content) as { trivia?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.trivia)) return [];

  const topicOfFigure = new Map<string, TriviaTopic>();
  for (const f of facts) {
    for (const name of Object.keys(f.figures)) {
      topicOfFigure.set(name, f.topic);
    }
  }

  const seen = new Set<string>();
  const items: TriviaItem[] = [];
  for (const entry of parsed.trivia as unknown[]) {
    if (items.length >= MAX_AI_ITEMS) break;
    const { topic, text } = (entry ?? {}) as Record<string, unknown>;
    if (
      (topic !== "netWorth" && topic !== "investments") ||
      typeof text !== "string"
    ) {
      continue;
    }
    const sentence = text.trim();
    if (
      sentence.length === 0 ||
      sentence.length > MAX_SENTENCE_CHARS ||
      seen.has(sentence)
    ) {
      continue;
    }
    const names = [...sentence.matchAll(PLACEHOLDER)].map((m) => m[1]);
    if (
      names.length === 0 ||
      names.some((name) => topicOfFigure.get(name) !== topic) ||
      OWN_FIGURE.test(sentence.replace(PLACEHOLDER, ""))
    ) {
      continue;
    }
    seen.add(sentence);
    items.push({ topic, source: "ai", text: sentence });
  }
  return items;
}

/**
 * The day's list: a model's sentences for each topic it answered, the
 * calculated sentence of every fact for a topic it did not.
 */
export function mergeTriviaItems(
  facts: TriviaFact[],
  aiItems: TriviaItem[],
): TriviaItem[] {
  const answered = new Set(aiItems.map((i) => i.topic));
  const calculated = facts
    .filter((f) => !answered.has(f.topic))
    .map((f): TriviaItem => ({
      topic: f.topic,
      source: "calculated",
      factId: f.id,
    }));
  return [...aiItems, ...calculated];
}
