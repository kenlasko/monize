import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ParserEditorDialog } from './ParserEditorDialog';
import { makeParser, makeReceipt } from './email-receipts-fixtures';
import type { ReceiptParserLookupsState } from '@/hooks/useReceiptParserLookups';

const api = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), test: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    parsers: { create: api.create, update: api.update, test: api.test },
    receipts: { list: api.list },
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const CAT_CABLES = '11111111-1111-4111-8111-111111111111';
const CAT_SHIPPING = '22222222-2222-4222-8222-222222222222';

const ready: ReceiptParserLookupsState = {
  status: 'ready',
  lookups: {
    payees: [
      { value: 'payee-1', label: 'Allegro' },
      { value: 'payee-2', label: 'Amazon' },
    ],
    categories: [
      { value: CAT_CABLES, label: 'Electronics: Cables' },
      { value: CAT_SHIPPING, label: 'Shipping' },
    ],
  },
};

const onClose = vi.fn();
const onSaved = vi.fn();
const onConflict = vi.fn();
const onReloadLookups = vi.fn();

async function renderEditor(props: Partial<Parameters<typeof ParserEditorDialog>[0]> = {}) {
  await act(async () => {
    render(
      <ParserEditorDialog
        parser={null}
        lookups={ready}
        onReloadLookups={onReloadLookups}
        onClose={onClose}
        onSaved={onSaved}
        onConflict={onConflict}
        {...props}
      />,
    );
  });
  await act(async () => {});
}

async function type(label: string, value: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
}

async function pick(label: string, typed: string, option: string) {
  const input = screen.getByLabelText(label);
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: typed } });
  });
  await act(async () => {
    fireEvent.click(screen.getByText(option));
  });
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save parser' }));
  });
  await act(async () => {});
}

function axiosError(status: number, message: string) {
  return new AxiosError(message, String(status), undefined, undefined, { status, data: { message } } as never);
}

