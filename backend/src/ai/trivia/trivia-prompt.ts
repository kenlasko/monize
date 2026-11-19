import { TRIVIA_ANGLES, type TriviaAngle } from "../context/prompt-templates";
import type { TriviaFact, TriviaFigure, TriviaWindow } from "./trivia.types";
import { TRIVIA_PERIODS } from "./trivia-families";
import { hasOwnFigure } from "./trivia-sentences";
import { seedHash, dayIndex } from "./trivia-windows";

/** The most of yesterday's sentences sent back as wording not to reuse. */
export const MAX_AVOID_SENTENCES = 10;

const ANGLE_IDS = Object.keys(TRIVIA_ANGLES) as TriviaAngle[];

/** The window in words with no numeral, which the model may paraphrase. */
const WINDOW_WORDS: Record<TriviaWindow, string> = {
  d30: "the past month",
  d90: "the past quarter",
  ytd: "this year so far",
  m12: "the past year",
  all: "all of their records",
};

export interface TriviaPromptOptions {
  /** Yesterday's sentences, as stored: templates with `{placeholder}` names. */
  avoid: string[];
  angle: TriviaAngle;
}

/** The angle of the day: deterministic, so the cron and a rebuild agree. */
export function pickTriviaAngle(userId: string, today: string): TriviaAngle {
  return ANGLE_IDS[
    seedHash(userId, "angle", String(dayIndex(today))) % ANGLE_IDS.length
  ];
}

/** A figure in words. A name (`text`) never leaves the server, only its meaning. */
function describeFigure(name: string, figure: TriviaFigure): string {
  switch (figure.kind) {
    case "money":
      return `  {${name}}: money, ${figure.value} ${figure.currency}`;
    case "text":
      return `  {${name}}: a name, filled in later`;
    case "date":
      return `  {${name}}: a date, ${figure.value}, shown as a full date`;
    case "day":
      return `  {${name}}: a recent day, ${figure.value}, shown with its weekday`;
    case "days":
      return `  {${name}}: a number of days, ${figure.value}, shown with its unit, so do not write the word days after it`;
    case "years":
      return `  {${name}}: a number of years, ${figure.value}, shown with its unit, so do not write the word years after it`;
    default:
      return `  {${name}}: ${figure.kind}, ${figure.value}`;
  }
}

/**
 * The model's prompt: the day's selected facts, yesterday's wording to avoid
 * and the angle of the day. Only the placeholders of yesterday's sentences
 * go, never their figures: they are stored as templates, and one that holds a
 * figure of its own is left out.
 */
export function buildTriviaPrompt(
  facts: TriviaFact[],
  options: TriviaPromptOptions,
): string {
  const sheet = facts
    .map((f) => {
      const figures = Object.entries(f.figures).map(([name, figure]) =>
        describeFigure(name, figure),
      );
      const window = f.params?.window
        ? [`  window: ${WINDOW_WORDS[f.params.window]}`]
        : [];
      const fixed = TRIVIA_PERIODS[f.id];
      const period = !f.params?.window && fixed ? [`  period: ${fixed}`] : [];
      return `Fact ${f.id} (topic ${f.topic}):\n${[...window, ...period, ...figures].join("\n")}`;
    })
    .join("\n\n");

  const avoid = options.avoid
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !hasOwnFigure(sentence))
    .slice(0, MAX_AVOID_SENTENCES);
  const parts = [`Angle for today: ${TRIVIA_ANGLES[options.angle]}`, sheet];
  if (avoid.length > 0) {
    parts.push(
      `Sentences shown yesterday (do not reuse their wording; their placeholders belong to yesterday):\n${avoid
        .map((sentence) => `- ${sentence}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}
