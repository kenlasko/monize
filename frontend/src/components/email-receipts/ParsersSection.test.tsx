import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ParsersSection } from './ParsersSection';
import { makeParser } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  receiptsList: vi.fn(),
}));
const payeesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const categoriesApi = vi.hoisted(() => ({ getAll: vi.fn() }));

vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    parsers: { list: api.list, approve: api.approve, remove: api.remove, create: api.create, update: api.update, test: api.test },
    receipts: { list: api.receiptsList },
  },
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi,
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function conflict() {
  return new AxiosError('conflict', '409', undefined, undefined, { status: 409, data: { message: 'moved' } } as never);
}

async function renderSection() {
  await act(async () => {
    render(<ParsersSection />);
  });
  await act(async () => {});
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

const approved = makeParser();
const draft = makeParser({ id: 'p-2', name: 'Amazon draft', status: 'draft', source: 'ai', payeeId: null, fromDomains: ['amazon.com'], revision: 5 });

describe('ParsersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([approved, draft]);
    api.receiptsList.mockResolvedValue([]);
    payeesApi.getAll.mockResolvedValue([{ id: 'payee-1', name: 'Allegro' }]);
    categoriesApi.getAll.mockResolvedValue([]);
  });

  it('lists each parser with its domains, status, source and payee', async () => {
    await renderSection();
    const approvedRow = screen.getByRole('row', { name: /Allegro parser/ });
    expect(within(approvedRow).getByText('allegro.pl')).toBeInTheDocument();
    expect(within(approvedRow).getByText('Approved')).toBeInTheDocument();
    expect(within(approvedRow).getByText('Written by you')).toBeInTheDocument();
    expect(within(approvedRow).getByText('Allegro')).toBeInTheDocument();

    const draftRow = screen.getByRole('row', { name: /Amazon draft/ });
    expect(within(draftRow).getByText('Draft')).toBeInTheDocument();
    expect(within(draftRow).getByText('Drafted by AI')).toBeInTheDocument();
    expect(within(draftRow).getByText('No payee')).toBeInTheDocument();
  });

  it('flags a parser whose stored definition is not valid and does not offer to approve it', async () => {
    api.list.mockResolvedValue([makeParser({ status: 'draft', definitionValid: false })]);
    await renderSection();
    const row = screen.getByRole('row', { name: /Allegro parser/ });
    expect(within(row).getByText('Invalid')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers to approve a draft only', async () => {
    await renderSection();
    expect(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Allegro parser/ })).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  describe('approve', () => {
    it('approves at the revision the person read and updates the row', async () => {
      api.approve.mockResolvedValue({ ...draft, status: 'approved', revision: 6 });
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' }));
      expect(api.approve).toHaveBeenCalledWith('p-2', 5);
      expect(toast.success).toHaveBeenCalledWith('Parser approved');
      const row = screen.getByRole('row', { name: /Amazon draft/ });
      expect(within(row).getByText('Approved')).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });

    it('says the parser changed elsewhere on a 409 and reloads the list', async () => {
      api.approve.mockRejectedValue(conflict());
      await renderSection();
      expect(api.list).toHaveBeenCalledTimes(1);
      await click(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' }));
      expect(toast.error).toHaveBeenCalledWith('This parser was changed elsewhere. The list has been reloaded.');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('names any other failure', async () => {
      api.approve.mockRejectedValue({ response: { data: { message: 'Not valid' } } });
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' }));
      expect(toast.error).toHaveBeenCalledWith('Not valid');
    });
  });

  describe('delete', () => {
    it('asks first, and deletes nothing when cancelled', async () => {
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Delete' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/The parser Allegro parser will be deleted/)).toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(api.remove).not.toHaveBeenCalled();
      expect(screen.getByRole('row', { name: /Allegro parser/ })).toBeInTheDocument();
    });

    it('deletes on confirmation and removes the row', async () => {
      api.remove.mockResolvedValue(undefined);
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Delete' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(api.remove).toHaveBeenCalledWith('p-1');
      expect(toast.success).toHaveBeenCalledWith('Parser deleted');
      expect(screen.queryByRole('row', { name: /Allegro parser/ })).not.toBeInTheDocument();
    });

    it('keeps the row and names the failure', async () => {
      api.remove.mockRejectedValue({ response: { data: { message: 'Cannot delete' } } });
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Delete' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(toast.error).toHaveBeenCalledWith('Cannot delete');
      expect(screen.getByRole('row', { name: /Allegro parser/ })).toBeInTheDocument();
    });
  });

  describe('the editor', () => {
    it('opens empty for a new parser and reloads the list after a save', async () => {
      api.create.mockResolvedValue(makeParser({ id: 'p-3' }));
      await renderSection();
      await click(screen.getByRole('button', { name: 'New parser' }));
      expect(screen.getByRole('dialog', { name: 'New parser' })).toBeInTheDocument();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Shop' } });
        fireEvent.change(screen.getByLabelText('Sender domains'), { target: { value: 'shop.example' } });
      });
      await click(screen.getByRole('button', { name: 'Save parser' }));
      expect(api.create).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('opens a stored parser for editing', async () => {
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Edit' }));
      expect(screen.getByRole('dialog', { name: 'Edit parser' })).toBeInTheDocument();
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Allegro parser');
    });

    it('closes the editor and reloads the list when the parser moved on under it', async () => {
      api.update.mockRejectedValue(conflict());
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Edit' }));
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
      });
      await click(screen.getByRole('button', { name: 'Save parser' }));
      await click(screen.getByRole('button', { name: 'Reload the parser' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  it('says a payee is not found only when the payee list loaded without it', async () => {
    payeesApi.getAll.mockResolvedValue([]);
    await renderSection();
    expect(within(screen.getByRole('row', { name: /Allegro parser/ })).getByText('Payee not found')).toBeInTheDocument();
  });

  it('says there are no parsers only when the list loaded empty', async () => {
    api.list.mockResolvedValue([]);
    await renderSection();
    expect(screen.getByText('No parsers yet')).toBeInTheDocument();
  });

  it('shows a failed load as an error with a retry, never as an empty list', async () => {
    api.list.mockRejectedValueOnce(new Error('boom'));
    await renderSection();
    expect(screen.getByRole('alert')).toHaveTextContent('The parsers could not be loaded');
    expect(screen.queryByText('No parsers yet')).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('row', { name: /Allegro parser/ })).toBeInTheDocument();
  });

  it('says the payee list is unavailable when it could not be loaded, not that the payee is gone', async () => {
    payeesApi.getAll.mockRejectedValue(new Error('boom'));
    await renderSection();
    const row = screen.getByRole('row', { name: /Allegro parser/ });
    expect(within(row).queryByText('No payee')).not.toBeInTheDocument();
    // A payee list that failed to load is not a payee that does not exist.
    expect(within(row).queryByText('Payee not found')).not.toBeInTheDocument();
    expect(within(row).getByText('Payee list unavailable')).toBeInTheDocument();
  });
});
