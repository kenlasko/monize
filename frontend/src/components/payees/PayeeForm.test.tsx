import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { PayeeForm } from './PayeeForm';
import { payeesApi } from '@/lib/payees';

// Pass the form's current values straight through so submit handlers receive
// the real field values (name, defaultCategoryId, notes) rather than an empty
// object -- needed to exercise the apply-category branching on submit.
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: Record<string, unknown>) => ({
    values,
    errors: {},
  }),
}));

vi.mock('@/lib/categoryUtils', () => ({
  // The holder-aware builders, as the real ones shape them: "Parent: Child"
  // labels, Transfer categories only where a transfer holds the category.
  buildCategoryPickerOptions: (cats: any[], holder: string, toOption: (c: any, label: string) => unknown) =>
    (cats || [])
      .filter((c: any) => holder === 'transfer' || c.categoryType !== 'transfer')
      .map((c: any) => {
        const p = (cats || []).find((x: any) => x.id === c.parentId);
        return toOption(c, p ? `${p.name}: ${c.name}` : c.name);
      }),
  getCategorySelectOptionsFor: (cats: any[], holder: string) =>
    (cats || [])
      .filter((c: any) => holder === 'transfer' || c.categoryType !== 'transfer')
      .map((c: any) => ({ value: c.id, label: c.name })),
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, level: 0 })),
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAliases: vi.fn().mockResolvedValue([]),
    createAlias: vi.fn().mockResolvedValue({ id: 'a1', alias: 'test', payeeId: 'p1' }),
    deleteAlias: vi.fn().mockResolvedValue(undefined),
    lookupContact: vi.fn().mockResolvedValue({ reason: 'none', suggestion: null }),
  },
}));

// The automatic lookup keys off the opt-in preference; the store is mocked so
// each test decides whether it is on.
let mockLookupEnabled = false;
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: { payeeContactLookupEnabled: mockLookupEnabled } }),
}));

// Whether an AI provider exists decides whether the lookup is offered at all;
// the hook is mocked so each test states which world it is in.
let mockLookupAvailable = true;
vi.mock('@/hooks/useContactLookupAvailable', () => ({
  useContactLookupAvailable: () => ({
    available: mockLookupAvailable,
    resolved: true,
    source: mockLookupAvailable ? 'ai' : null,
  }),
}));

