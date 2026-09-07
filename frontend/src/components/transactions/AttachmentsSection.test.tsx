import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import toast from 'react-hot-toast';
import { AttachmentsSection } from './AttachmentsSection';
import { attachmentsApi } from '@/lib/attachments';
import {
  Attachment,
  MAX_ATTACHMENT_BYTES,
  StagedAttachment,
} from '@/types/attachment';

/**
 * The scan dialog is replaced by a stub that reports the file it was given and
 * accepts on demand. Its own behaviour has its own suite; what is under test
 * here is the wiring -- which control opens it, what reaches the upload, and
 * how a pair is listed.
 */
vi.mock('./DocumentScanDialog', () => ({
  DocumentScanDialog: ({
    isOpen,
    file,
    onAccept,
  }: {
    isOpen: boolean;
    file: File | null;
    onAccept: (outcome: { file: File; original?: File }) => void;
  }) =>
    isOpen ? (
      <div data-testid="scan-dialog">
        <span data-testid="scan-source">{file?.name}</span>
        <button
          type="button"
          onClick={() =>
            onAccept({
              file: new File(['scan'], 'receipt-scan.jpg', {
                type: 'image/jpeg',
              }),
              original: file ?? undefined,
            })
          }
        >
          accept-pair
        </button>
        <button
          type="button"
          onClick={() =>
            onAccept({
              file: new File(['scan'], 'receipt-scan.jpg', {
                type: 'image/jpeg',
              }),
            })
          }
        >
          accept-scan-only
        </button>
      </div>
    ) : null,
}));

vi.mock('@/lib/attachments', () => ({
  attachmentsApi: { list: vi.fn(), upload: vi.fn(), delete: vi.fn() },
  attachmentDownloadUrl: (id: string) => `/api/v1/attachments/${id}/download`,
}));

const mockList = attachmentsApi.list as ReturnType<typeof vi.fn>;
const mockUpload = attachmentsApi.upload as ReturnType<typeof vi.fn>;
const mockDelete = attachmentsApi.delete as ReturnType<typeof vi.fn>;

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a-1',
    transactionId: 't-1',
    filename: 'receipt.png',
    contentType: 'image/png',
    byteSize: 2048,
    sha256: 'abc',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

async function renderSection() {
  await act(async () => {
    render(<AttachmentsSection transactionId="t-1" />);
  });
}

