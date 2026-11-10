export type TriviaTopic = 'netWorth' | 'investments';

/** One figure a sentence can quote, formatted in the reader's own number format. */
export type TriviaFigure =
  | { kind: 'money'; value: number; currency: string }
  | { kind: 'percent'; value: number }
  | { kind: 'multiple'; value: number }
  | { kind: 'rate'; value: number }
  /** `YYYY-MM`. */
  | { kind: 'month'; value: string }
  | { kind: 'text'; value: string };

export type TriviaFigures = Record<string, TriviaFigure>;

export type TriviaItem =
  | { topic: TriviaTopic; source: 'calculated'; factId: string }
  /** `text` quotes figures as `{name}` placeholders. */
  | { topic: TriviaTopic; source: 'ai'; text: string };

export interface DashboardTriviaResponse {
  items: TriviaItem[];
  figures: TriviaFigures;
  generatedAt: string;
}
