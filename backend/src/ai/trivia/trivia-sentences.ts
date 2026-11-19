import { extractJsonObject } from "../../email-receipts/ai/email-receipt-ai.schema";
import {
  TRIVIA_TOPICS,
  type TriviaFact,
  type TriviaItem,
  type TriviaTopic,
} from "./trivia.types";

/**
 * The most sentences kept from a model, and the longest one shown. The prompt
 * asks for one item per fact, so a reply is held to one per fact it was given,
 * never more than every fact the catalog can produce.
 */
const MAX_AI_ITEMS = 26;
const MAX_SENTENCE_CHARS = 240;
/** One sentence may combine two facts of its topic, no more. */
const MAX_FACTS_PER_SENTENCE = 2;

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

function isTriviaTopic(value: unknown): value is TriviaTopic {
  return (TRIVIA_TOPICS as readonly unknown[]).includes(value);
}

/** Whether a sentence holds a figure of its own outside its placeholders. */
export function hasOwnFigure(sentence: string): boolean {
  return OWN_FIGURE.test(sentence.replace(PLACEHOLDER, ""));
}

/**
 * The usable sentences of a model's reply. One is dropped when it could state
 * anything the fact sheet does not: an unknown placeholder, one from another
 * topic, no placeholder at all, a figure written outside one, or figures of
 * more than two facts. A kept sentence records the facts it quotes.
 */
export function parseTriviaSentences(
  content: string,
  facts: TriviaFact[],
): TriviaItem[] {
  const parsed = extractJsonObject(content) as { trivia?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.trivia)) return [];

  const factOfFigure = new Map<string, TriviaFact>();
  for (const f of facts) {
    for (const name of Object.keys(f.figures)) {
      factOfFigure.set(name, f);
    }
  }

  const seen = new Set<string>();
  const items: TriviaItem[] = [];
  for (const entry of parsed.trivia as unknown[]) {
    if (items.length >= Math.min(MAX_AI_ITEMS, facts.length)) break;
    const { topic, text } = (entry ?? {}) as Record<string, unknown>;
    if (!isTriviaTopic(topic) || typeof text !== "string") {
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
    const owners = names.map((name) => factOfFigure.get(name));
    if (
      names.length === 0 ||
      owners.some((owner) => !owner || owner.topic !== topic) ||
      hasOwnFigure(sentence)
    ) {
      continue;
    }
    const factIds = [
      ...new Set((owners as TriviaFact[]).map((owner) => owner.id)),
    ];
    if (factIds.length > MAX_FACTS_PER_SENTENCE) continue;
    seen.add(sentence);
    items.push({ topic, source: "ai", text: sentence, factIds });
  }
  return items;
}

/**
 * The day's list, in the order of `facts`: a model's sentence stands where the
 * first fact it covers would be, and every fact no sentence covers keeps its
 * calculated one (carrying `params`). A sentence covers the facts in its
 * `factIds`; one without `factIds` (a row from before the rotation) covers
 * every fact of its topic, as it always did. A sentence covering nothing
 * follows the rest.
 */
export function mergeTriviaItems(
  facts: TriviaFact[],
  aiItems: TriviaItem[],
): TriviaItem[] {
  const coverage = (item: TriviaItem, fact: TriviaFact): boolean =>
    item.source === "ai" &&
    (item.factIds ? item.factIds.includes(fact.id) : item.topic === fact.topic);
  const emitted = new Set<TriviaItem>();
  const items: TriviaItem[] = [];
  for (const fact of facts) {
    const covering = aiItems.filter((ai) => coverage(ai, fact));
    if (covering.length === 0) {
      items.push({
        topic: fact.topic,
        source: "calculated",
        factId: fact.id,
        ...(fact.params ? { params: fact.params } : {}),
      });
      continue;
    }
    for (const ai of covering) {
      if (!emitted.has(ai)) {
        emitted.add(ai);
        items.push(ai);
      }
    }
  }
  return [...items, ...aiItems.filter((ai) => !emitted.has(ai))];
}