describe('PayeeForm', () => {
  const categories = [
    { id: 'c1', name: 'Food', parentId: null },
  ] as any[];

  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it('renders create form', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Payee Name')).toBeInTheDocument();
    expect(screen.getByText('Default Category')).toBeInTheDocument();
    expect(screen.getByText('Create Payee')).toBeInTheDocument();
  });

  it('renders update form when editing', async () => {
    const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: 'Groceries' } as any;
    await act(async () => {
      render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Update Payee')).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders notes field', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Notes (optional)')).toBeInTheDocument();
  });

  describe('website', () => {
    it('offers a website field, hinting that a bare domain is enough', () => {
      render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText('Website')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('starbucks.com')).toBeInTheDocument();
    });

    it('pre-fills the stored address when editing', async () => {
      const payee = {
        id: 'p1',
        name: 'Walmart',
        defaultCategoryId: 'c1',
        notes: '',
        website: 'https://www.walmart.com',
      } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(screen.getByPlaceholderText('starbucks.com')).toHaveValue(
        'https://www.walmart.com',
      );
    });

    it('submits what was typed, leaving the scheme to the backend', async () => {
      const submit = vi.fn().mockResolvedValue(undefined);
      render(<PayeeForm categories={categories} onSubmit={submit} onCancel={onCancel} />);

      fireEvent.change(screen.getByLabelText('Payee Name'), {
        target: { value: 'Starbucks' },
      });
      fireEvent.change(screen.getByPlaceholderText('starbucks.com'), {
        target: { value: 'starbucks.com' },
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Payee'));
      });

      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ website: 'starbucks.com' }),
      );
    });
  });

  it('renders alias manager when creating a new payee', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Aliases')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g., STARBUCKS #*')).toBeInTheDocument();
  });

  it('renders alias manager when editing an existing payee', async () => {
    const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '' } as any;
    await act(async () => {
      render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Aliases')).toBeInTheDocument();
  });

  it('shows category options in dropdown', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    const categoryInput = screen.getByPlaceholderText('Select category...');
    await act(async () => {
      fireEvent.focus(categoryInput);
    });
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('formats label with parent name for subcategories', () => {
    const cats = [
      { id: 'c1', name: 'Food', parentId: null },
      { id: 'c2', name: 'Groceries', parentId: 'c1' },
    ] as any[];
    render(<PayeeForm categories={cats} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Payee Name')).toBeInTheDocument();
  });

  it('resolves subcategory display name with parent prefix for existing payee', async () => {
    const cats = [
      { id: 'c1', name: 'Food', parentId: null },
      { id: 'c2', name: 'Groceries', parentId: 'c1' },
    ] as any[];
    const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c2', notes: null } as any;
    await act(async () => {
      render(<PayeeForm payee={payee} categories={cats} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Update Payee')).toBeInTheDocument();
  });

  it('handles payee with null notes without throwing', async () => {
    const payee = { id: 'p1', name: 'Amazon', defaultCategoryId: null, notes: null } as any;
    await act(async () => {
      render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Update Payee')).toBeInTheDocument();
  });

  it('handles payee with defaultCategoryId not found in categories', async () => {
    const payee = { id: 'p1', name: 'Shop', defaultCategoryId: 'deleted-cat', notes: '' } as any;
    await act(async () => {
      render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Update Payee')).toBeInTheDocument();
  });

  describe('apply category to existing transactions', () => {
    it('offers the apply options when editing a payee with a category and transactions', async () => {
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '', transactionCount: 10, uncategorizedCount: 3 } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(screen.getByText('Apply this category to existing transactions')).toBeInTheDocument();
      expect(screen.getByText("Don't change existing transactions")).toBeInTheDocument();
      expect(screen.getByText('Only transactions without a category (3)')).toBeInTheDocument();
      expect(screen.getByText('All transactions (10)')).toBeInTheDocument();
    });

    it('does not offer apply options when creating a payee', () => {
      render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.queryByText('Apply this category to existing transactions')).not.toBeInTheDocument();
    });

    it('does not offer apply options when the editing payee has no transactions', async () => {
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '', transactionCount: 0, uncategorizedCount: 0 } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(screen.queryByText('Apply this category to existing transactions')).not.toBeInTheDocument();
    });

    it('does not offer apply options when the editing payee has no default category', async () => {
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: null, notes: '', transactionCount: 10, uncategorizedCount: 3 } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(screen.queryByText('Apply this category to existing transactions')).not.toBeInTheDocument();
    });

    it('passes the chosen apply mode through to onSubmit', async () => {
      const submit = vi.fn().mockResolvedValue(undefined);
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '', transactionCount: 10, uncategorizedCount: 3 } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={submit} onCancel={onCancel} />);
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Apply this category to existing transactions'), { target: { value: 'all' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Payee'));
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0][0]).toMatchObject({
        defaultCategoryId: 'c1',
        applyCategoryToTransactions: 'all',
      });
    });

    it('preserves the existing default category on a no-change update', async () => {
      // The category field is not registered with react-hook-form -- it is
      // driven by the controlled selection state -- so the submitted
      // defaultCategoryId must come from that state, never from an unregistered
      // RHF value that can be dropped. Editing without touching the category
      // must keep it (regression: it was being cleared on a no-op save).
      const submit = vi.fn().mockResolvedValue(undefined);
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '', transactionCount: 10, uncategorizedCount: 3 } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={submit} onCancel={onCancel} />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Payee'));
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0][0].defaultCategoryId).toBe('c1');
    });

    it('removes the default category when it is cleared via the combobox', async () => {
      // Clearing the category must submit a falsy defaultCategoryId (the page
      // layer turns it into null) and reset the now-meaningless backfill choice.
      const submit = vi.fn().mockResolvedValue(undefined);
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '', transactionCount: 10, uncategorizedCount: 3 } as any;
      let container!: HTMLElement;
      await act(async () => {
        ({ container } = render(<PayeeForm payee={payee} categories={categories} onSubmit={submit} onCancel={onCancel} />));
      });
      // The combobox renders a clear (X) button (tabindex=-1) when it has a value.
      const clearBtn = container.querySelector('button[tabindex="-1"]') as HTMLButtonElement;
      expect(clearBtn).toBeTruthy();
      await act(async () => {
        fireEvent.mouseDown(clearBtn);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Payee'));
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0][0].defaultCategoryId).toBeFalsy();
      expect(submit.mock.calls[0][0].applyCategoryToTransactions).toBeUndefined();
    });

    it('carries the apply mode using the existing category even when it is not re-selected', async () => {
      // Selecting "all" without re-touching the category must still send both
      // the apply instruction and the category, so the backend backfill runs
      // (regression: the apply was dropped when the category was untouched).
      const submit = vi.fn().mockResolvedValue(undefined);
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '', transactionCount: 10, uncategorizedCount: 3 } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={submit} onCancel={onCancel} />);
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Apply this category to existing transactions'), { target: { value: 'all' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Payee'));
      });
      expect(submit.mock.calls[0][0]).toMatchObject({
        defaultCategoryId: 'c1',
        applyCategoryToTransactions: 'all',
      });
    });

    it('omits the apply mode when left at the default (none)', async () => {
      const submit = vi.fn().mockResolvedValue(undefined);
      const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '', transactionCount: 10, uncategorizedCount: 3 } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={submit} onCancel={onCancel} />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Payee'));
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0][0].applyCategoryToTransactions).toBeUndefined();
    });
  });

  describe('contact details', () => {
    it('submits the address, email and phone', async () => {
      const submit = vi.fn().mockResolvedValue(undefined);
      await act(async () => {
        render(
          <PayeeForm categories={categories} onSubmit={submit} onCancel={onCancel} />,
        );
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Payee Name'), {
          target: { value: 'Starbucks' },
        });
        fireEvent.change(screen.getByLabelText('Address'), {
          target: { value: '1912 Pike Pl\nSeattle, WA' },
        });
        fireEvent.change(screen.getByLabelText('Email'), {
          target: { value: 'hello@starbucks.com' },
        });
        fireEvent.change(screen.getByLabelText('Phone'), {
          target: { value: '+1 206-448-8762' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Payee'));
      });

      expect(submit.mock.calls[0][0]).toMatchObject({
        address: '1912 Pike Pl\nSeattle, WA',
        email: 'hello@starbucks.com',
        phone: '+1 206-448-8762',
      });
    });

    it('submits an emptied field as "", which is how the backend clears it', async () => {
      const submit = vi.fn().mockResolvedValue(undefined);
      const payee = {
        id: 'p1',
        name: 'Starbucks',
        defaultCategoryId: '',
        notes: '',
        address: '1912 Pike Pl',
        email: 'hello@starbucks.com',
        phone: '555',
      } as any;
      await act(async () => {
        render(
          <PayeeForm
            payee={payee}
            categories={categories}
            onSubmit={submit}
            onCancel={onCancel}
          />,
        );
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Address'), {
          target: { value: '' },
        });
        fireEvent.change(screen.getByLabelText('Email'), {
          target: { value: '' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Payee'));
      });

      // An empty email must pass validation: it is a clear, not a bad address.
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0][0]).toMatchObject({ address: '', email: '' });
    });
  });

  describe('contact lookup', () => {
    const suggestion = {
      website: 'https://acme.example',
      address: '1 Main St',
      email: 'hi@acme.example',
      // What the lookup service actually hands over: the STORED form. The
      // fixture used to be "+1 555 010 2000", which no lookup can return any
      // more and which does not parse either -- so it agreed with the field
      // whether or not the field formatted anything.
      phone: '+12064488762',
      source: 'ai-web-search',
      confidence: 'high',
      notes: null,
      refined: [],
      label: null,
    };
    const lookupContact = vi.mocked(payeesApi.lookupContact);

    beforeEach(() => {
      lookupContact.mockReset();
      lookupContact.mockResolvedValue({ reason: 'ok', suggestions: [suggestion] } as any);
      mockLookupEnabled = true;
      mockLookupAvailable = true;
    });

    function renderCreate() {
      render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    }

    it('offers no lookup at all when no AI provider is configured', async () => {
      // The provider is what answers, so without one the button would open on
      // nothing and the blur would spend a request establishing that.
      mockLookupAvailable = false;
      renderCreate();

      expect(
        screen.queryByRole('button', { name: 'Look up details' }),
      ).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.blur(screen.getByLabelText('Payee Name'), {
          target: { value: 'Starbucks' },
        });
      });

      expect(lookupContact).not.toHaveBeenCalled();
    });

    const nameInput = () => screen.getByLabelText('Payee Name') as HTMLInputElement;
    const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

    async function blurName(value: string) {
      await act(async () => {
        fireEvent.change(nameInput(), { target: { value } });
        fireEvent.blur(nameInput());
      });
    }

    it('looks the name up on blur and fills the empty contact fields as suggestions', async () => {
      renderCreate();
      await blurName('Acme');

      await waitFor(() => expect(field('Website').value).toBe('https://acme.example'));
      expect(lookupContact).toHaveBeenCalledTimes(1);
      expect(lookupContact).toHaveBeenCalledWith('Acme', {}, expect.any(AbortSignal));
      expect(field('Address').value).toBe('1 Main St');
      expect(field('Email').value).toBe('hi@acme.example');
      expect(field('Phone').value).toBe('+1 206 448 8762');
      expect(screen.getByText('Suggested by lookup:')).toBeInTheDocument();
      expect(screen.getByText('Undo lookup changes')).toBeInTheDocument();
    });

    it('shows a filled phone the way a person reads one, never the stored form', async () => {
      // The suggestion arrives as E.164 and the field is what a person types
      // into. Putting the stored form in it makes this input read one way when
      // the payee loads (`defaultValues` formats) and another when a lookup
      // fills it -- and an extension would arrive as the machine-only
      // `;ext=` suffix, in a box labelled Phone.
      lookupContact.mockResolvedValue({
        reason: 'ok',
        suggestions: [{ ...suggestion, phone: '+442079460958;ext=12' }],
      } as any);
      renderCreate();
      await blurName('Acme');

      await waitFor(() => expect(field('Phone').value).toBe('+44 20 7946 0958 x12'));
      expect(field('Phone').value).not.toContain(';ext=');
    });

    it('does not call a number that did not change a replacement', async () => {
      // The stored phone and the suggestion are the SAME number. Comparing the
      // field (read form) against the suggestion (stored form) makes them look
      // different, so the form rewrote the field and told the user it had
      // replaced their value -- for a number nobody changed.
      lookupContact.mockResolvedValue({
        reason: 'ok',
        suggestions: [{ ...suggestion, refined: ['phone'] }],
      } as any);
      const payee = {
        id: 'p1',
        name: 'Acme',
        defaultCategoryId: '',
        notes: '',
        website: '',
        address: '',
        email: '',
        phone: '+12064488762',
      } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Look up details'));
      });

      await waitFor(() => expect(lookupContact).toHaveBeenCalled());
      expect(field('Phone').value).toBe('+1 206 448 8762');
      expect(screen.queryByText('Replaced by lookup:')).not.toBeInTheDocument();
    });

    it('never overwrites a value the user typed', async () => {
      renderCreate();
      await act(async () => {
        fireEvent.change(field('Website'), { target: { value: 'typed.example' } });
      });
      await blurName('Acme');

      await waitFor(() => expect(field('Phone').value).toBe('+1 206 448 8762'));
      expect(field('Website').value).toBe('typed.example');
    });

    it('does not look the same name up twice, and skips a name too short to be worth it', async () => {
      renderCreate();
      await blurName('Ac');
      expect(lookupContact).not.toHaveBeenCalled();
      await blurName('Acme');
      await blurName('Acme');
      expect(lookupContact).toHaveBeenCalledTimes(1);
    });

    it('drops an answer whose request was overtaken by a newer name', async () => {
      let resolveFirst!: (value: unknown) => void;
      lookupContact
        .mockImplementationOnce(
          () => new Promise((resolve) => { resolveFirst = resolve; }) as any,
        )
        .mockResolvedValueOnce({
          reason: 'ok',
          suggestions: [{ ...suggestion, website: 'https://second.example', phone: null }],
        } as any);
      renderCreate();

      await blurName('Acme');
      await blurName('Acme Corp');
      await waitFor(() => expect(field('Website').value).toBe('https://second.example'));

      await act(async () => {
        resolveFirst({ reason: 'ok', suggestions: [suggestion] });
      });
      // The first answer arrived last and was not adopted.
      expect(field('Website').value).toBe('https://second.example');
      expect(field('Phone').value).toBe('');
    });

    it('undoes only the suggested fields', async () => {
      renderCreate();
      await act(async () => {
        fireEvent.change(field('Email'), { target: { value: 'mine@example.com' } });
      });
      await blurName('Acme');
      await waitFor(() => expect(field('Website').value).toBe('https://acme.example'));

      await act(async () => {
        fireEvent.click(screen.getByText('Undo lookup changes'));
      });

      expect(field('Website').value).toBe('');
      expect(field('Address').value).toBe('');
      expect(field('Phone').value).toBe('');
      expect(field('Email').value).toBe('mine@example.com');
      expect(screen.queryByText('Suggested by lookup:')).not.toBeInTheDocument();
    });

    it('shows a failure as a failure, never as nothing found', async () => {
      lookupContact.mockResolvedValue({
        reason: 'failed',
        suggestions: [],
        detail: 'Your MCP relay agent is not connected.',
      } as any);
      renderCreate();
      await blurName('Acme');

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Your MCP relay agent is not connected.',
      );
      expect(screen.queryByText(/No public contact details/)).not.toBeInTheDocument();
    });

    it('explains a missing source with a link to the payee lookup settings', async () => {
      // Not AI Settings: Google Places can answer this lookup too, so the fix
      // is the section that configures either one.
      lookupContact.mockResolvedValue({ reason: 'no_provider', suggestions: [] } as any);
      renderCreate();
      await blurName('Acme');

      const link = await screen.findByRole('link', {
        name: 'Payee lookup settings',
      });
      expect(link).toHaveAttribute('href', '/settings#payee-lookup');
    });

    it('reports a spent monthly limit as its own reason', async () => {
      // Distinct from no_provider: the repair is the Google Places limit, not
      // configuring a provider the user may never have wanted.
      lookupContact.mockResolvedValue({
        reason: 'quota_exceeded',
        suggestions: [],
      } as any);
      renderCreate();
      await blurName('Acme');

      expect(
        await screen.findByText(/Google Places lookups are used up/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/No public contact details/),
      ).not.toBeInTheDocument();
    });

    it('says when nothing was found', async () => {
      lookupContact.mockResolvedValue({ reason: 'none', suggestions: [] } as any);
      renderCreate();
      await blurName('Acme');

      expect(
        await screen.findByText('No public contact details were found for this name.'),
      ).toBeInTheDocument();
    });

    it('does not look up automatically when the preference is off, but the button still does', async () => {
      mockLookupEnabled = false;
      renderCreate();
      await blurName('Acme');
      expect(lookupContact).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByText('Look up details'));
      });
      await waitFor(() =>
        expect(lookupContact).toHaveBeenCalledWith('Acme', {}, expect.any(AbortSignal)),
      );
    });

    it('sends the notes, address and other values the form already holds as context', async () => {
      renderCreate();
      await act(async () => {
        fireEvent.change(field('Address'), { target: { value: '  Toronto  ' } });
        fireEvent.change(field('Notes (optional)'), { target: { value: 'the Dundas branch' } });
      });
      await blurName('Acme');

      await waitFor(() => expect(lookupContact).toHaveBeenCalledTimes(1));
      expect(lookupContact).toHaveBeenCalledWith(
        'Acme',
        { address: 'Toronto', notes: 'the Dundas branch' },
        expect.any(AbortSignal),
      );
    });

    it('replaces a value the lookup refined, names it separately, and restores it on undo', async () => {
      lookupContact.mockResolvedValue({
        reason: 'ok',
        suggestions: [
          {
            ...suggestion,
            address: '100 Dundas St W\nToronto, Ontario M5G 1Z9\nCanada',
            refined: ['address'],
          },
        ],
      } as any);
      renderCreate();
      await act(async () => {
        fireEvent.change(field('Address'), { target: { value: 'Toronto' } });
      });
      await blurName('Acme');

      await waitFor(() =>
        expect(field('Address').value).toBe('100 Dundas St W\nToronto, Ontario M5G 1Z9\nCanada'),
      );
      expect(screen.getByText('Replaced by lookup:')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Undo lookup changes'));
      });
      // The undo puts back what the user typed -- it is what told the lookup
      // where to look, and blanking it would lose that.
      expect(field('Address').value).toBe('Toronto');
      expect(field('Website').value).toBe('');
    });

    it('restores the value the user typed after a second lookup replaces the first answer', async () => {
      const refinedTo = (address: string) => ({
        reason: 'ok',
        suggestions: [{ ...suggestion, address, refined: ['address'] }],
      });
      lookupContact
        .mockResolvedValueOnce(refinedTo('100 Queen St W, Toronto') as any)
        .mockResolvedValueOnce(refinedTo('483 Bay St, Toronto') as any);
      renderCreate();
      await act(async () => {
        fireEvent.change(field('Address'), { target: { value: 'Toronto' } });
      });
      await blurName('Acme');
      await waitFor(() => expect(field('Address').value).toBe('100 Queen St W, Toronto'));

      await act(async () => {
        fireEvent.click(screen.getByText('Look up details'));
      });
      await waitFor(() => expect(field('Address').value).toBe('483 Bay St, Toronto'));

      await act(async () => {
        fireEvent.click(screen.getByText('Undo lookup changes'));
      });
      expect(field('Address').value).toBe('Toronto');
    });

    it('leaves a filled field alone when the server did not call the answer a refinement', async () => {
      lookupContact.mockResolvedValue({
        reason: 'ok',
        suggestions: [{ ...suggestion, address: 'Somewhere else entirely', refined: [] }],
      } as any);
      renderCreate();
      await act(async () => {
        fireEvent.change(field('Address'), { target: { value: 'Toronto' } });
      });
      await blurName('Acme');

      await waitFor(() => expect(field('Phone').value).toBe('+1 206 448 8762'));
      expect(field('Address').value).toBe('Toronto');
      expect(screen.queryByText('Replaced by lookup:')).not.toBeInTheDocument();
    });

    it('never looks up on blur when editing, and the button fills only the empty fields', async () => {
      const payee = {
        id: 'p1',
        name: 'Acme',
        defaultCategoryId: '',
        notes: '',
        website: 'https://stored.example',
        address: '',
        email: '',
        phone: '',
      } as any;
      await act(async () => {
        render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
      });
      await blurName('Acme Renamed');
      expect(lookupContact).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByText('Look up details'));
      });
      await waitFor(() => expect(field('Phone').value).toBe('+1 206 448 8762'));
      expect(lookupContact).toHaveBeenCalledWith(
        'Acme Renamed',
        { website: 'https://stored.example' },
        expect.any(AbortSignal),
      );
      expect(field('Website').value).toBe('https://stored.example');
    });
  });
});
