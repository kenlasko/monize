import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import toast from 'react-hot-toast';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { BankSyncConnectDialog } from './BankSyncConnectDialog';
import type { BankInstitution } from '@/types/bank-sync';

// jsdom does not implement scrollIntoView (the Combobox scrolls its highlight).
Element.prototype.scrollIntoView = vi.fn();

const mockListInstitutions = vi.fn();
const mockCreateConnection = vi.fn();

vi.mock('@/lib/bank-sync', () => ({
  bankSyncApi: {
    listInstitutions: (...args: unknown[]) => mockListInstitutions(...args),
    createConnection: (...args: unknown[]) => mockCreateConnection(...args),
  },
}));

const institution = (over: Partial<BankInstitution> = {}): BankInstitution => ({
  name: 'Alpha Bank',
  country: 'PL',
  logoUrl: null,
  psuTypes: ['personal', 'business'],
  maximumConsentValidityDays: 90,
  ...over,
});

const originalLocation = window.location;
const assign = vi.fn();

async function renderDialog() {
  const onClose = vi.fn();
  await act(async () => {
    render(<BankSyncConnectDialog isOpen onClose={onClose} />);
  });
  return { onClose };
}

async function chooseCountry(code: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: code } });
  });
}

async function chooseBank(name: string) {
  const input = screen.getByRole('textbox');
  await act(async () => {
    fireEvent.click(input);
  });
  await act(async () => {
    fireEvent.click(screen.getByText(name));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    value: { ...originalLocation, assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe('BankSyncConnectDialog', () => {
  it('explains the second authorization before anything is asked, naming the renew button', async () => {
    await renderDialog();

    const paragraph = screen.getByText(/^You authorize at your bank again here/);
    expect(paragraph.tagName).toBe('P');
    expect(paragraph).toHaveTextContent(
      'You authorize at your bank again here, even if you already linked the same accounts in the Enable Banking control panel. The control panel only lists which accounts the application may read, and its consent ends the same day. This step gives Monize its own consent to read balances and transactions, for up to 180 days. When it is about to end, the connection card shows "Renew consent".',
    );
    // First in the body, above the first field.
    const country = screen.getByLabelText('Country');
    expect(
      paragraph.compareDocumentPosition(country) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('offers the EEA countries, named in the reader\'s language', async () => {
    await renderDialog();

    const select = screen.getByLabelText('Country') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[0]).toBe('Select a country');
    expect(labels).toContain('Poland');
    expect(labels).toContain('Germany');
    expect(select.options.length).toBe(31);
    // Nothing is fetched until a country is chosen, and Continue is not live.
    expect(mockListInstitutions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue to bank' })).toBeDisabled();
  });

  it('loads the banks of the chosen country and lets the user search them', async () => {
    mockListInstitutions.mockResolvedValue([
      institution(),
      institution({ name: 'Beta Credit' }),
    ]);
    await renderDialog();

    await chooseCountry('PL');

    expect(mockListInstitutions).toHaveBeenCalledWith('PL');
    const input = await screen.findByRole('textbox');
    await act(async () => {
      fireEvent.click(input);
    });
    expect(screen.getByText('Alpha Bank')).toBeInTheDocument();
    // The combobox ignores input for a moment after it opens.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: 'beta' } });
    });
    expect(screen.queryByText('Alpha Bank')).toBeNull();
    expect(screen.getByText('Beta Credit')).toBeInTheDocument();
  });

  it('reports a failed list with a retry, not as an empty one', async () => {
    mockListInstitutions.mockRejectedValueOnce(new Error('down'));
    await renderDialog();

    await chooseCountry('PL');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the list of banks.',
    );
    expect(screen.queryByText('The provider lists no banks for this country.')).toBeNull();

    mockListInstitutions.mockResolvedValueOnce([institution()]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(mockListInstitutions).toHaveBeenCalledTimes(2);
  });

  it('says so when the provider lists no banks for the country', async () => {
    mockListInstitutions.mockResolvedValue([]);
    await renderDialog();

    await chooseCountry('IS');

    expect(
      await screen.findByText('The provider lists no banks for this country.'),
    ).toBeInTheDocument();
  });

  it('does not show a slow answer for a country the user has already left', async () => {
    let resolvePoland: (value: BankInstitution[]) => void = () => {};
    mockListInstitutions.mockImplementation((country: string) =>
      country === 'PL'
        ? new Promise<BankInstitution[]>((resolve) => {
            resolvePoland = resolve;
          })
        : Promise.resolve([institution({ name: 'German Bank', country: 'DE' })]),
    );
    await renderDialog();

    await chooseCountry('PL');
    await chooseCountry('DE');
    await act(async () => {
      resolvePoland([institution({ name: 'Polish Bank' })]);
    });

    const input = await screen.findByRole('textbox');
    await act(async () => {
      fireEvent.click(input);
    });
    expect(screen.getByText('German Bank')).toBeInTheDocument();
    expect(screen.queryByText('Polish Bank')).toBeNull();
  });

  it('limits the account holder to what the bank supports', async () => {
    mockListInstitutions.mockResolvedValue([institution({ psuTypes: ['business'] })]);
    await renderDialog();

    await chooseCountry('PL');
    await chooseBank('Alpha Bank');

    const select = screen.getByLabelText('Account holder') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['business']);
    expect(select.value).toBe('business');
  });

  it('states the longest consent the bank allows, and nothing when it is unknown', async () => {
    mockListInstitutions.mockResolvedValue([
      institution(),
      institution({ name: 'Beta Credit', maximumConsentValidityDays: null }),
    ]);
    await renderDialog();

    await chooseCountry('PL');
    await chooseBank('Alpha Bank');
    expect(screen.getByText(/up to 90 days/)).toBeInTheDocument();

    await chooseBank('Beta Credit');
    expect(screen.queryByText(/before you must renew it/)).toBeNull();
  });

  it('states the consent the server will request: the bank\'s maximum capped at 180 days', async () => {
    mockListInstitutions.mockResolvedValue([
      institution({ name: 'Long Bank', maximumConsentValidityDays: 365 }),
      institution({ name: 'Exact Bank', maximumConsentValidityDays: 180 }),
    ]);
    await renderDialog();

    await chooseCountry('PL');
    await chooseBank('Long Bank');
    expect(screen.getByText(/This bank allows access for up to 180 days/)).toBeInTheDocument();
    expect(screen.queryByText(/up to 365 days/)).toBeNull();

    await chooseBank('Exact Bank');
    expect(screen.getByText(/This bank allows access for up to 180 days/)).toBeInTheDocument();
  });

  it('creates the connection and sends the browser to the bank', async () => {
    mockListInstitutions.mockResolvedValue([institution()]);
    mockCreateConnection.mockResolvedValue({
      connectionId: 'c1',
      authorizationUrl: 'https://bank.example/authorize?state=abc',
    });
    await renderDialog();

    await chooseCountry('PL');
    await chooseBank('Alpha Bank');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue to bank' }));
    });

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://bank.example/authorize?state=abc'),
    );
    expect(mockCreateConnection).toHaveBeenCalledWith({
      institutionName: 'Alpha Bank',
      country: 'PL',
      psuType: 'personal',
    });
  });

  it.each([
    ['a javascript: address', 'javascript:alert(1)'],
    ['a plain http address', 'http://bank.example/authorize'],
    ['a data: address', 'data:text/html,<script>1</script>'],
    ['an empty address', ''],
  ])('does not navigate to %s', async (_label, authorizationUrl) => {
    mockListInstitutions.mockResolvedValue([institution()]);
    mockCreateConnection.mockResolvedValue({ connectionId: 'c1', authorizationUrl });
    await renderDialog();

    await chooseCountry('PL');
    await chooseBank('Alpha Bank');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue to bank' }));
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The bank address returned by the server is not a secure https address, so Monize did not open it.',
      ),
    );
    expect(assign).not.toHaveBeenCalled();
    // The user can try again.
    expect(screen.getByRole('button', { name: 'Continue to bank' })).toBeEnabled();
  });

  it('shows the server message when the connection cannot be started', async () => {
    mockListInstitutions.mockResolvedValue([institution()]);
    mockCreateConnection.mockRejectedValue({
      response: { data: { message: 'Add your credentials first' } },
    });
    await renderDialog();

    await chooseCountry('PL');
    await chooseBank('Alpha Bank');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue to bank' }));
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Add your credentials first'),
    );
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue to bank' })).toBeEnabled();
  });

  it('closes through Cancel', async () => {
    const { onClose } = await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
  });
});
