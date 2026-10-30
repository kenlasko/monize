import type { ApiClient } from '../helpers/api';
import { addDays, todayYmd } from './settings';
import {
  has,
  indexByName,
  need,
  security,
  type AccountRow,
  type Lookups,
  type Named,
  type TagRow,
} from './seed-lookup';
import { LISBON_TAG } from './seed-tags-rules';

// Loans, a mortgage with history, a foreign-currency purchase, schedules and
// the other records the pages need in order to show their less common panels.

const cents = (value: number) => Math.round(value * 100) / 100;

const pad = (n: number) => String(n).padStart(2, '0');

/** The first day of the month `offset` months from `from` (negative = earlier). */
export function firstOfMonth(from: string, offset: number): string {
  const [y, m] = from.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
}

/** The next `day` of a month that is not before `from`. */
function nextDayOfMonth(from: string, day: number): string {
  const [y, m, d] = from.split('-').map(Number);
  const month = d <= day ? 0 : 1;
  const date = new Date(Date.UTC(y, m - 1 + month, day));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

interface PayeeRow extends Named {
  address: string | null;
  phone: string | null;
  email: string | null;
}

/** The payee the payee page is photographed for gets a postal address, a phone and an email. */
export async function seedPayeeContact(api: ApiClient, lookups: Lookups): Promise<void> {
  const payee = need(lookups.payees, 'Tim Hortons', 'payee');
  const current = await api.get<PayeeRow>(`/payees/${payee.id}`);
  if (current.address && current.phone && current.email) return;
  await api.patch(`/payees/${payee.id}`, {
    address: '220 Bay Street, Toronto, ON M5J 2W4',
    phone: '+1 416-555-0142',
    email: 'guestexperience@timhortons.example',
  });
}

interface AccountDetail extends AccountRow {
  fxFeePercent: number | null;
  linkedLoanAccountId: string | null;
  statementDueDay: number | null;
  statementSettlementDay: number | null;
}

/**
 * A hotel in Lisbon paid for in euros on the Visa, with the rate typed in (no
 * rate provider is reachable from every machine) and the card's foreign
 * transaction fee folded into the amount, the way the transaction form does.
 */
export async function seedForeignTransaction(
  api: ApiClient,
  lookups: Lookups,
  tags: Map<string, TagRow>,
): Promise<string> {
  const visa = need(lookups.accounts, 'Visa Rewards', 'account');
  const feePercent = 2.5;
  const detail = await api.get<AccountDetail>(`/accounts/${visa.id}`);
  if (detail.fxFeePercent === null || Number(detail.fxFeePercent) !== feePercent) {
    await api.patch(`/accounts/${visa.id}`, { fxFeePercent: feePercent });
  }

  const payeeName = 'Hotel Avenida Palace';
  const found = await api.get<{ data: { id: string }[] }>(
    `/transactions?search=${encodeURIComponent(payeeName)}&accountIds=${visa.id}&limit=5`,
  );
  if (found.data.length > 0) return found.data[0].id;

  const airbnb = await api.get<{ data: { transactionDate: string }[] }>(
    `/transactions?search=Airbnb&accountIds=${visa.id}&limit=1`,
  );
  const date = addDays(airbnb.data[0]?.transactionDate ?? addDays(todayYmd(), -80), 4);

  const rate = 1.618;
  const original = 412.5;
  const base = cents(original * rate);
  const fee = cents((base * feePercent) / 100);
  const created = await api.post<{ id: string }>('/transactions', {
    accountId: visa.id,
    transactionDate: date,
    payeeName,
    categoryId: need(lookups.categories, 'Travel', 'category').id,
    amount: -cents(base + fee),
    currencyCode: visa.currencyCode,
    exchangeRate: rate,
    originalAmount: -original,
    originalCurrencyCode: 'EUR',
    description: 'Three nights in Lisbon, breakfast included',
    tagIds: [need(tags, LISBON_TAG, 'tag').id],
  });
  return created.id;
}

/** A billing cycle on the Visa (closes on the 25th, due on the 15th), so its page shows the current statement. */
export async function seedCardStatement(api: ApiClient, lookups: Lookups): Promise<void> {
  const visa = need(lookups.accounts, 'Visa Rewards', 'account');
  const detail = await api.get<AccountDetail>(`/accounts/${visa.id}`);
  if (detail.statementSettlementDay === 25 && detail.statementDueDay === 15) return;
  await api.patch(`/accounts/${visa.id}`, { statementSettlementDay: 25, statementDueDay: 15 });
}

interface RateChangeRow {
  source: string;
}

/** A rate change on the mortgage and two overpayment scenarios to compare. */
export async function seedMortgageHistory(api: ApiClient, lookups: Lookups): Promise<void> {
  const mortgage = need(lookups.accounts, 'Home Mortgage', 'account');
  const today = todayYmd();

  const changes = await api.get<RateChangeRow[]>(`/accounts/${mortgage.id}/rate-changes`);
  if (!changes.some((c) => c.source === 'manual')) {
    await api.post(`/accounts/${mortgage.id}/rate-changes`, {
      effectiveDate: firstOfMonth(today, -3),
      annualRate: 4.89,
      note: 'Lowered at the lender mid-term review',
    });
  }

  const scenarios = indexByName(await api.get<Named[]>(`/accounts/${mortgage.id}/loan-scenarios`));
  const extraFrom = firstOfMonth(today, 1);
  if (!has(scenarios, '+$200 a month')) {
    await api.post(`/accounts/${mortgage.id}/loan-scenarios`, {
      name: '+$200 a month',
      recurringExtraAmount: 200,
      recurringExtraMode: 'SHORTEN_TERM',
      recurringExtraFrequency: 'MONTHLY',
      recurringExtraStartDate: extraFrom,
    });
  }
  if (!has(scenarios, '$10k lump sum every January')) {
    const nextJanuary = `${Number(today.slice(0, 4)) + 1}-01-15`;
    await api.post(`/accounts/${mortgage.id}/loan-scenarios`, {
      name: '$10k lump sum every January',
      lumpSums: [0, 1, 2, 3].map((years) => ({
        date: `${Number(nextJanuary.slice(0, 4)) + years}-01-15`,
        amount: 10000,
        mode: 'SHORTEN_TERM',
      })),
    });
  }
}

type InstitutionRow = Named;

/**
 * A car loan paid from the chequing account, linked to the Vehicle so that
 * page shows equity, and a small line of credit.
 */
export async function seedLoans(api: ApiClient): Promise<void> {
  // The demo data books mortgage interest only; the car loan's payment schedule
  // needs an expense category of its own to book interest to.
  if (!has((await loadAccountsAndInstitutions(api)).categories, 'Loan Interest')) {
    await api.post('/categories', { name: 'Loan Interest', isIncome: false });
  }
  let lookups = await loadAccountsAndInstitutions(api);
  const { institutions } = lookups;
  const today = todayYmd();

  if (!has(lookups.accounts, 'Car Loan')) {
    await api.post('/accounts', {
      accountType: 'LOAN',
      name: 'Car Loan',
      description: 'Financing for the 2022 Honda CR-V',
      currencyCode: 'CAD',
      institutionId: need(institutions, 'TD Canada Trust', 'institution').id,
      openingBalance: -21400,
      interestRate: 6.49,
      paymentAmount: 656,
      paymentFrequency: 'MONTHLY',
      paymentStartDate: nextDayOfMonth(today, 15),
      sourceAccountId: need(lookups.accounts, 'Primary Chequing', 'account').id,
      interestCategoryId: need(lookups.categories, 'Loan Interest', 'category').id,
    });
  }

  if (!has(lookups.accounts, 'Home Equity Line of Credit')) {
    await api.post('/accounts', {
      accountType: 'LINE_OF_CREDIT',
      name: 'Home Equity Line of Credit',
      description: 'Revolving credit secured on the house',
      currencyCode: 'CAD',
      institutionId: need(institutions, 'Scotiabank', 'institution').id,
      openingBalance: -4200,
      creditLimit: 25000,
      interestRate: 7.2,
    });
  }

  lookups = await loadAccountsAndInstitutions(api);
  const car = need(lookups.accounts, 'Car Loan', 'account');
  const vehicle = need(lookups.accounts, 'Vehicle', 'account');
  const detail = await api.get<AccountDetail>(`/accounts/${vehicle.id}`);
  if (detail.linkedLoanAccountId !== car.id) {
    await api.patch(`/accounts/${vehicle.id}`, { linkedLoanAccountId: car.id });
  }
}

// Categories too: a loan's payment schedule names the interest category it books to.
async function loadAccountsAndInstitutions(api: ApiClient) {
  const [accounts, institutions, categories] = await Promise.all([
    api.get<AccountRow[]>('/accounts'),
    api.get<InstitutionRow[]>('/institutions'),
    api.get<Named[]>('/categories'),
  ]);
  return {
    accounts: indexByName(accounts),
    institutions: indexByName(institutions),
    categories: indexByName(categories),
  };
}

/**
 * A monthly share purchase and a bill on a four-week cadence. The purchase is
 * of a fund priced in the reporting currency: a schedule in another currency
 * would leave the bills page's monthly net unknown wherever no exchange rate is
 * stored, which is the case on an instance that cannot reach a rate provider.
 */
export async function seedSchedules(api: ApiClient, lookups: Lookups): Promise<void> {
  const existing = indexByName(await api.get<Named[]>('/scheduled-transactions'));
  const today = todayYmd();

  if (!has(existing, 'Monthly VFV purchase')) {
    const vfv = security(lookups, 'VFV');
    const prices = await api.get<{ closePrice: string | number }[]>(`/securities/${vfv.id}/prices?limit=1`);
    const price = prices.length > 0 ? cents(Number(prices[0].closePrice)) : 165;
    const quantity = 5;
    await api.post('/scheduled-transactions', {
      accountId: need(lookups.accounts, 'TFSA - Tax Free - Brokerage', 'account').id,
      name: 'Monthly VFV purchase',
      amount: -cents(quantity * price),
      currencyCode: 'CAD',
      frequency: 'MONTHLY',
      nextDueDate: nextDayOfMonth(today, 10),
      isActive: true,
      autoPost: false,
      isInvestment: true,
      investmentAction: 'BUY',
      investmentSecurityId: vfv.id,
      investmentFundingAccountId: need(lookups.accounts, 'TFSA - Tax Free - Cash', 'account').id,
      investmentQuantity: quantity,
      investmentPrice: price,
    });
  }

  if (!has(existing, 'Massage therapy')) {
    await api.post('/scheduled-transactions', {
      accountId: need(lookups.accounts, 'Primary Chequing', 'account').id,
      name: 'Massage therapy',
      payeeName: 'Zen Wellness Studio',
      categoryId: need(lookups.categories, 'Spa', 'category').id,
      amount: -95,
      currencyCode: 'CAD',
      frequency: 'EVERY4WEEKS',
      nextDueDate: addDays(today, 8),
      isActive: true,
      autoPost: false,
    });
  }
}
