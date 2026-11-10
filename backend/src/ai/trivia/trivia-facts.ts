import { roundFxRate } from "../../common/fx-entry.util";
import { roundMoney, sumMoney } from "../../common/round.util";
import type {
  HoldingWithMarketValue,
  PortfolioSummary,
} from "../../securities/portfolio.service";
import { stripBrokerageSuffix } from "../../accounts/account-name.util";
import type {
  TriviaFact,
  TriviaFigure,
  TriviaFigures,
  TriviaTopic,
} from "./trivia.types";

export interface TriviaNetWorthMonth {
  /** The first of the month, `YYYY-MM-DD`, as the net worth series dates it. */
  month: string;
  assets: number;
  netWorth: number;
  fxComplete: boolean;
}

export interface TriviaAsset {
  name: string;
  value: number;
}

export interface TriviaFactsInput {
  currency: string;
  months: TriviaNetWorthMonth[];
  /** `null` when the portfolio could not be read: no investment facts. */
  portfolio: PortfolioSummary | null;
  /**
   * The non-investment asset accounts, in `currency`; `null` when any of them
   * is held in another currency and they cannot be ranked.
   */
  otherAssets: TriviaAsset[] | null;
  /**
   * False when an investment account is left out of net worth: the portfolio
   * then holds money the month's assets do not, and is no share of them.
   */
  portfolioInNetWorth: boolean;
}

/** The history a "since then" sentence needs before it says anything. */
const MIN_MONTHS_SINCE_START = 12;
/** A smaller fall than this is noise, not a dip worth a sentence. */
const MIN_DIP_FRACTION = 0.01;

const money = (value: number, currency: string): TriviaFigure => ({
  kind: "money",
  value: roundMoney(value),
  currency,
});
const percent = (value: number): TriviaFigure => ({
  kind: "percent",
  value: roundMoney(value),
});
const month = (value: string): TriviaFigure => ({
  kind: "month",
  value: value.slice(0, 7),
});
const text = (value: string): TriviaFigure => ({ kind: "text", value });

function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

function fact(
  id: TriviaFact["id"],
  topic: TriviaTopic,
  figures: TriviaFigures,
): TriviaFact {
  return { id, topic, figures };
}

function netWorthFacts(input: TriviaFactsInput): TriviaFact[] {
  const { currency } = input;
  const facts: TriviaFact[] = [];
  const complete = input.months.filter((m) => m.fxComplete !== false);
  if (complete.length < 2) return facts;

  // A sentence about "now" needs the newest month, not the newest known one.
  const newest = input.months[input.months.length - 1];
  const latest = newest.fxComplete !== false ? newest : null;

  const first = complete.find((m) => m.netWorth > 0);
  if (
    latest &&
    first &&
    monthsBetween(first.month, latest.month) >= MIN_MONTHS_SINCE_START &&
    latest.netWorth > first.netWorth
  ) {
    facts.push(
      fact("netWorthSinceStart", "netWorth", {
        startMonth: month(first.month),
        startAmount: money(first.netWorth, currency),
        startGain: money(latest.netWorth - first.netWorth, currency),
        startMultiple: {
          kind: "multiple",
          value: roundMoney(latest.netWorth / first.netWorth, 2),
        },
      }),
    );
  }

  let jump: { from: TriviaNetWorthMonth; to: TriviaNetWorthMonth } | null =
    null;
  for (let i = 1; i < complete.length; i++) {
    const [from, to] = [complete[i - 1], complete[i]];
    // From a positive month only: the month a ledger begins is not a jump.
    if (monthsBetween(from.month, to.month) !== 1 || from.netWorth <= 0) {
      continue;
    }
    const rise = to.netWorth - from.netWorth;
    if (rise > 0 && (!jump || rise > jump.to.netWorth - jump.from.netWorth)) {
      jump = { from, to };
    }
  }
  if (jump) {
    facts.push(
      fact("netWorthBiggestJump", "netWorth", {
        jumpMonth: month(jump.to.month),
        jumpPreviousMonth: month(jump.from.month),
        jumpAmount: money(jump.to.netWorth - jump.from.netWorth, currency),
        jumpFrom: money(jump.from.netWorth, currency),
        jumpTo: money(jump.to.netWorth, currency),
      }),
    );
  }

  const peak = complete.reduce((a, b) => (b.netWorth > a.netWorth ? b : a));
  if (latest && peak.netWorth > 0) {
    // Level with an earlier high is still the high point: none is above it.
    if (latest.netWorth >= peak.netWorth) {
      facts.push(
        fact("netWorthAtHighPoint", "netWorth", {
          currentHigh: money(latest.netWorth, currency),
        }),
      );
    } else {
      facts.push(
        fact("netWorthHighPoint", "netWorth", {
          peakAmount: money(peak.netWorth, currency),
          peakMonth: month(peak.month),
          peakBelow: money(peak.netWorth - latest.netWorth, currency),
        }),
      );
    }
  }

  const dip = biggestDip(complete);
  if (dip) {
    const fall = dip.peak.netWorth - dip.trough.netWorth;
    const figures: TriviaFigures = {
      dipFromMonth: month(dip.peak.month),
      dipFromAmount: money(dip.peak.netWorth, currency),
      dipToMonth: month(dip.trough.month),
      dipToAmount: money(dip.trough.netWorth, currency),
      dipAmount: money(fall, currency),
      dipPercent: percent((fall / dip.peak.netWorth) * 100),
    };
    if (dip.recovered) {
      figures.dipRecoveredMonth = month(dip.recovered.month);
    }
    facts.push(
      fact(
        dip.recovered ? "netWorthBiggestDipRecovered" : "netWorthBiggestDip",
        "netWorth",
        figures,
      ),
    );
  }

  if (latest && latest.assets > 0 && input.otherAssets?.length) {
    const largest = input.otherAssets.reduce((a, b) =>
      b.value > a.value ? b : a,
    );
    if (largest.value > 0) {
      facts.push(
        fact("netWorthLargestAsset", "netWorth", {
          assetName: text(largest.name),
          assetValue: money(largest.value, currency),
          assetPercent: percent((largest.value / latest.assets) * 100),
        }),
      );
    }
  }

  return facts;
}

