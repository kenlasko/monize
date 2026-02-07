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

export interface Security {
  id: string;
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isActive: boolean;
  skipPriceUpdates: boolean;
  createdAt: string;
  updatedAt: string;
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
  costBasis: number;
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
}

export interface PortfolioSummary {
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalPortfolioValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  holdings: HoldingWithMarketValue[];
  holdingsByAccount: AccountHoldings[];
  allocation: AllocationItem[];  // Included to avoid duplicate API call
}

export interface AllocationItem {
  name: string;
  symbol: string | null;
  type: 'cash' | 'security';
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
  description: string | null;
  security: Security | null;
  fundingAccount: {
    id: string;
    name: string;
  } | null;
  createdAt: string;
  updatedAt: string;
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
  description?: string;
}

export interface TopMover {
  securityId: string;
  symbol: string;
  name: string;
  currentPrice: number;
  previousPrice: number;
  dailyChange: number;
  dailyChangePercent: number;
  marketValue: number | null;
}

export interface CreateSecurityData {
  symbol: string;
  name: string;
  securityType?: string;
  exchange?: string;
  currencyCode: string;
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
