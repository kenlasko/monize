export interface DemoSecurity {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
  currency: string;
  accountKey: string;
  quantity: number;
  averageCost: number;
  basePrice: number; // starting price 12 months ago
  currentPrice: number; // approximate current market price
  dailyVolatility: number; // daily price volatility (e.g., 0.01 = 1%)
}

export const demoSecurities: DemoSecurity[] = [
  {
    symbol: "XIU",
    name: "iShares S&P/TSX 60 Index ETF",
    type: "ETF",
    exchange: "TSX",
    currency: "CAD",
    accountKey: "rrsp",
    quantity: 150,
    averageCost: 41.0,
    basePrice: 43.0,
    currentPrice: 48.5,
    dailyVolatility: 0.008,
  },
  {
    symbol: "VCN",
    name: "Vanguard FTSE Canada All Cap Index ETF",
    type: "ETF",
    exchange: "TSX",
    currency: "CAD",
    accountKey: "rrsp",
    quantity: 200,
    averageCost: 56.0,
    basePrice: 59.0,
    currentPrice: 67.0,
    dailyVolatility: 0.008,
  },
  {
    symbol: "XAW",
    name: "iShares Core MSCI All Country World ex Canada",
    type: "ETF",
    exchange: "TSX",
    currency: "CAD",
    accountKey: "tfsa",
    quantity: 250,
    averageCost: 44.0,
    basePrice: 46.0,
    currentPrice: 52.5,
    dailyVolatility: 0.009,
  },
  {
    symbol: "ZAG",
    name: "BMO Aggregate Bond Index ETF",
    type: "ETF",
    exchange: "TSX",
    currency: "CAD",
    accountKey: "tfsa",
    quantity: 100,
    averageCost: 13.5,
    basePrice: 13.5,
    currentPrice: 14.0,
    dailyVolatility: 0.003,
  },
  {
    symbol: "VFV",
    name: "Vanguard S&P 500 Index ETF",
    type: "ETF",
    exchange: "TSX",
    currency: "CAD",
    accountKey: "tfsa",
    quantity: 80,
    averageCost: 135.0,
    basePrice: 143.0,
    currentPrice: 165.0,
    dailyVolatility: 0.01,
  },
  {
    symbol: "AAPL",
    name: "Apple Inc.",
    type: "STOCK",
    exchange: "NASDAQ",
    currency: "USD",
    accountKey: "us_stocks",
    quantity: 15,
    averageCost: 205.0,
    basePrice: 225.0,
    currentPrice: 255.0,
    dailyVolatility: 0.014,
  },
  {
    symbol: "MSFT",
    name: "Microsoft Corporation",
    type: "STOCK",
    exchange: "NASDAQ",
    currency: "USD",
    accountKey: "us_stocks",
    quantity: 10,
    averageCost: 375.0,
    basePrice: 410.0,
    currentPrice: 401.0,
    dailyVolatility: 0.013,
  },
  {
    symbol: "VOO",
    name: "Vanguard S&P 500 ETF",
    type: "ETF",
    exchange: "NYSE",
    currency: "USD",
    accountKey: "us_stocks",
    quantity: 8,
    averageCost: 510.0,
    basePrice: 545.0,
    currentPrice: 627.0,
    dailyVolatility: 0.01,
  },
];

/** Seeded random number generator for deterministic price history */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

/**
 * Generate realistic price history for a security over the past year.
 * Uses a Brownian bridge: starts at basePrice, ends near currentPrice,
 * with per-security volatility and a seeded PRNG for deterministic results.
 */
export function generatePriceHistory(
  security: DemoSecurity,
  referenceDate: Date,
  months: number,
): { date: string; close: number }[] {
  const prices: { date: string; close: number }[] = [];
  const startDate = new Date(referenceDate);
  startDate.setMonth(startDate.getMonth() - months);

  // Use symbol hash as seed for per-security determinism
  let seed = 0;
  for (let i = 0; i < security.symbol.length; i++) {
    seed = seed * 31 + security.symbol.charCodeAt(i);
  }
  const rand = seededRandom(seed);

  // Count trading days first
  const tradingDays: Date[] = [];
  const counter = new Date(startDate);
  while (counter <= referenceDate) {
    const dow = counter.getDay();
    if (dow !== 0 && dow !== 6) {
      tradingDays.push(new Date(counter));
    }
    counter.setDate(counter.getDate() + 1);
  }

  const totalDays = tradingDays.length;
  if (totalDays === 0) return prices;

  // Brownian bridge: interpolate between start and end with noise
  // log(endPrice/startPrice) gives us the total log-return
  const logReturn = Math.log(security.currentPrice / security.basePrice);

  // Generate cumulative noise path
  const noise: number[] = [0];
  for (let i = 1; i < totalDays; i++) {
    const z = (rand() + rand() + rand() - 1.5) * 1.414; // approx normal
    noise.push(noise[i - 1] + z * security.dailyVolatility);
  }

  // Bridge correction: adjust noise so it ends at 0
  const finalNoise = noise[totalDays - 1];
  for (let i = 0; i < totalDays; i++) {
    const t = i / (totalDays - 1);
    noise[i] = noise[i] - t * finalNoise;
  }

  // Generate prices along the bridge
  for (let i = 0; i < totalDays; i++) {
    const t = i / (totalDays - 1);
    const logPrice = Math.log(security.basePrice) + t * logReturn + noise[i];
    const price = Math.round(Math.exp(logPrice) * 100) / 100;

    prices.push({
      date: tradingDays[i].toISOString().split("T")[0],
      close: price,
    });
  }

  return prices;
}
