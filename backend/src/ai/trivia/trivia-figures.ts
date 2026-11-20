import { roundFxRate } from "../../common/fx-entry.util";
import { roundMoney } from "../../common/round.util";
import type {
  TriviaFact,
  TriviaFactId,
  TriviaFactParams,
  TriviaFigure,
  TriviaFigures,
  TriviaTopic,
} from "./trivia.types";

/** Figure constructors, written once for every builder. */

export const money = (value: number, currency: string): TriviaFigure => ({
  kind: "money",
  value: roundMoney(value),
  currency,
});
export const percent = (value: number): TriviaFigure => ({
  kind: "percent",
  value: roundMoney(value),
});
/** A ratio, to two places ("3.5 times"). */
export const multiple = (value: number): TriviaFigure => ({
  kind: "multiple",
  value: roundMoney(value, 2),
});
/** An exchange rate: `NUMERIC(20,10)` precision, never `roundMoney`. */
export const rate = (value: number): TriviaFigure => ({
  kind: "rate",
  value: roundFxRate(value),
});
export const count = (value: number): TriviaFigure => ({
  kind: "count",
  value,
});
/** A `YYYY-MM-DD` or `YYYY-MM` input, kept to `YYYY-MM`. */
export const month = (value: string): TriviaFigure => ({
  kind: "month",
  value: value.slice(0, 7),
});
export const text = (value: string): TriviaFigure => ({ kind: "text", value });
/** A calendar date, `YYYY-MM-DD`, shown as a full date. */
export const date = (value: string): TriviaFigure => ({
  kind: "date",
  value,
});
/** A recent day, `YYYY-MM-DD`, shown with its weekday. */
export const day = (value: string): TriviaFigure => ({ kind: "day", value });
/** A whole number of days, shown with its unit. */
export const days = (value: number): TriviaFigure => ({
  kind: "days",
  value,
});
/** A whole number of years, shown with its unit. */
export const years = (value: number): TriviaFigure => ({
  kind: "years",
  value,
});

export function fact(
  id: TriviaFactId,
  topic: TriviaTopic,
  figures: TriviaFigures,
  params?: TriviaFactParams,
): TriviaFact {
  return params ? { id, topic, figures, params } : { id, topic, figures };
}
