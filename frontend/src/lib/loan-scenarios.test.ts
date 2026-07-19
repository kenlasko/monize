import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loanScenariosApi, scenarioToPlan, planToScenarioData } from './loan-scenarios';
import apiClient from './api';
import { invalidateCache } from './apiCache';
import { LoanScenario } from '@/types/loan-scenario';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./apiCache', () => ({
  dedupe: vi.fn((_key: string, fn: () => unknown) => fn()),
  invalidateCache: vi.fn(),
}));

const accountId = 'account-1';

function makeScenario(overrides: Partial<LoanScenario> = {}): LoanScenario {
  return {
    id: 'scenario-1',
    userId: 'user-1',
    accountId,
    name: 'Extra 200',
    recurringExtraAmount: 200,
    recurringExtraMode: null,
    recurringExtraFrequency: null,
    recurringExtraStartDate: null,
    recurringExtraEndDate: null,
    targetMonthlyPayment: null,
    targetMonthlyPaymentMode: null,
    targetMonthlyPaymentStartDate: null,
    targetMonthlyPaymentEndDate: null,
    lumpSums: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loanScenariosApi', () => {
  it('gets all scenarios for an account', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [makeScenario()] });

    const result = await loanScenariosApi.getAll(accountId);

    expect(apiClient.get).toHaveBeenCalledWith('/accounts/account-1/loan-scenarios');
    expect(result).toHaveLength(1);
  });

  it('creates a scenario and invalidates the cache', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: makeScenario() });

    await loanScenariosApi.create(accountId, { name: 'Extra 200' });

    expect(apiClient.post).toHaveBeenCalledWith('/accounts/account-1/loan-scenarios', {
      name: 'Extra 200',
    });
    expect(invalidateCache).toHaveBeenCalledWith('loan-scenarios:account-1');
  });

  it('updates a scenario and invalidates the cache', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: makeScenario() });

    await loanScenariosApi.update(accountId, 'scenario-1', { name: 'Renamed' });

    expect(apiClient.patch).toHaveBeenCalledWith(
      '/accounts/account-1/loan-scenarios/scenario-1',
      { name: 'Renamed' },
    );
    expect(invalidateCache).toHaveBeenCalledWith('loan-scenarios:account-1');
  });

  it('deletes a scenario and invalidates the cache', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});

    await loanScenariosApi.delete(accountId, 'scenario-1');

    expect(apiClient.delete).toHaveBeenCalledWith(
      '/accounts/account-1/loan-scenarios/scenario-1',
    );
    expect(invalidateCache).toHaveBeenCalledWith('loan-scenarios:account-1');
  });
});

describe('scenarioToPlan', () => {
  it('maps recurring extra with its date window', () => {
    const plan = scenarioToPlan(
      makeScenario({
        recurringExtraStartDate: '2026-01-01',
        recurringExtraEndDate: '2027-01-01',
      }),
    );

    expect(plan).toEqual({
      recurringExtra: { amount: 200, startDate: '2026-01-01', endDate: '2027-01-01' },
    });
  });

  it('maps lump sums', () => {
    const plan = scenarioToPlan(
      makeScenario({
        recurringExtraAmount: null,
        lumpSums: [{ date: '2026-06-01', amount: 5000 }],
      }),
    );

    expect(plan).toEqual({ lumpSums: [{ date: '2026-06-01', amount: 5000 }] });
  });

  it('returns null for an empty scenario', () => {
    expect(scenarioToPlan(makeScenario({ recurringExtraAmount: null }))).toBeNull();
  });
});

describe('planToScenarioData', () => {
  it('flattens a full plan into the API payload', () => {
    expect(
      planToScenarioData(
        {
          recurringExtra: { amount: 300, mode: 'LOWER_INSTALLMENT', startDate: '2026-01-01' },
          lumpSums: [{ date: '2026-06-01', amount: 5000, mode: 'SHORTEN_TERM' }],
        },
        'Aggressive',
      ),
    ).toEqual({
      name: 'Aggressive',
      recurringExtraAmount: 300,
      recurringExtraMode: 'LOWER_INSTALLMENT',
      recurringExtraFrequency: null,
      recurringExtraStartDate: '2026-01-01',
      recurringExtraEndDate: null,
      targetMonthlyPayment: null,
      targetMonthlyPaymentMode: null,
      targetMonthlyPaymentStartDate: null,
      targetMonthlyPaymentEndDate: null,
      lumpSums: [{ date: '2026-06-01', amount: 5000, mode: 'SHORTEN_TERM' }],
    });
  });

  it('produces nulls and an empty list for a null plan', () => {
    expect(planToScenarioData(null, 'Empty')).toEqual({
      name: 'Empty',
      recurringExtraAmount: null,
      recurringExtraMode: null,
      recurringExtraFrequency: null,
      recurringExtraStartDate: null,
      recurringExtraEndDate: null,
      targetMonthlyPayment: null,
      targetMonthlyPaymentMode: null,
      targetMonthlyPaymentStartDate: null,
      targetMonthlyPaymentEndDate: null,
      lumpSums: [],
    });
  });

  it('maps a budget scenario to the plan and back', () => {
    const scenario = makeScenario({
      recurringExtraAmount: null,
      targetMonthlyPayment: 4000,
      targetMonthlyPaymentMode: 'LOWER_INSTALLMENT',
      targetMonthlyPaymentStartDate: '2026-08-01',
    });
    const plan = scenarioToPlan(scenario);
    expect(plan).toEqual({
      targetMonthlyPayment: 4000,
      targetMonthlyPaymentMode: 'LOWER_INSTALLMENT',
      targetMonthlyPaymentStart: '2026-08-01',
    });
    expect(planToScenarioData(plan, 'Budget')).toMatchObject({
      targetMonthlyPayment: 4000,
      targetMonthlyPaymentMode: 'LOWER_INSTALLMENT',
      targetMonthlyPaymentStartDate: '2026-08-01',
      recurringExtraAmount: null,
      lumpSums: [],
    });
  });
});
