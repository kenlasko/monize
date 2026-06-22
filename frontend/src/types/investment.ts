import { Tag } from './tag';

export type InvestmentAction =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'CAPITAL_GAIN'
  | 'SPLIT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'REINVEST'
  | 'ADD_SHARES'
  | 'REMOVE_SHARES';

export type QuoteProviderName = 'yahoo' | 'msn';

export interface Security {
  id: string;
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  description?: string | null;
  tags?: Tag[];
  isActive: boolean;
  isFavourite: boolean;
  skipPriceUpdates: boolean;
  sector: string | null;
  industry: string | null;
  sectorWeightings: { sector: string; weight: number }[] | null;
  /** Manual ETF/fund country breakdown; weight is a decimal 0-1 (like sectorWeightings). */
  countryWeightings: { name: string; weight: number }[] | null;
  quoteProvider: QuoteProviderName | null;
  msnInstrumentId: string | null;
  /** Source of the most recent price row for this security (e.g. "yahoo_finance", "msn_finance", "manual"), or null if no prices exist. */
  lastPriceSource?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SectorWeightingItem {
  sector: string;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

export interface SectorWeightingResult {
  items: SectorWeightingItem[];
  totalPortfolioValue: number;
  totalDirectValue: number;
  totalEtfValue: number;
  unclassifiedValue: number;
}

export interface CountryWeightingItem {
  country: string;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

export interface CountryWeightingResult {
  items: CountryWeightingItem[];
  totalPortfolioValue: number;
  totalDirectValue: number;
  totalEtfValue: number;
  unclassifiedValue: number;
}

export interface Holding {
  id: string;
  accountId: string;
  securityId: string;
  quantity: number;
  averageCost: number | null;
  security: Security;
  createdAt: string;
  updatedAt: string;
}

export interface HoldingWithMarketValue {
  id: string;
  accountId: string;
  securityId: string;
  symbol: string;
  name: string;
  securityType: string;
  currencyCode: string;
  quantity: number;
  averageCost: number;
  /** Cost basis in the security's native currency. */
  costBasis: number;
  /**
   * Cost basis in the holding account's currency, calculated using the
   * historical exchange rates stored on the original BUY transactions.
   */
  costBasisAccountCurrency: number;
  currentPrice: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

export interface AccountHoldings {
  accountId: string;
  accountName: string;
  currencyCode: string;
  cashAccountId: string | null;
  cashBalance: number;
  holdings: HoldingWithMarketValue[];
  totalCostBasis: number;
  totalMarketValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  netInvested: number;
}

export interface PortfolioSummary {
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalNetInvested: number;
  totalPortfolioValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  timeWeightedReturn: number | null;
  cagr: number | null;
  holdings: HoldingWithMarketValue[];
  holdingsByAccount: AccountHoldings[];
  allocation: AllocationItem[];  // Included to avoid duplicate API call
}

export interface AllocationItem {
  name: string;
  symbol: string | null;
  type: 'cash' | 'security' | 'tag' | 'untagged';
  value: number;
  percentage: number;
  color?: string;
  currencyCode?: string;
}

export interface AssetAllocation {
  allocation: AllocationItem[];
  totalValue: number;
}

export interface InvestmentTransaction {
  id: string;
  accountId: string;
  securityId: string | null;
  fundingAccountId: string | null;
  action: InvestmentAction;
  transactionDate: string;
  quantity: number | null;
  price: number | null;
  commission: number | null;
  totalAmount: number;
  exchangeRate: number;
  description: string | null;
  // Set on security-transfer legs; points at the paired TRANSFER_IN/OUT leg.
  linkedTransactionId: string | null;
  security: Security | null;
  fundingAccount: {
    id: string;
    name: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityHistoryAccount {
  accountId: string;
  accountName: string;
  isClosed: boolean;
  currentQuantity: number;
}

export interface SecurityHistoryTransaction {
  id: string;
  transactionDate: string;
  accountId: string;
  accountName: string;
  action: InvestmentAction;
  quantity: number | null;
  price: number | null;
  commission: number;
  totalAmount: number;
  description: string | null;
  runningQuantityAccount: number;
  runningQuantityAll: number;
}

export interface SecurityTransactionHistory {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  accounts: SecurityHistoryAccount[];
  transactions: SecurityHistoryTransaction[];
  currentQuantityAll: number;
}

export interface CreateInvestmentTransactionData {
  accountId: string;
  securityId?: string;
  fundingAccountId?: string;
  action: InvestmentAction;
  transactionDate: string;
  quantity?: number;
  price?: number;
  commission?: number;
  exchangeRate?: number;
  description?: string;
}

export interface TopMover {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  currentPrice: number;
  previousPrice: number;
  dailyChange: number;
  dailyChangePercent: number;
  marketValue: number | null;
}

export interface SecurityPrice {
  id: number;
  securityId: string;
  priceDate: string;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  closePrice: number;
  volume: number | null;
  source: string | null;
  createdAt: string;
}

export interface CreateSecurityPriceData {
  priceDate: string;
  closePrice: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  volume?: number;
}

export interface CreateSecurityData {
  symbol: string;
  name: string;
  securityType?: string;
  exchange?: string;
  currencyCode: string;
  description?: string;
  tagIds?: string[];
  quoteProvider?: QuoteProviderName | null;
  msnInstrumentId?: string;
  isFavourite?: boolean;
  /** Manual ETF/fund country breakdown; weight is a decimal 0-1 (like sectorWeightings). */
  countryWeightings?: { name: string; weight: number }[];
}

/** A favourite security decorated with its latest price and daily change. */
export interface FavouriteSecurityQuote {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  currentPrice: number | null;
  previousPrice: number | null;
  dailyChange: number;
  dailyChangePercent: number;
}

export interface InvestmentTransactionPaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedInvestmentTransactions {
  data: InvestmentTransaction[];
  pagination: InvestmentTransactionPaginationInfo;
}

export interface RealizedGainEntry {
  transactionId: string;
  transactionDate: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  quantity: number;
  price: number;
  commission: number;
  proceeds: number;
  costBasis: number;
  realizedGain: number;
}

/**
 * Per-(account, security, month) capital gain entry combining realized SELL
 * gains with the unrealized mark-to-market change on the position. All values
 * are in the holding account's currency.
 */
export interface CapitalGainEntry {
  month: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  startQuantity: number;
  endQuantity: number;
  startValue: number;
  endValue: number;
  buys: number;
  sells: number;
  realizedGain: number;
  unrealizedGain: number;
  totalCapitalGain: number;
}