function fileOfType(type: string, size = 100): File {
  const file = new File(['x'], 'f', { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('AttachmentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([]);
  });

  it('shows the empty state when there are no attachments', async () => {
    await renderSection();
    expect(screen.getByText('No attachments yet')).toBeInTheDocument();
  });

  it('lists attachments with a working download link', async () => {
    mockList.mockResolvedValue([makeAttachment()]);
    await renderSection();
    const link = screen.getByRole('link', { name: 'receipt.png' });
    expect(link).toHaveAttribute(
      'href',
      '/api/v1/attachments/a-1/download',
    );
  });

  it('reports failure to load', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    await renderSection();
    await act(async () => {});
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('uploads a valid file and refreshes', async () => {
    mockList.mockResolvedValue([]);
    mockUpload.mockResolvedValue(makeAttachment());
    await renderSection();

    const input = screen.getByLabelText('Add attachment') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [fileOfType('image/png')] } });
    });

    await waitFor(() =>
      // A plain upload carries no original: only a scan produces a pair, so
      // this path must never send a second file.
      expect(mockUpload).toHaveBeenCalledWith(
        't-1',
        expect.any(File),
        undefined,
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('Attachment added');
    // Refreshed once on mount, once after upload.
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('rejects an unsupported file type without uploading', async () => {
    await renderSection();
    const input = screen.getByLabelText('Add attachment') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [fileOfType('text/plain')] },
      });
    });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('rejects a file over the size limit', async () => {
    await renderSection();
    const input = screen.getByLabelText('Add attachment') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [fileOfType('image/png', MAX_ATTACHMENT_BYTES + 1)],
        },
      });
    });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('deletes an attachment after confirmation', async () => {
    mockList.mockResolvedValue([makeAttachment()]);
    mockDelete.mockResolvedValue(undefined);
    await renderSection();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    // Confirm dialog appears; click its confirm action.
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    });

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('a-1'));
    expect(toast.success).toHaveBeenCalledWith('Attachment deleted');
  });

  describe('scanning a document', () => {
    const scanInput = () =>
      screen.getByLabelText('Scan document') as HTMLInputElement;

    function photo(size = 1024, type = 'image/jpeg'): File {
      const file = new File(['photo'], 'receipt.jpg', { type });
      Object.defineProperty(file, 'size', { value: size });
      return file;
    }

    it('offers scanning beside the plain upload', async () => {
      await renderSection();
      expect(
        screen.getByRole('button', { name: 'Scan document' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Add attachment' }),
      ).toBeInTheDocument();
    });

    it('opens the dialog with the chosen photo', async () => {
      await renderSection();

      await act(async () => {
        fireEvent.change(scanInput(), { target: { files: [photo()] } });
      });

      expect(screen.getByTestId('scan-source')).toHaveTextContent('receipt.jpg');
    });

    it('uploads both halves in one request when a pair is accepted', async () => {
      mockUpload.mockResolvedValue(makeAttachment());
      await renderSection();
      await act(async () => {
        fireEvent.change(scanInput(), { target: { files: [photo()] } });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'accept-pair' }));
      });

      await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
      const [transactionId, file, original] = mockUpload.mock.calls[0];
      expect(transactionId).toBe('t-1');
      expect((file as File).name).toBe('receipt-scan.jpg');
      expect((original as File).name).toBe('receipt.jpg');
    });

    it('uploads the scan alone when no original comes back', async () => {
      mockUpload.mockResolvedValue(makeAttachment());
      await renderSection();
      await act(async () => {
        fireEvent.change(scanInput(), { target: { files: [photo()] } });
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'accept-scan-only' }),
        );
      });

      await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
      expect(mockUpload.mock.calls[0][2]).toBeUndefined();
    });

    // Scanning a photo that cannot then be attached wastes the user's time on
    // a result they will be refused, so the limits are checked first.
    it('refuses a photo over the size limit before scanning it', async () => {
      await renderSection();

      await act(async () => {
        fireEvent.change(scanInput(), {
          target: { files: [photo(MAX_ATTACHMENT_BYTES + 1)] },
        });
      });

      expect(screen.queryByTestId('scan-dialog')).not.toBeInTheDocument();
      expect(toast.error).toHaveBeenCalled();
    });

    // The scanner re-encodes its output as a JPEG, so a format that could not
    // be attached as-is is still worth scanning.
    it('accepts a photo whose own type is not an allowed attachment type', async () => {
      await renderSection();

      await act(async () => {
        fireEvent.change(scanInput(), {
          target: { files: [photo(1024, 'image/heic')] },
        });
      });

      expect(screen.getByTestId('scan-dialog')).toBeInTheDocument();
    });

    it('shows a link to the original on a scanned attachment', async () => {
      mockList.mockResolvedValue([
        makeAttachment({
          id: 'scan-1',
          filename: 'receipt-scan.jpg',
          originalAttachmentId: 'orig-1',
        }),
      ]);
      await renderSection();

      const link = screen.getByRole('link', { name: 'View original' });
      expect(link).toHaveAttribute(
        'href',
        '/api/v1/attachments/orig-1/download',
      );
    });

    it('shows no such link on an ordinary attachment', async () => {
      mockList.mockResolvedValue([makeAttachment()]);
      await renderSection();

      expect(
        screen.queryByRole('link', { name: 'View original' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('staged mode', () => {
    function renderStaged(files: StagedAttachment[], onChange = vi.fn()) {
      render(
        <AttachmentsSection stagedFiles={files} onStagedFilesChange={onChange} />,
      );
      return onChange;
    }

    it('does not touch the server and shows the empty state', () => {
      renderStaged([]);
      expect(screen.getByText('No attachments yet')).toBeInTheDocument();
      expect(mockList).not.toHaveBeenCalled();
    });

    it('stages a valid file via the change handler without uploading', () => {
      const onChange = renderStaged([]);
      const input = screen.getByLabelText('Add attachment') as HTMLInputElement;
      const file = fileOfType('image/png');
      fireEvent.change(input, { target: { files: [file] } });

      // Staged as a pair-shaped entry with no original: an ordinary upload is
      // one file, and the shape is what the create-time loop reads.
      expect(onChange).toHaveBeenCalledWith([{ file }]);
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('rejects an unsupported staged file', () => {
      const onChange = renderStaged([]);
      const input = screen.getByLabelText('Add attachment') as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [fileOfType('text/plain')] },
      });

      expect(onChange).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
    });

    it('stages a scanned pair as one entry', () => {
      const onChange = renderStaged([]);
      const photo = fileOfType('image/jpeg');
      Object.defineProperty(photo, 'name', { value: 'receipt.jpg' });

      fireEvent.change(screen.getByLabelText('Scan document'), {
        target: { files: [photo] },
      });
      fireEvent.click(screen.getByRole('button', { name: 'accept-pair' }));

      // One entry carrying both halves: it counts once against the cap, and
      // the create-time loop uploads both in a single request.
      expect(onChange).toHaveBeenCalledTimes(1);
      const staged = onChange.mock.calls[0][0] as StagedAttachment[];
      expect(staged).toHaveLength(1);
      expect(staged[0].file.name).toBe('receipt-scan.jpg');
      expect(staged[0].original?.name).toBe('receipt.jpg');
    });

    it('marks a staged pair as keeping its original', () => {
      const scan = fileOfType('image/jpeg');
      Object.defineProperty(scan, 'name', { value: 'receipt-scan.jpg' });
      const original = fileOfType('image/jpeg');
      renderStaged([{ file: scan, original }]);

      expect(screen.getByText(/original kept/i)).toBeInTheDocument();
    });

    it('lists staged files with a remove control', () => {
      const file = fileOfType('application/pdf');
      Object.defineProperty(file, 'name', { value: 'invoice.pdf' });
      const onChange = renderStaged([{ file }]);

      expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      expect(onChange).toHaveBeenCalledWith([]);
    });
  });
});
