import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ParserEditorDialog } from './ParserEditorDialog';
import { makeParser, makeReceipt, PARSED_RECEIPT } from './email-receipts-fixtures';
import type { ReceiptParserLookupsState } from '@/hooks/useReceiptParserLookups';
import { usePreferencesStore } from '@/store/preferencesStore';

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
const RRSP_CAD = '33333333-3333-4333-8333-333333333333';
const RRSP_USD = '44444444-4444-4444-8444-444444444444';
const RRSP_CASH = '55555555-5555-4555-8555-555555555555';

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
    accounts: [
      { value: RRSP_CAD, label: 'RRSP', currencyCode: 'CAD', tradable: true },
      { value: RRSP_CASH, label: 'RRSP Cash', currencyCode: 'CAD', tradable: false },
      { value: RRSP_USD, label: 'RRSP', currencyCode: 'USD', tradable: true },
    ],
    currencyCodes: ['USD', 'CAD', 'EUR'],
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
  // Modal focuses its first control on the next frame; let that happen before the test moves focus.
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
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
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  });
  await act(async () => {});
}

function axiosError(status: number, message: string | string[]) {
  // A DTO refusal answers `message` as a list; the error's own text is always a string.
  const text = Array.isArray(message) ? message.join('. ') : message;
  return new AxiosError(text, String(status), undefined, undefined, { status, data: { message } } as never);
}

