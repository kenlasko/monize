export type AccountType =
  | 'CHEQUING'
  | 'SAVINGS'
  | 'CREDIT_CARD'
  | 'LOAN'
  | 'MORTGAGE'
  | 'RRSP'
  | 'TFSA'
  | 'RESP'
  | 'INVESTMENT'
  | 'CASH'
  | 'LINE_OF_CREDIT'
  | 'OTHER';

export interface Account {
  id: string;
  userId: string;
  accountType: AccountType;
  name: string;
  description: string | null;
  currencyCode: string;
  accountNumber: string | null;
  institution: string | null;
  openingBalance: number;
  currentBalance: number;
  creditLimit: number | null;
  interestRate: number | null;
  isClosed: boolean;
  closedDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountData {
  accountType: AccountType;
  name: string;
  description?: string;
  currencyCode: string;
  accountNumber?: string;
  institution?: string;
  openingBalance?: number;
  creditLimit?: number;
  interestRate?: number;
}

export interface UpdateAccountData extends Partial<CreateAccountData> {}

export interface AccountSummary {
  totalAccounts: number;
  totalBalance: number;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}
