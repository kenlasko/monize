import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@/test/render';
import { RuleApplications, transactionHref } from './RuleApplications';
import { testOptions } from './rule-test-harness';
import { ACCOUNT_ID, COFFEE_ID, PAYEE_ID, TAG_ID, makeApplication } from './rules-test-fixtures';
import { usePreferencesStore } from '@/store/preferencesStore';

const api = vi.hoisted(() => ({ getApplications: vi.fn() }));

vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: api }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

async function renderApplications() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RuleApplications ruleId="rule-1" options={testOptions} />);
  });
  return result;
}

/**
 * The time of an application is an instant, shown in the timezone the person
 * chose in Preferences (`formatDateTime`), and only falls back to the
 * browser's when they chose none. The test names its own zone, so what it
 * expects does not depend on the `TZ` of the process that runs it.
 */
function setPreferredTimezone(timezone: string) {
  usePreferencesStore.setState({
    preferences: { timezone, timeFormat: '24h', dateFormat: 'MM/DD/YYYY' },
    isLoaded: true,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPreferredTimezone('UTC');
});

afterEach(() => {
  // Unmount before the store is reset, or the mounted table re-renders outside act().
  cleanup();
  usePreferencesStore.setState({ preferences: null, isLoaded: false } as never);
});

describe('RuleApplications: a structural application', () => {
  it('reads a written transfer and split in the past tense, naming the accounts from the pickers', async () => {
    api.getApplications.mockResolvedValue([
      makeApplication({
        id: 'app-t',
        changes: { structure: { before: null, after: { kind: 'transfer', accountId: ACCOUNT_ID, clearCategory: true } } },
      }),
      makeApplication({
        id: 'app-s',
        transactionId: 'tx-2',
        currencyCode: 'CAD',
        changes: {
          structure: {
            before: null,
            after: {
              kind: 'split',
              parts: [
                { amount: -10, categoryId: null, transferAccountId: ACCOUNT_ID, payeeId: PAYEE_ID, memo: null },
                { amount: -5, categoryId: COFFEE_ID, transferAccountId: null, payeeId: null, memo: null },
              ],
            },
          },
        },
      }),
    ]);
    await renderApplications();
    expect(screen.getByText('Became a transfer with Chequing (CAD)')).toBeInTheDocument();
    expect(screen.getByText('Was split into 2 parts')).toBeInTheDocument();
    expect(screen.getByText(/^Part 1: .*10\.00.* to Chequing \(CAD\), payee Corner Cafe$/)).toBeInTheDocument();
    expect(screen.getByText(/^Part 2: .*5\.00.* as Food: Coffee$/)).toBeInTheDocument();
  });
});

describe('RuleApplications', () => {
  it('lists the latest applications with the change in words, the source and a link to each transaction', async () => {
    api.getApplications.mockResolvedValue([
      makeApplication(),
      makeApplication({
        id: 'app-2',
        transactionId: 'tx-2',
        payeeName: null,
        amount: 12,
        source: 'manual',
        changes: {
          payeeId: { before: null, after: PAYEE_ID },
          tagIds: { before: [TAG_ID], after: [] },
        },
      }),
      makeApplication({ id: 'app-3', transactionId: 'tx-3', source: 'create', changes: { categoryId: { before: COFFEE_ID, after: 'gone' } } }),
      makeApplication({ id: 'app-4', transactionId: 'tx-4', source: 'newer-source' }),
    ]);
    await renderApplications();

    expect(api.getApplications).toHaveBeenCalledWith('rule-1');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);

    expect(rows[0]).toHaveTextContent('Corner Cafe');
    expect(rows[0]).toHaveTextContent('-$4.50');
    expect(rows[0]).toHaveTextContent('Imported');
    expect(rows[0]).toHaveTextContent('Category: none → Food: Coffee');
    expect(rows[0]).toHaveTextContent('08/14/2026');
    expect(rows[0]).toHaveTextContent('09/01/2026 12:00');

    expect(rows[1]).toHaveTextContent('No payee');
    expect(rows[1]).toHaveTextContent('Manual run');
    expect(rows[1]).toHaveTextContent('Payee: none → Corner Cafe');
    expect(rows[1]).toHaveTextContent('Tags removed: Coffee run');

    expect(rows[2]).toHaveTextContent('Created');
    expect(rows[2]).toHaveTextContent('Category: Food: Coffee → a deleted item');
    expect(rows[3]).toHaveTextContent('Other');

    const link = within(rows[0]).getByRole('link');
    expect(link).toHaveAttribute('href', '/transactions?targetTransactionId=tx-1');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/transactions?targetTransactionId=tx-2');
  });

  it('shows when a rule applied in the timezone of the preference, not the timezone of the process', async () => {
    // 12:00 UTC on 1 September is already 2 September, 02:00 in Kiritimati (UTC+14).
    setPreferredTimezone('Pacific/Kiritimati');
    api.getApplications.mockResolvedValue([makeApplication()]);
    await renderApplications();
    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveTextContent('09/02/2026 02:00');
    expect(row).not.toHaveTextContent('09/01/2026');
    // The transaction's own date is a calendar date and never moves.
    expect(row).toHaveTextContent('08/14/2026');
  });

  it('reads the changes of the text actions in the past tense: the payee created, the description written', async () => {
    api.getApplications.mockResolvedValue([
      makeApplication({
        changes: {
          payeeId: { before: null, after: PAYEE_ID },
          payeeName: { before: null, after: 'Corner Cafe' },
          payeeCreated: true,
          description: { before: null, after: 'POS 1 / REF 9' },
        },
      }),
    ]);
    await renderApplications();
    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveTextContent('Payee: none → Corner Cafe');
    expect(row).toHaveTextContent('A new payee was created: Corner Cafe');
    expect(row).toHaveTextContent('Description: none → "POS 1 / REF 9"');
  });

  it('reads a payee replaced by one the rule creates as one line, never "none"', async () => {
    api.getApplications.mockResolvedValue([
      makeApplication({
        changes: {
          payeeId: { before: PAYEE_ID, after: null },
          payeeName: { before: 'Old Cafe', after: 'Corner Cafe' },
          payeeCreated: true,
        },
      }),
    ]);
    await renderApplications();
    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveTextContent('→ Corner Cafe (new)');
    expect(row).not.toHaveTextContent('→ none');
  });

  it('builds the deep link the register jumps to', () => {
    expect(transactionHref('11111111-1111-4111-8111-111111111111')).toBe(
      '/transactions?targetTransactionId=11111111-1111-4111-8111-111111111111',
    );
  });

  it('says the rule has not changed anything yet when the trace is empty', async () => {
    api.getApplications.mockResolvedValue([]);
    await renderApplications();
    expect(screen.getByText('This rule has not changed anything yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a spinner while loading', async () => {
    api.getApplications.mockReturnValue(new Promise(() => {}));
    await renderApplications();
    expect(screen.getByText('Loading the history...')).toBeInTheDocument();
  });

  it('shows a failed load as an error with a retry, never as the empty message', async () => {
    api.getApplications.mockRejectedValueOnce(new Error('offline'));
    await renderApplications();
    expect(screen.getByRole('alert')).toHaveTextContent('The history could not be loaded');
    expect(screen.queryByText('This rule has not changed anything yet')).not.toBeInTheDocument();

    api.getApplications.mockResolvedValueOnce([makeApplication()]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
    expect(api.getApplications).toHaveBeenCalledTimes(2);
  });
});