/** The deepest fall from a running high, and the month it was made good, if any. */
function biggestDip(months: TriviaNetWorthMonth[]): {
  peak: TriviaNetWorthMonth;
  trough: TriviaNetWorthMonth;
  recovered: TriviaNetWorthMonth | null;
} | null {
  let runningPeak = months[0];
  let best: {
    peak: TriviaNetWorthMonth;
    trough: TriviaNetWorthMonth;
  } | null = null;
  for (const m of months) {
    if (m.netWorth > runningPeak.netWorth) runningPeak = m;
    const fall = runningPeak.netWorth - m.netWorth;
    if (
      runningPeak.netWorth > 0 &&
      fall / runningPeak.netWorth >= MIN_DIP_FRACTION &&
      (!best || fall > best.peak.netWorth - best.trough.netWorth)
    ) {
      best = { peak: runningPeak, trough: m };
    }
  }
  if (!best) return null;
  const { peak, trough } = best;
  const recovered =
    months.find((m) => m.month > trough.month && m.netWorth >= peak.netWorth) ??
    null;
  return { peak, trough, recovered };
}

/** A security's rows across the accounts holding it, when all of them are priced. */
interface SecurityPosition {
  symbol: string;
  currency: string;
  rows: HoldingWithMarketValue[];
}

function positionsBySecurity(
  holdings: HoldingWithMarketValue[],
): SecurityPosition[] {
  const bySecurity = new Map<string, SecurityPosition>();
  for (const row of holdings) {
    const position = bySecurity.get(row.securityId);
    if (position) {
      position.rows.push(row);
    } else {
      bySecurity.set(row.securityId, {
        symbol: row.symbol,
        currency: row.currencyCode,
        rows: [row],
      });
    }
  }
  return [...bySecurity.values()];
}