describe('ParserEditorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([makeReceipt()]);
  });

  describe('a new parser', () => {
    it('is titled as new and cannot be saved without a name and a sender domain', async () => {
      await renderEditor();
      expect(screen.getByRole('dialog', { name: 'New parser' })).toBeInTheDocument();
      const saveButton = screen.getByRole('button', { name: 'Save parser' });
      expect(saveButton).toBeDisabled();
      await type('Name', 'Allegro');
      expect(saveButton).toBeDisabled();
      await type('Sender domains', 'allegro.pl');
      expect(saveButton).toBeEnabled();
    });

    it('builds the definition from every field and creates the parser', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor();
      await type('Name', ' Allegro ');
      await pick('Payee', 'Alle', 'Allegro');
      await type('Sender domains', 'allegro.pl\nmail.allegro.pl');
      await type('Subject contains', 'order, receipt');
      await type('Order number patterns', 'Order number: {orderid}');
      await type('Total patterns', 'Total {amount}\nSum {amount}');
      await type('Shipping patterns', 'Shipping {amount}');
      await type('Discount patterns', 'Discount {amount}');
      await type('Items start after', 'Items');
      await type('Items stop at', 'Subtotal');
      await type('Item patterns', '{name} x {qty} {price}');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
      });
      await type('Rule 1 pattern', '*cable*');
      await pick('Rule 1 category', 'Cab', 'Electronics: Cables');
      await pick('Default category', 'Ship', 'Shipping');
      await pick('Shipping category', 'Ship', 'Shipping');
      await save();

      expect(api.create).toHaveBeenCalledWith({
        name: 'Allegro',
        payeeId: 'payee-1',
        fromDomains: ['allegro.pl', 'mail.allegro.pl'],
        subjectContains: ['order', 'receipt'],
        definition: {
          version: 1,
          orderId: ['Order number: {orderid}'],
          total: ['Total {amount}', 'Sum {amount}'],
          shipping: ['Shipping {amount}'],
          discount: ['Discount {amount}'],
          items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} x {qty} {price}'] },
          categoryRules: [{ match: '*cable*', categoryId: CAT_CABLES }],
          defaultCategoryId: CAT_SHIPPING,
          shippingCategoryId: CAT_SHIPPING,
        },
      });
      expect(api.update).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Parser created');
      expect(onSaved).toHaveBeenCalledWith(makeParser());
    });

    it('starts from the prefill it was given, such as the sender domain of an email', async () => {
      await renderEditor({ prefill: { name: 'shop.example', fromDomains: 'shop.example' }, initialReceiptId: 'r-1' });
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('shop.example');
      expect((screen.getByLabelText('Sender domains') as HTMLTextAreaElement).value).toBe('shop.example');
      expect(screen.getByRole('button', { name: 'Save parser' })).toBeEnabled();
      // The test panel starts on that email.
      expect((screen.getByLabelText('Email') as HTMLSelectElement).value).toBe('r-1');
    });

    it('adds and removes category rules, each with its own pattern', async () => {
      await renderEditor();
      const add = screen.getByRole('button', { name: 'Add a rule' });
      await act(async () => {
        fireEvent.click(add);
        fireEvent.click(add);
      });
      await type('Rule 1 pattern', 'first');
      await type('Rule 2 pattern', 'second');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Remove rule 1' }));
      });
      expect(screen.queryByLabelText('Rule 2 pattern')).not.toBeInTheDocument();
      expect((screen.getByLabelText('Rule 1 pattern') as HTMLInputElement).value).toBe('second');
    });

    it('stops adding rules at the limit of 50', async () => {
      await renderEditor();
      const add = screen.getByRole('button', { name: 'Add a rule' });
      await act(async () => {
        for (let i = 0; i < 50; i += 1) fireEvent.click(add);
      });
      expect(screen.getAllByRole('button', { name: /^Remove rule/ })).toHaveLength(50);
      expect(add).toBeDisabled();
      expect(screen.getByText('The limit of 50 rules is reached.')).toBeInTheDocument();
    });

    it('explains the glob syntax and the captures each field accepts', async () => {
      await renderEditor();
      expect(screen.getByText(/Use \* for any text and a name in braces, such as \{name\}/)).toBeInTheDocument();
      expect(screen.getByText(/Must capture \{orderid\}/)).toBeInTheDocument();
      expect(screen.getAllByText(/Must capture \{amount\}/).length).toBeGreaterThan(0);
      expect(screen.getByText(/either \{amount\} \(the line total\) or \{price\}/)).toBeInTheDocument();
    });
  });

  describe('an existing parser', () => {
    const parser = makeParser({
      name: 'Allegro parser',
      fromDomains: ['allegro.pl'],
      definition: {
        version: 1,
        total: ['Total {amount}'],
        categoryRules: [{ match: '*cable*', categoryId: CAT_CABLES }],
      },
    });

    it('is titled as an edit and filled from the stored parser', async () => {
      await renderEditor({ parser });
      expect(screen.getByRole('dialog', { name: 'Edit parser' })).toBeInTheDocument();
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Allegro parser');
      expect((screen.getByLabelText('Total patterns') as HTMLTextAreaElement).value).toBe('Total {amount}');
      expect((screen.getByLabelText('Rule 1 pattern') as HTMLInputElement).value).toBe('*cable*');
      // The stored payee and category are shown by name, never by id.
      expect((screen.getByLabelText('Payee') as HTMLInputElement).value).toBe('Allegro');
      expect((screen.getByLabelText('Rule 1 category') as HTMLInputElement).value).toBe('Electronics: Cables');
    });

    it('saves with the revision it was opened at', async () => {
      api.update.mockResolvedValue(makeParser({ revision: 3 }));
      await renderEditor({ parser });
      await type('Name', 'Renamed');
      await save();
      expect(api.update).toHaveBeenCalledWith(
        'p-1',
        expect.objectContaining({ name: 'Renamed', expectedRevision: parser.revision, fromDomains: ['allegro.pl'] }),
      );
      expect(api.create).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Parser saved');
    });

    it('says the parser changed elsewhere on a 409, saves nothing and offers a reload', async () => {
      api.update.mockRejectedValue(axiosError(409, 'This parser was changed since you opened it.'));
      await renderEditor({ parser });
      await type('Name', 'Renamed');
      await save();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('changed elsewhere since you opened it');
      expect(onSaved).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      // The form cannot be saved over the newer version.
      expect(screen.getByRole('button', { name: 'Save parser' })).toBeDisabled();
      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: 'Reload the parser' }));
      });
      expect(onConflict).toHaveBeenCalledTimes(1);
    });

    it('warns that a draft reads nothing until approved, and says when the AI wrote it', async () => {
      await renderEditor({ parser: makeParser({ status: 'draft', source: 'ai' }) });
      expect(screen.getByRole('note')).toHaveTextContent(/The AI drafted this parser from one sample email/);
      expect(screen.getByRole('note')).toHaveTextContent(/reads nothing until you do/);
    });

    it('does not show the draft warning for an approved parser', async () => {
      await renderEditor({ parser });
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });
  });

  describe('server refusals', () => {
    async function fillAndSave() {
      await type('Name', 'Allegro');
      await type('Sender domains', 'allegro.pl');
      await type('Total patterns', 'Total');
      await save();
    }

    it('shows the validator problems readably, in the words of the form', async () => {
      api.create.mockRejectedValue(
        axiosError(400, 'The parser definition is not valid: total[0]: capture_missing; items.patterns[0]: capture_conflict'),
      );
      await renderEditor();
      await fillAndSave();

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Total patterns, line 1: is missing a capture this field needs')).toBeInTheDocument();
      expect(within(alert).getByText(/Item patterns, line 1: captures both the line total and the unit price/)).toBeInTheDocument();
      expect(within(alert).queryByText(/capture_missing/)).not.toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
      // What was typed is still there.
      expect((screen.getByLabelText('Total patterns') as HTMLTextAreaElement).value).toBe('Total');
    });

    it('shows any other refusal as the server wrote it', async () => {
      api.create.mockRejectedValue(axiosError(409, 'At most 200 parsers can be saved. Delete one first.'));
      await renderEditor();
      await fillAndSave();
      expect(screen.getByRole('alert')).toHaveTextContent('At most 200 parsers can be saved. Delete one first.');
    });

    it('clears the refusal when the next save starts', async () => {
      api.create.mockRejectedValueOnce(axiosError(400, 'Payee not found'));
      await renderEditor();
      await fillAndSave();
      expect(screen.getByRole('alert')).toHaveTextContent('Payee not found');
      api.create.mockResolvedValueOnce(makeParser());
      await save();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('the test panel', () => {
    it('reads a stored email with the definition as it is on the form, saved or not', async () => {
      api.test.mockResolvedValue({
        parsed: { orderId: null, total: 250_000, shipping: null, discount: null, items: [], shippingCategoryId: null, discountCategoryId: null, complete: false, reason: 'no_items' },
        match: { kind: 'unmatched' },
        candidateCount: 0,
        transaction: null,
      });
      await renderEditor({ initialReceiptId: 'r-1' });
      await type('Total patterns', 'Total {amount}');
      await pick('Payee', 'Ama', 'Amazon');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Test' }));
      });
      await act(async () => {});
      expect(api.test).toHaveBeenCalledWith({
        definition: { version: 1, total: ['Total {amount}'] },
        receiptId: 'r-1',
        payeeId: 'payee-2',
      });
      expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('25.00');
    });
  });

  describe('payees and categories', () => {
    it('waits for them, since the pickers are useless without', async () => {
      await renderEditor({ lookups: { status: 'loading' } });
      expect(screen.getByText('Loading payees and categories')).toBeInTheDocument();
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    });

    it('shows a failed read as an error with a retry instead of a form that would blank stored ids', async () => {
      await renderEditor({ lookups: { status: 'error' } });
      expect(screen.getByRole('alert')).toHaveTextContent('Payees and categories could not be loaded');
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      });
      expect(onReloadLookups).toHaveBeenCalledTimes(1);
    });
  });

  it('closes without saving', async () => {
    await renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.create).not.toHaveBeenCalled();
  });
});
