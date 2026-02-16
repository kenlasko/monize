export interface DemoAccount {
  key: string;
  type: string;
  name: string;
  currency: string;
  openingBalance: number;
  creditLimit?: number;
  interestRate?: number;
  description: string;
  institution?: string;
  isFavourite?: boolean;
  // Debt payment fields
  paymentAmount?: number;
  paymentFrequency?: string;
  // Mortgage-specific
  isCanadianMortgage?: boolean;
  isVariableRate?: boolean;
  termMonths?: number;
  amortizationMonths?: number;
  originalPrincipal?: number;
}

export const demoAccounts: DemoAccount[] = [
  {
    key: "chequing",
    type: "CHEQUING",
    name: "Primary Chequing",
    currency: "CAD",
    openingBalance: 5420.5,
    description: "Main everyday banking account",
    institution: "TD Canada Trust",
    isFavourite: true,
  },
  {
    key: "savings",
    type: "SAVINGS",
    name: "Emergency Fund",
    currency: "CAD",
    openingBalance: 15000.0,
    interestRate: 4.5,
    description: "6 months of expenses",
    institution: "EQ Bank",
  },
  {
    key: "vacation",
    type: "SAVINGS",
    name: "Vacation Fund",
    currency: "CAD",
    openingBalance: 3200.0,
    interestRate: 3.25,
    description: "Travel savings goal",
    institution: "EQ Bank",
  },
  {
    key: "visa",
    type: "CREDIT_CARD",
    name: "Visa Rewards",
    currency: "CAD",
    openingBalance: -1250.75,
    creditLimit: 10000,
    interestRate: 19.99,
    description: "Cashback credit card - 2% on groceries, 1% everything else",
    institution: "TD Canada Trust",
    isFavourite: true,
  },
  {
    key: "mastercard",
    type: "CREDIT_CARD",
    name: "Mastercard",
    currency: "CAD",
    openingBalance: -487.3,
    creditLimit: 5000,
    interestRate: 21.99,
    description: "Travel rewards card",
    institution: "CIBC",
  },
  {
    key: "mortgage",
    type: "MORTGAGE",
    name: "Home Mortgage",
    currency: "CAD",
    openingBalance: -385000.0,
    interestRate: 5.24,
    paymentAmount: 2370.0,
    paymentFrequency: "MONTHLY",
    description: "Primary residence - 25 year amortization",
    institution: "Scotiabank",
    isCanadianMortgage: true,
    isVariableRate: false,
    termMonths: 60,
    amortizationMonths: 300,
    originalPrincipal: 400000.0,
  },
  {
    key: "rrsp",
    type: "INVESTMENT",
    name: "RRSP - Retirement",
    currency: "CAD",
    openingBalance: 42500.0,
    description: "Long-term retirement investments",
    institution: "Questrade",
  },
  {
    key: "tfsa",
    type: "INVESTMENT",
    name: "TFSA - Tax Free",
    currency: "CAD",
    openingBalance: 28750.0,
    description: "Tax-free investment account",
    institution: "Questrade",
  },
  {
    key: "us_stocks",
    type: "INVESTMENT",
    name: "US Stock Portfolio",
    currency: "USD",
    openingBalance: 12300.0,
    description: "Individual stocks and ETFs",
    institution: "Questrade",
  },
  {
    key: "cash",
    type: "CASH",
    name: "Wallet Cash",
    currency: "CAD",
    openingBalance: 150.0,
    description: "Cash on hand",
  },
  {
    key: "home",
    type: "ASSET",
    name: "Home (Primary Residence)",
    currency: "CAD",
    openingBalance: 650000.0,
    description: "Estimated market value of primary residence",
  },
  {
    key: "vehicle",
    type: "ASSET",
    name: "Vehicle",
    currency: "CAD",
    openingBalance: 28000.0,
    description: "2022 Honda CR-V",
  },
];
