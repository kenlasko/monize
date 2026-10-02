import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { ENABLE_BANKING_CONTROL_PANEL_URL } from '@/lib/bank-sync-links';
import { BankSyncCredentialsModal } from './BankSyncCredentialsModal';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----';

function renderModal(over: { applicationId?: string | null; privateKeySet?: boolean } = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <BankSyncCredentialsModal
      isOpen
      applicationId={over.applicationId ?? null}
      privateKeySet={over.privateKeySet ?? false}
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { onSave, onClose };
}

const APP_UUID = '3f2b8c1e-9a4d-4e6f-8b1a-0c5d7e9f2a64';

function keyFile(content: string, name = 'key.pem') {
  return new File([content], name, { type: 'application/x-pem-file' });
}

const loadInput = () => screen.getByLabelText('Load key file') as HTMLInputElement;
const loadFile = async (file: File) => {
  await act(async () => {
    fireEvent.change(loadInput(), { target: { files: [file] } });
  });
};

const applicationIdField = () => screen.getByLabelText('Application ID');
const keyField = () => screen.getByLabelText('Private key (PEM)');
const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BankSyncCredentialsModal', () => {
  it('never renders a stored key, only a placeholder saying one is stored', () => {
    renderModal({ applicationId: 'app-1', privateKeySet: true });

    expect(keyField()).toHaveValue('');
    expect(keyField().getAttribute('placeholder')).toMatch(/A key is stored/);
    expect(applicationIdField()).toHaveValue('app-1');
  });

  it('shows the plain placeholder when no key is stored', () => {
    renderModal();

    expect(keyField().getAttribute('placeholder')).not.toMatch(/A key is stored/);
  });

  it('declares the key field as not this site\'s credential and unchecked by spelling', () => {
    renderModal();

    expect(keyField()).toHaveAttribute('autocomplete', 'off');
    expect(keyField()).toHaveAttribute('spellcheck', 'false');
  });

  it('omits the key when the field was left alone and one is stored', async () => {
    const { onSave } = renderModal({ applicationId: 'app-1', privateKeySet: true });

    await submit();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ applicationId: 'app-1' });
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('privateKey');
  });

  it('treats a whitespace-only key like an untouched one when one is stored', async () => {
    const { onSave } = renderModal({ applicationId: 'app-1', privateKeySet: true });

    fireEvent.change(keyField(), { target: { value: '   \n ' } });
    await submit();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('privateKey');
  });

  it('requires a key when none is stored', async () => {
    const { onSave } = renderModal();

    fireEvent.change(applicationIdField(), { target: { value: 'app-1' } });
    await submit();

    expect(await screen.findByText('Enter the private key')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('requires the application ID', async () => {
    const { onSave } = renderModal({ privateKeySet: true });

    await submit();

    expect(await screen.findByText('Enter the application ID')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([
    ['plain text', 'not a key'],
    ['a certificate', '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'],
    ['a public key', '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----'],
  ])('refuses %s as the key', async (_label, value) => {
    const { onSave } = renderModal({ applicationId: 'app-1' });

    fireEvent.change(keyField(), { target: { value } });
    await submit();

    expect(
      await screen.findByText(/does not look like a PEM private key/),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sends a pasted PEM key with the application ID, trimmed', async () => {
    const { onSave } = renderModal();

    fireEvent.change(applicationIdField(), { target: { value: '  app-2  ' } });
    fireEvent.change(keyField(), { target: { value: `\n${PEM}\n` } });
    await submit();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ applicationId: 'app-2', privateKey: PEM });
  });

  it('accepts an RSA PRIVATE KEY block as well', async () => {
    const { onSave } = renderModal({ applicationId: 'app-1' });
    const rsa = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

    fireEvent.change(keyField(), { target: { value: rsa } });
    await submit();

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ applicationId: 'app-1', privateKey: rsa }));
  });

  it('says where to get the credentials, linking the control panel in a new tab', () => {
    renderModal();

    expect(
      screen.getByText(/Get the application ID and the private key from the/),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Enable Banking control panel' });
    expect(link).toHaveAttribute('href', ENABLE_BANKING_CONTROL_PANEL_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('closes through Cancel without saving', async () => {
    const { onSave, onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  describe('loading the key from a file', () => {
    it('offers a button that opens a hidden file input limited to key files', () => {
      renderModal();

      expect(screen.getByRole('button', { name: 'Load key file' })).toBeInTheDocument();
      expect(loadInput()).toHaveAttribute('type', 'file');
      expect(loadInput()).toHaveAttribute(
        'accept',
        '.pem,.key,application/x-pem-file,text/plain',
      );
      expect(loadInput()).toHaveClass('hidden');
    });

    it('fills the key field with the content of the file', async () => {
      renderModal({ applicationId: 'app-1' });

      await loadFile(keyFile(PEM));

      await waitFor(() => expect(keyField()).toHaveValue(PEM));
    });

    it('sends the loaded key when saving', async () => {
      const { onSave } = renderModal({ applicationId: 'app-1' });

      await loadFile(keyFile(PEM));
      await waitFor(() => expect(keyField()).toHaveValue(PEM));
      await submit();

      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith({ applicationId: 'app-1', privateKey: PEM }),
      );
    });

    it('lets the same file be chosen again by resetting the input', async () => {
      renderModal({ applicationId: 'app-1' });

      await loadFile(keyFile(PEM));

      expect(loadInput().value).toBe('');
    });

    it('fills an empty application ID from a file named after a UUID', async () => {
      renderModal();

      await loadFile(keyFile(PEM, `${APP_UUID}.pem`));

      await waitFor(() => expect(applicationIdField()).toHaveValue(APP_UUID));
      expect(keyField()).toHaveValue(PEM);
    });

    it('reads the UUID case-insensitively', async () => {
      renderModal();

      await loadFile(keyFile(PEM, `${APP_UUID.toUpperCase()}.key`));

      await waitFor(() => expect(applicationIdField()).toHaveValue(APP_UUID.toUpperCase()));
    });

    it('does not overwrite an application ID the user already typed', async () => {
      renderModal();
      fireEvent.change(applicationIdField(), { target: { value: 'typed-id' } });

      await loadFile(keyFile(PEM, `${APP_UUID}.pem`));

      await waitFor(() => expect(keyField()).toHaveValue(PEM));
      expect(applicationIdField()).toHaveValue('typed-id');
    });

    it('does not overwrite the stored application ID', async () => {
      renderModal({ applicationId: 'stored-id', privateKeySet: true });

      await loadFile(keyFile(PEM, `${APP_UUID}.pem`));

      await waitFor(() => expect(keyField()).toHaveValue(PEM));
      expect(applicationIdField()).toHaveValue('stored-id');
    });

    it('leaves the application ID empty when the file name is not a UUID', async () => {
      renderModal();

      await loadFile(keyFile(PEM, 'private.pem'));

      await waitFor(() => expect(keyField()).toHaveValue(PEM));
      expect(applicationIdField()).toHaveValue('');
    });

    it('refuses a file over 16 KB, says so under the field and keeps the text', async () => {
      renderModal({ applicationId: 'app-1' });
      fireEvent.change(keyField(), { target: { value: PEM } });

      await loadFile(keyFile('A'.repeat(16 * 1024 + 1), `${APP_UUID}.pem`));

      expect(
        await screen.findByText(
          'The file is larger than 16 KB. Select the .pem file that Enable Banking saved.',
        ),
      ).toBeInTheDocument();
      expect(keyField()).toHaveValue(PEM);
      expect(applicationIdField()).toHaveValue('app-1');
    });

    it('accepts a file of exactly 16 KB', async () => {
      renderModal({ applicationId: 'app-1' });
      const content = 'A'.repeat(16 * 1024);

      await loadFile(keyFile(content));

      await waitFor(() => expect(keyField()).toHaveValue(content));
      expect(screen.queryByText(/larger than 16 KB/)).toBeNull();
    });

    it('clears the size error once a valid file is loaded', async () => {
      renderModal({ applicationId: 'app-1' });

      await loadFile(keyFile('A'.repeat(16 * 1024 + 1)));
      await screen.findByText(/larger than 16 KB/);
      await loadFile(keyFile(PEM));

      await waitFor(() => expect(keyField()).toHaveValue(PEM));
      expect(screen.queryByText(/larger than 16 KB/)).toBeNull();
    });

    it('says the file could not be read and keeps the text', async () => {
      renderModal({ applicationId: 'app-1' });
      fireEvent.change(keyField(), { target: { value: PEM } });
      const file = keyFile(PEM);
      Object.defineProperty(file, 'text', {
        value: () => Promise.reject(new Error('denied')),
      });

      await loadFile(file);

      expect(await screen.findByText('Could not read the file.')).toBeInTheDocument();
      expect(keyField()).toHaveValue(PEM);
    });

    it('does nothing when the picker is cancelled', async () => {
      renderModal({ applicationId: 'app-1' });
      fireEvent.change(keyField(), { target: { value: PEM } });

      await act(async () => {
        fireEvent.change(loadInput(), { target: { files: [] } });
      });

      expect(keyField()).toHaveValue(PEM);
    });

    it('validates the loaded content like pasted text', async () => {
      renderModal({ applicationId: 'app-1' });

      await loadFile(keyFile('not a key'));

      expect(
        await screen.findByText(/does not look like a PEM private key/),
      ).toBeInTheDocument();
    });
  });
});
