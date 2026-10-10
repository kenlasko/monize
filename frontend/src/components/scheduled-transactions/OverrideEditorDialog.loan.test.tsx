import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import toast from 'react-hot-toast';
import { OverrideEditorDialog } from './OverrideEditorDialog';
import type { LoanOccurrence, SelectedLoanOccurrence } from '@/types/scheduled-transaction';

// Issue #1643: an occurrence of a loan bill opens on the figures the server
// priced for it at its own due date (INV-LOAN-009), not the template's. The
// real `toSplitRows`, booking and format helpers run here.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const mockCreateOverride = vi.fn().mockResolvedValue({});
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    createOverride: (...args: any[]) => mockCreateOverride(...args),
    updateOverride: vi.fn().mockResolvedValue({}),
    deleteOverride: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurityPrices: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => numberFormatMockDefaults() };
});

vi.mock('@/components/transactions/SplitEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/transactions/SplitEditor')>()),
  SplitEditor: ({ splits, transactionAmount }: any) => (
    <div data-testid="split-editor">
      <span data-testid="parent">{transactionAmount}</span>
      {splits.map((s: any) => (
        <span key={s.id} data-testid="line">{s.amount}</span>
      ))}
    </div>
  ),
}));

const mortgage = { id: 'loan-1', name: 'Mortgage', accountType: 'MORTGAGE', currentBalance: -100000 };

// Timeline A of issue #1637 with the Scenario 2 template: 560.00 at
// 2023-02-03 (Principal 185.00, Interest 375.00).
const loanBill = {
  id: 's1',
  name: 'Mortgage payment',
  amount: -560,
  currencyCode: 'CAD',
  accountId: 'a1',
  categoryId: null,
  description: '',
  isTransfer: false,
  isSplit: true,
  account: { name: 'Main' },
  splits: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      transferAccountId: null,
      transferAccount: null,
      categoryId: 'cat-interest',
      amount: -375,
      memo: 'Interest',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      transferAccountId: 'loan-1',
      transferAccount: mortgage,
      categoryId: null,
      amount: -185,
      memo: 'Principal',
    },
  ],
} as any;

const occurrence = (over: Partial<LoanOccurrence> = {}): LoanOccurrence => ({
  originalDate: '2023-05-03',
  dueDate: '2023-05-03',
  overrideId: null,
  amount: 560,
  principal: 186.9,
  interest: 373.1,
  extraPrincipal: 0,
  annualRate: 4.5,
  debtBefore: 99494.13,
  complete: true,
  missing: null,
  ...over,
});

const selected = (over: Partial<LoanOccurrence> = {}): SelectedLoanOccurrence => ({
  loanAccountId: 'loan-1',
  occurrence: occurrence(over),
});

const renderEditor = (props: Partial<React.ComponentProps<typeof OverrideEditorDialog>> = {}) =>
  render(
    <OverrideEditorDialog
      isOpen
      scheduledTransaction={loanBill}
      overrideDate="2023-05-03"
      categories={[{ id: 'cat-interest', name: 'Mortgage Interest', parentId: null }] as any[]}
      accounts={[{ id: 'a1', name: 'Main', accountType: 'CHEQUING' }, mortgage] as any[]}
      onClose={vi.fn()}
      onSave={vi.fn()}
      {...props}
    />,
  );

const lines = () => screen.getAllByTestId('line').map((el) => el.textContent);

describe('OverrideEditorDialog: a loan occurrence priced at its own due date (issue #1643)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens 2023-05-03 at 560.00 = 373.10 + 186.90', () => {
    renderEditor({ loanOccurrence: selected() });
    expect(screen.getByTestId('parent')).toHaveTextContent('-560');
    expect(lines()).toEqual(['-373.1', '-186.9']);
  });

  it('opens an occurrence before the change at its own 584.59, not the template 560.00', async () => {
    renderEditor({
      overrideDate: '2023-02-03',
      loanOccurrence: selected({
        originalDate: '2023-02-03',
        dueDate: '2023-02-03',
        amount: 584.59,
        principal: 167.92,
        interest: 416.67,
        annualRate: 5,
        debtBefore: 100000,
      }),
    });
    expect(screen.getByTestId('parent')).toHaveTextContent('-584.59');
    expect(lines()).toEqual(['-416.67', '-167.92']);

    fireEvent.click(screen.getByText('Save Override'));
    await waitFor(() => expect(mockCreateOverride).toHaveBeenCalled());
    const payload = mockCreateOverride.mock.calls[0][1];
    expect(payload.amount).toBe(-584.59);
    expect(payload.splits.map((s: any) => s.amount)).toEqual([-416.67, -167.92]);
  });

  it('divides an override amount with no lines of its own at the occurrence', () => {
    renderEditor({
      existingOverride: {
        id: 'o1',
        originalDate: '2023-05-03',
        overrideDate: '2023-05-03',
        amount: -610,
        isSplit: null,
        splits: null,
      } as any,
      loanOccurrence: selected({ overrideId: 'o1', amount: 610, principal: 236.9 }),
    });
    expect(screen.getByTestId('parent')).toHaveTextContent('-610');
    expect(lines()).toEqual(['-373.1', '-236.9']);
  });

  it("keeps an override's own lines as the user wrote them", () => {
    renderEditor({
      existingOverride: {
        id: 'o1',
        originalDate: '2023-05-03',
        overrideDate: '2023-05-03',
        amount: -600,
        isSplit: true,
        splits: [
          { categoryId: 'cat-interest', transferAccountId: null, amount: -380, memo: 'Interest' },
          { categoryId: null, transferAccountId: 'loan-1', amount: -220, memo: 'Principal' },
        ],
      } as any,
      loanOccurrence: selected({ overrideId: 'o1', amount: 600, principal: 220, interest: 380 }),
    });
    expect(screen.getByTestId('parent')).toHaveTextContent('-600');
    expect(lines()).toEqual(['-380', '-220']);
  });

  it('opens an unknown occurrence with an empty amount and the reason, and refuses to save it', () => {
    renderEditor({
      loanOccurrence: selected({
        amount: null,
        principal: null,
        interest: null,
        extraPrincipal: null,
        complete: false,
        missing: { kind: 'rate', date: '2023-05-03' },
      }),
    });
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByRole('note')).toHaveTextContent(/No interest rate is recorded for 2023-05-03/);
    expect(lines()).not.toContain('-375');

    fireEvent.click(screen.getByText('Save Override'));
    expect(toast.error).toHaveBeenCalledWith("Enter this occurrence's amount before saving.");
    expect(mockCreateOverride).not.toHaveBeenCalled();
  });

  it('opens a bill with no projection on the template, as before', () => {
    renderEditor();
    expect(screen.getByTestId('parent')).toHaveTextContent('-560');
    expect(lines()).toEqual(['-375', '-185']);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