describe('ParserEditorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([makeReceipt()]);
  });

  describe('a new profile', () => {
    it('is titled as new and keeps Save pressable without a name and a sender domain', async () => {
      await renderEditor();
      expect(screen.getByRole('dialog', { name: 'New profile' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
      // Nothing is flagged before Save is pressed.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
    });

    it('says what is missing when Save is pressed, flags each field in red and goes to the first', async () => {
      await renderEditor();
      await save();
      expect(api.create).not.toHaveBeenCalled();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('The profile cannot be saved yet. Fix these first:');
      expect(alert).toHaveTextContent('Name: Enter a name for the profile.');
      expect(alert).toHaveTextContent('Sender domains: Enter at least one sender domain, such as shop.example.com.');

      const name = screen.getByLabelText('Name');
      const domains = screen.getByLabelText('Sender domains');
      expect(name).toHaveAttribute('aria-invalid', 'true');
      expect(name.className).toContain('border-red-300');
      expect(domains).toHaveAttribute('aria-invalid', 'true');
      expect(domains.className).toContain('border-red-300');
      expect(document.activeElement).toBe(name);

      // Each problem clears as its field is fixed; the summary's entry takes the reader to its field.
      await type('Name', 'Allegro');
      expect(name).not.toHaveAttribute('aria-invalid');
      expect(alert).not.toHaveTextContent('Name: Enter a name');
      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: /Sender domains:/ }));
      });
      expect(document.activeElement).toBe(domains);
      await type('Sender domains', 'allegro.pl');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('names a sender domain that is not one before asking the server, and goes to it', async () => {
      await renderEditor();
      await type('Name', 'Allegro');
      await type('Sender domains', 'allegro.pl\nnot a domain');
      await save();
      expect(api.create).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Sender domains: Not a domain name: not, a, domain.');
      expect(document.activeElement).toBe(screen.getByLabelText('Sender domains'));
    });

    it('accepts a pasted sender address and a trailing dot, as the server does', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor();
      await type('Name', 'Allegro');
      await type('Sender domains', 'orders@Allegro.PL.');
      await save();
      expect(api.create).toHaveBeenCalledTimes(1);
    });

    it('refuses more subject words than the server takes', async () => {
      await renderEditor();
      await type('Name', 'Allegro');
      await type('Sender domains', 'allegro.pl');
      await type('Subject contains', Array.from({ length: 11 }, (_, i) => `word${i}`).join('\n'));
      await save();
      expect(api.create).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Subject contains: Enter at most 10 subject words.');
      expect(document.activeElement).toBe(screen.getByLabelText('Subject contains'));
    });

    it('builds the definition from every field and creates the profile', async () => {
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
      await type('Fees patterns', 'Fee {amount}');
      await pick('Default category', 'Cab', 'Electronics: Cables');
      await pick('Shipping category', 'Ship', 'Shipping');
      await pick('Fees category', 'Ship', 'Shipping');
      await save();

      expect(api.create).toHaveBeenCalledWith({
        name: 'Allegro',
        payeeId: 'payee-1',
        fromDomains: ['allegro.pl', 'mail.allegro.pl'],
        subjectContains: ['order', 'receipt'],
        definition: {
          version: 2,
          orderId: ['Order number: {orderid}'],
          total: ['Total {amount}', 'Sum {amount}'],
          shipping: ['Shipping {amount}'],
          discount: ['Discount {amount}'],
          items: { startAfter: 'Items', stopAt: 'Subtotal', patterns: ['{name} x {qty} {price}'] },
          fees: ['Fee {amount}'],
          defaultCategory: 'Electronics: Cables',
          shippingCategory: 'Shipping',
          feesCategory: 'Shipping',
        },
      });
      expect(api.update).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Profile created');
      expect(onSaved).toHaveBeenCalledWith(makeParser());
    });

    it('offers a Lines source select, on Text by default, and leaves the source out of the definition', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor();
      const select = screen.getByLabelText('Lines source') as HTMLSelectElement;
      expect(select.value).toBe('text');
      expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Text', 'HTML']);
      await type('Name', 'Shop');
      await type('Sender domains', 'shop.example.com');
      await type('Total patterns', 'Total {amount}');
      await save();
      expect(api.create.mock.calls[0][0].definition).toEqual({ version: 2, total: ['Total {amount}'] });
    });

    it('writes source html into the definition when HTML is chosen', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Lines source'), { target: { value: 'html' } });
      });
      await type('Name', 'Shop');
      await type('Sender domains', 'shop.example.com');
      await type('Total patterns', 'Total {amount}');
      await save();
      expect(api.create.mock.calls[0][0].definition).toEqual({ version: 2, source: 'html', total: ['Total {amount}'] });
    });

    it('reads matching emails by default, and a profile that deletes them hides the reading fields and writes discard', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor();
      const select = screen.getByLabelText('Matching emails') as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Read them',
        'Ignore them',
        'Delete them',
      ]);
      expect(screen.getByLabelText('Total patterns')).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(select, { target: { value: 'delete' } });
      });
      expect(screen.queryByLabelText('Total patterns')).not.toBeInTheDocument();
      expect(screen.getByRole('note')).toHaveTextContent('This profile reads nothing');
      await type('Name', 'Newsletters');
      await type('Sender domains', 'news.example.com');
      await save();
      expect(api.create.mock.calls[0][0].definition).toEqual({ version: 2, discard: 'delete' });
    });

    it('starts from the prefill it was given, such as the sender domain of an email', async () => {
      await renderEditor({ prefill: { name: 'shop.example', fromDomains: 'shop.example' }, initialReceiptId: 'r-1' });
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('shop.example');
      expect((screen.getByLabelText('Sender domains') as HTMLTextAreaElement).value).toBe('shop.example');
      expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
      // The test panel starts on that email.
      expect((screen.getByLabelText('Email') as HTMLSelectElement).value).toBe('r-1');
    });

    it('takes a category by name, offers the existing ones and flags a name that is not in the list', async () => {
      await renderEditor();
      // No rule rows and no ids: the categories are named fields.
      expect(screen.queryByRole('button', { name: 'Add a rule' })).not.toBeInTheDocument();
      expect(screen.getByText(/Category rules by item name are an advanced option/)).toBeInTheDocument();
      expect(screen.queryByText(/There is no category named/)).not.toBeInTheDocument();
      await act(async () => {
        const input = screen.getByLabelText('Default category');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'Ele' } });
      });
      expect(screen.getByText('Electronics: Cables')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByText('Electronics: Cables'));
      });
      expect(screen.queryByText(/There is no category named/)).not.toBeInTheDocument();
    });

    it('sends a typed category name as typed, with a warning that it is not a category yet', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor();
      await type('Name', 'Shop');
      await type('Sender domains', 'shop.example.com');
      await act(async () => {
        const input = screen.getByLabelText('Shipping category');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'Postage' } });
        fireEvent.blur(input);
        fireEvent.mouseDown(document.body);
      });
      expect(screen.getByText('There is no category named Postage. Pick one from the list, or create it first.')).toBeInTheDocument();
      await save();
      expect(api.create.mock.calls[0][0].definition).toEqual({ version: 2, shippingCategory: 'Postage' });
    });

    it('opens a definition with category rules as JSON, so the advanced option is not lost', async () => {
      const withRules = makeParser({
        definition: { version: 2, total: ['Total {amount}'], categoryRules: [{ match: '*cable*', categoryId: CAT_CABLES }] },
      });
      await renderEditor({ parser: withRules });
      expect(screen.getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true');
      expect(JSON.parse((screen.getByLabelText('Profile definition (JSON)') as HTMLTextAreaElement).value)).toEqual(
        withRules.definition,
      );
      expect(screen.getByRole('button', { name: 'Form' })).toBeDisabled();
    });

    it('explains the glob syntax and the captures each field accepts', async () => {
      await renderEditor();
      expect(screen.getByText(/Use \* for any text and a name in braces, such as \{name\}/)).toBeInTheDocument();
      expect(screen.getByText(/Must capture \{orderid\}/)).toBeInTheDocument();
      expect(screen.getAllByText(/Must capture \{amount\}/).length).toBeGreaterThan(0);
      expect(screen.getByText(/either \{amount\} \(the line total\) or \{price\}/)).toBeInTheDocument();
    });
  });

  describe('an existing profile', () => {
    const parser = makeParser({
      name: 'Allegro parser',
      fromDomains: ['allegro.pl'],
      definition: {
        version: 2,
        total: ['Total {amount}'],
        defaultCategory: 'Electronics: Cables',
      },
    });

    it('shows the stored source on the form, and carries an html profile through a save', async () => {
      const htmlParser = makeParser({ definition: { version: 2, source: 'html', total: ['Total {amount}'] } });
      api.update.mockResolvedValue(htmlParser);
      await renderEditor({ parser: htmlParser });
      expect((screen.getByLabelText('Lines source') as HTMLSelectElement).value).toBe('html');
      await save();
      expect(api.update.mock.calls[0][1].definition).toEqual({ version: 2, source: 'html', total: ['Total {amount}'] });
    });

    it('is titled as an edit and filled from the stored profile', async () => {
      await renderEditor({ parser });
      expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBeInTheDocument();
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Allegro parser');
      expect((screen.getByLabelText('Total patterns') as HTMLTextAreaElement).value).toBe('Total {amount}');
      // The stored payee and category are shown by name, never by id.
      expect((screen.getByLabelText('Payee') as HTMLInputElement).value).toBe('Allegro');
      expect((screen.getByLabelText('Default category') as HTMLInputElement).value).toBe('Electronics: Cables');
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
      expect(toast.success).toHaveBeenCalledWith('Profile saved');
    });

    it('says the profile changed elsewhere on a 409, saves nothing and offers a reload', async () => {
      api.update.mockRejectedValue(axiosError(409, 'This profile was changed since you opened it.'));
      await renderEditor({ parser });
      await type('Name', 'Renamed');
      await save();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('changed elsewhere since you opened it');
      expect(onSaved).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      // The form cannot be saved over the newer version.
      expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: 'Reload the profile' }));
      });
      expect(onConflict).toHaveBeenCalledTimes(1);
    });

    it('warns that a draft reads nothing until approved, and says when the AI wrote it', async () => {
      await renderEditor({ parser: makeParser({ status: 'draft', source: 'ai' }) });
      expect(screen.getByRole('note')).toHaveTextContent(/The AI drafted this profile from your sample emails/);
      expect(screen.getByRole('note')).toHaveTextContent(/reads nothing until you do/);
    });

    it('does not show the draft warning for an approved profile', async () => {
      await renderEditor({ parser });
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });
  });

  describe('the Form and JSON modes', () => {
    const V2_DEFINITION = {
      version: 2,
      orderId: ['*/kupione/{orderid}?*'],
      total: [{ label: 'RAZEM', value: '{amount} zł', within: 3 }],
      shipping: [{ label: 'Metoda dostawy', value: '{amount} zł', within: 4 }],
      items: {
        startAfter: 'od ',
        stopAt: 'Metoda dostawy',
        skipLines: ['<*>', '(*)'],
        record: [{ line: '{name}' }, { line: '{amount} zł' }, { line: '{qty} × {price} zł', optional: true }],
      },
      defaultCategory: 'Electronics: Cables',
      shippingCategory: 'Shipping',
    };
    const v2Parser = makeParser({ definition: V2_DEFINITION });

    const mode = (name: 'Form' | 'JSON') => screen.getByRole('button', { name });
    const jsonBox = () => screen.getByLabelText('Profile definition (JSON)') as HTMLTextAreaElement;
    const switchTo = async (name: 'Form' | 'JSON') => {
      await act(async () => {
        fireEvent.click(mode(name));
      });
    };

    it('shows a Form | JSON switch at the top of the dialog, on the form for a new profile', async () => {
      await renderEditor();
      const group = screen.getByRole('group', { name: 'Editing mode' });
      expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Form', 'JSON']);
      expect(mode('Form')).toHaveAttribute('aria-pressed', 'true');
      expect(mode('JSON')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByLabelText('Total patterns')).toBeInTheDocument();
    });

    it('opens a version 2 definition the form cannot show directly in JSON, with the form switch disabled and explained', async () => {
      await renderEditor({ parser: v2Parser });
      expect(mode('JSON')).toHaveAttribute('aria-pressed', 'true');
      expect(mode('Form')).toBeDisabled();
      expect(screen.getByText(/uses something the form cannot show/)).toBeInTheDocument();
      expect(mode('Form')).toHaveAccessibleDescription(/Edit it as JSON/);
      expect(screen.queryByLabelText('Total patterns')).not.toBeInTheDocument();
      expect(jsonBox().value).toBe(JSON.stringify(V2_DEFINITION, null, 2));
    });

    it('saves the JSON without dropping a single version 2 field', async () => {
      api.update.mockResolvedValue(makeParser({ revision: 3 }));
      await renderEditor({ parser: v2Parser });
      await type('Name', 'Renamed');
      await save();
      expect(api.update).toHaveBeenCalledWith('p-1', {
        name: 'Renamed',
        payeeId: 'payee-1',
        fromDomains: ['allegro.pl'],
        subjectContains: [],
        definition: V2_DEFINITION,
        expectedRevision: v2Parser.revision,
      });
    });

    it('saves what was typed in the JSON box, not the form behind it', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor();
      await type('Name', 'Allegro');
      await type('Sender domains', 'allegro.pl');
      await switchTo('JSON');
      // The box starts from what the form builds.
      expect(JSON.parse(jsonBox().value)).toEqual({ version: 2 });
      const typed = { version: 2, total: [{ label: 'RAZEM', value: '{amount} zł' }] };
      await type('Profile definition (JSON)', JSON.stringify(typed));
      await save();
      expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Allegro', definition: typed }));
    });

    it('carries the form into the JSON box as version 2', async () => {
      await renderEditor();
      await type('Total patterns', 'Total {amount}');
      await type('Item patterns', '{name} {amount}');
      await switchTo('JSON');
      expect(JSON.parse(jsonBox().value)).toEqual({
        version: 2,
        total: ['Total {amount}'],
        items: { patterns: ['{name} {amount}'] },
      });
    });

    it('switches back to the form while the JSON is something the form can show, and fills it', async () => {
      await renderEditor();
      await switchTo('JSON');
      const shown = { version: 2, total: ['Sum {amount}'], defaultCategory: 'Electronics: Cables' };
      await type('Profile definition (JSON)', JSON.stringify(shown));
      expect(mode('Form')).toBeEnabled();
      await switchTo('Form');
      expect((screen.getByLabelText('Total patterns') as HTMLTextAreaElement).value).toBe('Sum {amount}');
      expect((screen.getByLabelText('Default category') as HTMLInputElement).value).toBe('Electronics: Cables');
    });

    it('turns the form switch off when the JSON gains something the form cannot hold, and back on when it goes', async () => {
      await renderEditor();
      await switchTo('JSON');
      await type('Profile definition (JSON)', JSON.stringify({ version: 2, total: [{ label: 'X', value: '{amount}' }] }));
      expect(mode('Form')).toBeDisabled();
      await type('Profile definition (JSON)', JSON.stringify({ version: 2, total: ['X {amount}'] }));
      expect(mode('Form')).toBeEnabled();
    });

    it('opens a version 1 definition the form can show on the form, and saves it as version 2', async () => {
      api.update.mockResolvedValue(makeParser({ revision: 3 }));
      const old = makeParser({ definition: { version: 1, total: ['Total {amount}'] }, definitionValid: false });
      await renderEditor({ parser: old });
      expect(mode('Form')).toHaveAttribute('aria-pressed', 'true');
      await save();
      expect(api.update).toHaveBeenCalledWith(
        'p-1',
        expect.objectContaining({ definition: { version: 2, total: ['Total {amount}'] } }),
      );
    });

    it('says the JSON is not valid, refuses to save or test it, and keeps the form switch off', async () => {
      await renderEditor({ parser: v2Parser });
      await type('Profile definition (JSON)', '{ "version": 2,');
      expect(screen.getByText(/This is not valid JSON/)).toBeInTheDocument();
      expect(screen.getByText(/The JSON is not valid yet, so the form cannot be shown/)).toBeInTheDocument();
      expect(screen.getByText('The JSON is not valid, so there is nothing to test yet.')).toBeInTheDocument();
      expect(mode('Form')).toBeDisabled();
      await save();
      expect(api.update).not.toHaveBeenCalled();
      const box = screen.getByLabelText('Profile definition (JSON)');
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(document.activeElement).toBe(box);
      expect(screen.getByText(/The profile cannot be saved yet/).closest('[role="alert"]')).toHaveTextContent(
        'Profile definition (JSON): This is not valid JSON',
      );
      await type('Profile definition (JSON)', '[1]');
      await save();
      expect(api.update).not.toHaveBeenCalled();
    });

    it('tests the JSON as it is now, not the form', async () => {
      api.test.mockResolvedValue({
        parsed: PARSED_RECEIPT,
        match: { kind: 'unmatched' },
        candidateCount: 0,
        transaction: null,
      });
      await renderEditor({ parser: v2Parser, initialReceiptId: 'r-1' });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Test' }));
      });
      await act(async () => {});
      expect(api.test).toHaveBeenCalledWith({ definition: V2_DEFINITION, receiptId: 'r-1', payeeId: 'payee-1' });
    });

    it('shows the server codes for the JSON in the words of the editor', async () => {
      api.update.mockRejectedValue(
        axiosError(
          400,
          'The profile definition is not valid: total[0].within: out_of_range; items: items_patterns_and_record; items.record: record_name_missing',
        ),
      );
      await renderEditor({ parser: v2Parser });
      await save();
      const alert = screen.getByText(/The profile definition is not valid:/).closest('[role="alert"]') as HTMLElement;
      expect(alert).toHaveTextContent('Total patterns, entry 1, within: must be a whole number from 1 to 10');
      expect(alert).toHaveTextContent('Line items: has both patterns and a record. Use one of them.');
      expect(alert).toHaveTextContent('Record: must capture {name} in one of its steps');
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
        axiosError(400, 'The profile definition is not valid: total[0]: capture_missing; items.patterns[0]: capture_conflict'),
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
      api.create.mockRejectedValue(axiosError(409, 'At most 200 profiles can be saved. Delete one first.'));
      await renderEditor();
      await fillAndSave();
      expect(screen.getByRole('alert')).toHaveTextContent('At most 200 profiles can be saved. Delete one first.');
    });

    it('shows a DTO refusal, whose message is a list, instead of failing silently', async () => {
      api.create.mockRejectedValue(
        axiosError(400, ['each value of fromDomains must be a host name such as shop.example.com']),
      );
      await renderEditor();
      await fillAndSave();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'each value of fromDomains must be a host name such as shop.example.com',
      );
      // The field the refusal names is flagged and focused.
      const domains = screen.getByLabelText('Sender domains');
      expect(domains).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('The server refused this field. The reason is under the form.')).toBeInTheDocument();
      expect(document.activeElement).toBe(domains);
    });

    it('does not take a definition problem about a name for the profile name', async () => {
      api.create.mockRejectedValue(axiosError(400, 'The profile definition is not valid: items.single.name: empty'));
      await renderEditor();
      await fillAndSave();
      expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
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
        definition: { version: 2, total: ['Total {amount}'] },
        receiptId: 'r-1',
        payeeId: 'payee-2',
      });
      expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('25.00');
    });
  });

  describe('payees and categories', () => {
    it('waits for them, since the pickers are useless without', async () => {
      await renderEditor({ lookups: { status: 'loading' } });
      expect(screen.getByText('Loading payees, categories, accounts and currencies')).toBeInTheDocument();
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    });

    it('shows a failed read as an error with a retry instead of a form that would blank stored ids', async () => {
      await renderEditor({ lookups: { status: 'error' } });
      expect(screen.getByRole('alert')).toHaveTextContent('Payees, categories, accounts or currencies could not be loaded');
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      });
      expect(onReloadLookups).toHaveBeenCalledTimes(1);
    });
  });

  describe('a brokerage trade profile', () => {
    const optionTexts = (label: string) =>
      within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent);
    const choose = async (label: string, value: string) => {
      await act(async () => {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
      });
    };
    const clickButton = async (name: string) => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name }));
      });
    };

    beforeEach(() => {
      usePreferencesStore.setState({ preferences: { defaultCurrency: 'CAD' } as never });
    });

    it('is picked for a new profile, and shows the trade fields instead of the receipt ones', async () => {
      await renderEditor();
      expect(screen.getByRole('button', { name: 'Order receipt' })).toHaveAttribute('aria-pressed', 'true');
      await clickButton('Brokerage trade');
      expect(screen.getByRole('button', { name: 'Brokerage trade' })).toHaveAttribute('aria-pressed', 'true');
      for (const gone of ['Payee', 'Total patterns', 'Item patterns', 'Default category', 'Reference patterns', 'Tag name']) {
        expect(screen.queryByLabelText(gone)).not.toBeInTheDocument();
      }
      for (const shown of ['Lines source', 'Required lines', 'Action patterns', 'Ticker patterns', 'Share count patterns', 'Trade total patterns', 'Account patterns', 'Default account']) {
        expect(screen.getByLabelText(shown)).toBeInTheDocument();
      }
      expect(screen.getByText(/the amount itself when it names one/)).toBeInTheDocument();
    });

    it('offers any currency, the base one and the other active ones, and only the open brokerage accounts', async () => {
      await renderEditor();
      await clickButton('Brokerage trade');
      await clickButton('Add an account rule');
      expect(optionTexts('Currency of rule 1')).toEqual(['Any currency', 'CAD (your base currency)', 'EUR', 'USD']);
      expect(optionTexts('Account of rule 1')).toEqual(['Choose an account', 'RRSP (CAD)', 'RRSP (USD)']);
      await clickButton('Add a currency marker');
      expect(optionTexts('Currency of marker 1')).toEqual(['Choose a currency', 'CAD (your base currency)', 'EUR', 'USD']);
    });

    it('tells two accounts printed the same way apart by currency, and saves the trade definition with no payee', async () => {
      api.create.mockResolvedValue(makeParser());
      await renderEditor({ prefill: { payeeId: 'payee-1' } });
      await clickButton('Brokerage trade');
      await type('Name', 'Broker');
      await type('Sender domains', 'broker.example');
      await type('Required lines', '*has been filled*');
      await type('Action patterns', 'You {action} *');
      await type('Ticker patterns', 'Symbol: {symbol}');
      await type('Share count patterns', 'Shares: {quantity}');
      await type('Trade total patterns', 'Total: {amount}');
      await type('Account patterns', 'Account: {account}');
      await clickButton('Add an account rule');
      await clickButton('Add an account rule');
      await clickButton('Add an account rule');
      await type('Account text of rule 1', 'RRSP');
      await choose('Currency of rule 1', 'USD');
      await choose('Account of rule 1', RRSP_USD);
      await type('Account text of rule 2', 'RRSP');
      await choose('Currency of rule 2', 'CAD');
      await choose('Account of rule 2', RRSP_CAD);
      await type('Account text of rule 3', 'unused');
      await clickButton('Remove rule 3');
      expect(screen.queryByLabelText('Account text of rule 3')).not.toBeInTheDocument();
      await clickButton('Add a currency marker');
      await type('Text of marker 1', '*U.S. dollars*');
      await choose('Currency of marker 1', 'USD');
      await save();

      expect(api.create).toHaveBeenCalledWith({
        name: 'Broker',
        payeeId: null,
        fromDomains: ['broker.example'],
        subjectContains: [],
        definition: {
          version: 2,
          trade: {
            action: ['You {action} *'],
            symbol: ['Symbol: {symbol}'],
            quantity: ['Shares: {quantity}'],
            total: ['Total: {amount}'],
            account: ['Account: {account}'],
            accountRules: [
              { match: 'RRSP', accountId: RRSP_USD, currency: 'USD' },
              { match: 'RRSP', accountId: RRSP_CAD, currency: 'CAD' },
            ],
            currencyMarkers: [{ match: '*U.S. dollars*', currency: 'USD' }],
          },
          requireLine: ['*has been filled*'],
        },
      });
    });

    it('moves a rule earlier, since the first that applies wins', async () => {
      await renderEditor();
      await clickButton('Brokerage trade');
      await clickButton('Add an account rule');
      await clickButton('Add an account rule');
      await type('Account text of rule 2', 'TFSA');
      await clickButton('Move rule 2 earlier');
      expect((screen.getByLabelText('Account text of rule 1') as HTMLInputElement).value).toBe('TFSA');
      expect(screen.getByRole('button', { name: 'Move rule 1 earlier' })).toBeDisabled();
    });

    it('opens a stored trade profile on the form, with no kind switch, and flags an account a trade cannot book to', async () => {
      const stored = makeParser({
        definition: {
          version: 2,
          trade: {
            action: ['{action}'],
            symbol: ['{symbol}'],
            quantity: ['{quantity}'],
            total: ['{amount}'],
            accountRules: [{ match: '*', accountId: RRSP_CASH, currency: 'GBP' }],
            defaultAccountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          },
        },
      });
      api.update.mockResolvedValue(stored);
      await renderEditor({ parser: stored });
      expect(screen.getByRole('button', { name: 'Form' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: 'Brokerage trade' })).not.toBeInTheDocument();
      expect((screen.getByLabelText('Currency of rule 1') as HTMLSelectElement).value).toBe('GBP');
      expect((screen.getByLabelText('Account of rule 1') as HTMLSelectElement).value).toBe(RRSP_CASH);
      expect(optionTexts('Account of rule 1')).toContain('RRSP Cash (not an open brokerage account)');
      expect(optionTexts('Default account')).toContain('An account not in your list');
      const notes = screen.getAllByRole('note').map((note) => note.textContent);
      expect(notes).toContain('A trade cannot be booked to this account: it is closed, a cash account or not an investment account.');
      expect(notes).toContain('This account is not in your list: it may have been deleted. Pick another one.');
      await save();
      expect(api.update.mock.calls[0][1].definition).toEqual(stored.definition);
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

  describe('closing with unsaved edits', () => {
    const backdrop = () => document.querySelector('.backdrop-blur-sm') as HTMLElement;
    // UnsavedChangesDialog draws its own heading, so the dialog is found by it.
    const unsavedPrompt = () => screen.queryByText('Unsaved Changes')?.closest('[role="dialog"]') ?? null;

    it('asks before Cancel drops them, and stays open when asked to', async () => {
      await renderEditor();
      await type('Name', 'Allegro');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });
      expect(onClose).not.toHaveBeenCalled();
      const prompt = unsavedPrompt() as HTMLElement;
      expect(prompt).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
      });
      expect(unsavedPrompt()).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Allegro');
    });

    it('asks before a click outside the dialog drops them, and closes on Discard', async () => {
      await renderEditor({ parser: makeParser() });
      await type('Sender domains', 'other.example.com');
      await act(async () => {
        fireEvent.click(backdrop());
      });
      expect(onClose).not.toHaveBeenCalled();
      const prompt = unsavedPrompt() as HTMLElement;
      expect(prompt).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(api.update).not.toHaveBeenCalled();
    });

    it('saves from the prompt, and shows what is missing instead when the profile cannot be saved', async () => {
      await renderEditor();
      await type('Name', 'Allegro');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });
      await act(async () => {
        fireEvent.click(within(unsavedPrompt() as HTMLElement).getByRole('button', { name: 'Save' }));
      });
      await act(async () => {});
      expect(api.create).not.toHaveBeenCalled();
      expect(screen.getByText(/The profile cannot be saved yet/)).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes at once after a mode switch or an edit put back, which changes nothing', async () => {
      await renderEditor();
      await type('Name', 'Allegro');
      await type('Name', '');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
      });
      await act(async () => {
        fireEvent.click(backdrop());
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(unsavedPrompt()).toBeNull();
    });
  });
});
