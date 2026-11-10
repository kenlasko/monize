import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import type { Attachment } from '@/types/attachment';
import { WarrantyAddExistingDocument } from './WarrantyAddExistingDocument';

const list = vi.fn();
const copyToWarranty = vi.fn();

vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  attachmentsApi: {
    list: (...args: unknown[]) => list(...args),
    copyToWarranty: (...args: unknown[]) => copyToWarranty(...args),
  },
}));

// The pickers have their own tests; here each is one choice.
vi.mock('@/components/shared-expenses/SharedTransactionPicker', () => ({
  SharedTransactionPicker: ({ onChoose }: { onChoose: (row: { id: string }) => void }) => (
    <button type="button" onClick={() => onChoose({ id: 'purchase' })}>
      pick purchase
    </button>
  ),
}));
vi.mock('@/components/shared-expenses/SharedWarrantyPicker', () => ({
  SharedWarrantyPicker: ({ onChoose }: { onChoose: (id: string) => void }) => (
    <button type="button" onClick={() => onChoose('other-warranty')}>
      pick warranty
    </button>
  ),
}));

const file = (patch: Partial<Attachment>): Attachment => ({
  id: 'receipt',
  transactionId: 'purchase',
  warrantyId: null,
  documentKind: 'other',
  filename: 'receipt.pdf',
  contentType: 'application/pdf',
  byteSize: 10,
  sha256: 'x',
  createdAt: '2026-01-01T00:00:00Z',
  ...patch,
});

async function open() {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    render(<WarrantyAddExistingDocument warrantyId="this-warranty" onAdded={onAdded} onClose={onClose} />);
  });
  return { onAdded, onClose };
}

describe('WarrantyAddExistingDocument', () => {
  beforeEach(() => {
    list.mockReset();
    copyToWarranty.mockReset().mockResolvedValue(file({ id: 'copy' }));
  });

  it("copies a transaction's file onto the warranty as a receipt by default", async () => {
    list.mockResolvedValue([file({})]);
    const { onAdded, onClose } = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick purchase' }));
    });
    expect(list).toHaveBeenCalledWith({ transactionId: 'purchase' });
    expect(screen.getByRole('button', { name: 'Add Document' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'receipt' } });
    expect(screen.getByLabelText('Document type on this warranty')).toHaveValue('receipt');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Document' }));
    });
    expect(copyToWarranty).toHaveBeenCalledWith('this-warranty', 'receipt', 'receipt', expect.any(String));
    expect(onAdded).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("takes another warranty's document with its own type", async () => {
    list.mockResolvedValue([file({ id: 'manual', transactionId: null, warrantyId: 'other-warranty', documentKind: 'manual' })]);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Another warranty' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick warranty' }));
    });
    expect(list).toHaveBeenCalledWith({ warrantyId: 'other-warranty' });
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'manual' } });
    expect(screen.getByLabelText('Document type on this warranty')).toHaveValue('manual');
  });

  it("starts a transaction's file as a receipt, whatever an earlier pick was", async () => {
    list.mockImplementation((parent: { warrantyId?: string }) =>
      Promise.resolve(
        parent.warrantyId
          ? [file({ id: 'manual', transactionId: null, warrantyId: 'other-warranty', documentKind: 'manual' })]
          : [file({})],
      ),
    );
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Another warranty' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick warranty' }));
    });
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'manual' } });
    expect(screen.getByLabelText('Document type on this warranty')).toHaveValue('manual');
    fireEvent.click(screen.getByRole('button', { name: 'A transaction' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick purchase' }));
    });
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'receipt' } });
    expect(screen.getByLabelText('Document type on this warranty')).toHaveValue('receipt');
  });

  it('sends a new request id once the choice changes, the same one on a plain retry', async () => {
    list.mockResolvedValue([file({}), file({ id: 'other', filename: 'other.pdf' })]);
    copyToWarranty.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout'));
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick purchase' }));
    });
    const submit = async () =>
      act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Add Document' }));
      });
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'receipt' } });
    await submit();
    await submit();
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'other' } });
    await submit();
    const ids = copyToWarranty.mock.calls.map((call) => call[3]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it('does not offer what this warranty already holds', async () => {
    list.mockResolvedValue([file({ id: 'mine', warrantyId: 'this-warranty', transactionId: null })]);
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick purchase' }));
    });
    expect(screen.queryByLabelText('Document')).not.toBeInTheDocument();
    expect(screen.getByText('There are no documents here to add.')).toBeInTheDocument();
  });

  it("shows the server's refusal and stays open", async () => {
    list.mockResolvedValue([file({})]);
    copyToWarranty.mockRejectedValue({ response: { data: { message: 'This document is already on this warranty' } } });
    const { onAdded, onClose } = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick purchase' }));
    });
    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'receipt' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Document' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/already on this warranty|Failed to add the document/);
    expect(onAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
