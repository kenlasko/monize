export type TriviaTopic = 'netWorth' | 'investments' | 'spending' | 'income' | 'activity' | 'warranties';

/** One figure a sentence can quote, formatted in the reader's own number format. */
export type TriviaFigure =
  | { kind: 'money'; value: number; currency: string }
  | { kind: 'percent'; value: number }
  | { kind: 'multiple'; value: number }
  | { kind: 'rate'; value: number }
  /** A whole number of things: transactions, payees, months. */
  | { kind: 'count'; value: number }
  /** `YYYY-MM`. */
  | { kind: 'month'; value: string }
  | { kind: 'text'; value: string }
  /** `YYYY-MM-DD`, shown as a full date. */
  | { kind: 'date'; value: string }
  /** `YYYY-MM-DD`, a recent day shown with its weekday. */
  | { kind: 'day'; value: string }
  /** A whole number of days, shown with its unit. */
  | { kind: 'days'; value: number }
  /** A whole number of years, shown with its unit. */
  | { kind: 'years'; value: number };

export type TriviaFigures = Record<string, TriviaFigure>;

export type TriviaItem =
  | { topic: TriviaTopic; source: 'calculated'; factId: string; params?: { window?: string } }
  /** `text` quotes figures as `{name}` placeholders. */
  | { topic: TriviaTopic; source: 'ai'; text: string; factIds?: string[] };

export interface DashboardTriviaResponse {
  items: TriviaItem[];
  figures: TriviaFigures;
  generatedAt: string;
}