function investmentFacts(input: TriviaFactsInput): TriviaFact[] {
  const { currency, portfolio } = input;
  // Every figure below is a share of, or a gain over, the whole portfolio.
  if (
    !portfolio ||
    portfolio.valuationComplete === false ||
    portfolio.totalPortfolioValue <= 0
  ) {
    return [];
  }
  const facts: TriviaFact[] = [];

  const newest = input.months[input.months.length - 1];
  if (
    input.portfolioInNetWorth &&
    newest &&
    newest.fxComplete !== false &&
    newest.assets > 0
  ) {
    facts.push(
      fact("investmentsShareOfAssets", "investments", {
        investmentsValue: money(portfolio.totalPortfolioValue, currency),
        investmentsPercent: percent(
          (portfolio.totalPortfolioValue / newest.assets) * 100,
        ),
      }),
    );
  }

  if (portfolio.gainCostBasis > 0 && portfolio.totalGainLoss !== 0) {
    const gained = portfolio.totalGainLoss > 0;
    facts.push(
      fact(gained ? "investmentsGain" : "investmentsLoss", "investments", {
        gainAmount: money(Math.abs(portfolio.totalGainLoss), currency),
        gainPercent: percent(Math.abs(portfolio.totalGainLossPercent)),
        gainCostBasis: money(portfolio.gainCostBasis, currency),
      }),
    );
  }

  if (portfolio.cagr !== null) {
    facts.push(
      fact("investmentsCagr", "investments", {
        cagrPercent: percent(portfolio.cagr),
      }),
    );
  }

  const accounts = portfolio.holdingsByAccount.filter(
    (a) => a.holdings.length > 0,
  );
  const holdings = accounts.flatMap((a) => a.holdings);
  const positions = positionsBySecurity(holdings);
  const accountName = (accountId: string): string =>
    stripBrokerageSuffix(
      accounts.find((a) => a.accountId === accountId)?.accountName ?? "",
    );

  const biggest = largestPosition(positions);
  if (biggest && portfolio.totalHoldingsValue > 0) {
    facts.push(
      fact("investmentsBiggestHolding", "investments", {
        holdingSymbol: text(biggest.position.symbol),
        holdingValue: money(biggest.value, currency),
        holdingPercent: percent(
          (biggest.value / portfolio.totalHoldingsValue) * 100,
        ),
        holdingAccounts: text(
          [
            ...new Set(
              biggest.position.rows.map((r) => accountName(r.accountId)),
            ),
          ]
            .sort()
            .join(", "),
        ),
      }),
    );
  }

  const best = bestPerformer(positions);
  if (best) {
    facts.push(
      fact("investmentsBestPerformer", "investments", {
        bestSymbol: text(best.symbol),
        bestPercent: percent(best.percent),
        bestCost: money(best.cost, best.currency),
        bestValue: money(best.value, best.currency),
      }),
    );
  }

  const ranked = accounts.flatMap((account) => {
    const inAccount = account.holdings.map((h) => h.marketValueAccountCurrency);
    const inReporting = account.holdings.map(
      (h) => h.marketValueDefaultCurrency,
    );
    if (inAccount.includes(null) || inReporting.includes(null)) return [];
    return [
      {
        name: stripBrokerageSuffix(account.accountName),
        currency: account.currencyCode,
        balance: sumMoney(inAccount as number[]),
        reporting: sumMoney(inReporting as number[]),
      },
    ];
  });

  const foreign = ranked
    .filter((a) => a.currency !== currency && a.balance > 0)
    .sort((a, b) => b.reporting - a.reporting)[0];
  if (foreign) {
    facts.push(
      fact("investmentsForeignAccount", "investments", {
        foreignName: text(foreign.name),
        foreignCurrency: text(foreign.currency),
        foreignBalance: money(foreign.balance, foreign.currency),
        foreignConverted: money(foreign.reporting, currency),
        foreignRate: {
          kind: "rate",
          value: roundFxRate(foreign.reporting / foreign.balance),
        },
      }),
    );
  }

  if (ranked.length >= 2 && ranked.length === accounts.length) {
    const largest = [...ranked].sort((a, b) => b.reporting - a.reporting)[0];
    facts.push(
      fact("investmentsLargestAccount", "investments", {
        largestName: text(largest.name),
        largestValue: money(largest.reporting, currency),
      }),
    );
  }

  return facts;
}

function largestPosition(
  positions: SecurityPosition[],
): { position: SecurityPosition; value: number } | null {
  let largest: { position: SecurityPosition; value: number } | null = null;
  for (const position of positions) {
    const values = position.rows.map((r) => r.marketValueDefaultCurrency);
    if (values.includes(null)) continue;
    const value = sumMoney(values as number[]);
    if (value > 0 && (!largest || value > largest.value)) {
      largest = { position, value };
    }
  }
  return largest;
}

/** Measured in each security's own currency, so a rate never moves the ranking. */
function bestPerformer(positions: SecurityPosition[]): {
  symbol: string;
  currency: string;
  cost: number;
  value: number;
  percent: number;
} | null {
  // With one security there is nothing to be best among.
  if (positions.length < 2) return null;
  let best: ReturnType<typeof bestPerformer> = null;
  for (const { symbol, currency, rows } of positions) {
    const marketValues = rows.map((r) => r.marketValue);
    if (marketValues.includes(null)) continue;
    const value = sumMoney(marketValues as number[]);
    const cost = sumMoney(rows.map((r) => r.costBasis));
    if (cost <= 0) continue;
    const pct = ((value - cost) / cost) * 100;
    if (pct > 0 && (!best || pct > best.percent)) {
      best = { symbol, currency, cost, value, percent: pct };
    }
  }
  return best;
}

/**
 * Everything worth saying about the reader's money today. A fact exists only
 * when every figure in it is known: a month that did not fully convert and a
 * valuation short of a price or a rate produce no sentence, rather than a
 * sentence quoting a subtotal.
 */
export function buildTriviaFacts(input: TriviaFactsInput): TriviaFact[] {
  return [...netWorthFacts(input), ...investmentFacts(input)];
}
