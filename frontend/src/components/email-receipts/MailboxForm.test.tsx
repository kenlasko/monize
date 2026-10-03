import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act } from '@/test/render';
import { MailboxForm } from './MailboxForm';
import { makeMailbox } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ upsert: vi.fn(), test: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { mailbox: api } }));

const onSaved = vi.fn();

async function renderForm(mailbox: Parameters<typeof MailboxForm>[0]['mailbox']) {
  await act(async () => {
    render(<MailboxForm mailbox={mailbox} onSaved={onSaved} />);
  });
}

async function type(label: string, value: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

describe('MailboxForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('a new mailbox', () => {
    it('cannot be saved until the login is complete, password included', async () => {
      await renderForm(null);
      const save = screen.getByRole('button', { name: 'Save mailbox' });
      expect(save).toBeDisabled();
      await type('IMAP server', 'imap.example.com');
      await type('User name', 'me@example.com');
      expect(save).toBeDisabled();
      await type('Password', 'app-password');
      expect(save).toBeEnabled();
    });

    it('saves the whole configuration, sending the password it was typed', async () => {
      api.upsert.mockResolvedValue(makeMailbox());
      await renderForm(null);
      await type('IMAP server', ' imap.example.com ');
      await type('User name', 'me@example.com');
      await type('Password', 'app-password');
      await click(screen.getByRole('button', { name: 'Save mailbox' }));

      expect(api.upsert).toHaveBeenCalledWith({
        host: 'imap.example.com',
        port: 993,
        security: 'tls',
        username: 'me@example.com',
        password: 'app-password',
        folder: 'INBOX',
        enabled: false,
        aiMode: 'off',
        autoApply: false,
      });
      expect(onSaved).toHaveBeenCalledWith(makeMailbox());
      expect(toast.success).toHaveBeenCalledWith('Mailbox saved');
    });

    it('moves the port with the security mode only while the port is still the default', async () => {
      await renderForm(null);
      const port = screen.getByLabelText('Port') as HTMLInputElement;
      expect(port.value).toBe('993');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Connection security'), { target: { value: 'starttls' } });
      });
      expect(port.value).toBe('143');

      await act(async () => {
        fireEvent.change(port, { target: { value: '1143' } });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Connection security'), { target: { value: 'tls' } });
      });
      // A custom port is never overwritten.
      expect(port.value).toBe('1143');
    });
  });

  describe('a stored mailbox', () => {
    it('never shows the password: the box is empty and only says one is stored', async () => {
      await renderForm(makeMailbox({ passwordSet: true }));
      const password = screen.getByLabelText('Password') as HTMLInputElement;
      expect(password.value).toBe('');
      expect(password).toHaveAttribute('type', 'password');
      expect(password).toHaveAttribute('autocomplete', 'off');
      expect(password).toHaveAttribute('placeholder', 'A password is stored. Type to replace it.');
      expect(screen.getByText(/Leave blank to keep the stored password/)).toBeInTheDocument();
    });

    it('has no placeholder when no password is stored', async () => {
      await renderForm(makeMailbox({ passwordSet: false }));
      expect(screen.getByLabelText('Password')).not.toHaveAttribute('placeholder');
    });

    it('is not saveable until something changes', async () => {
      await renderForm(makeMailbox());
      expect(screen.getByRole('button', { name: 'Save mailbox' })).toBeDisabled();
    });

    it('sends no password when none was typed, whatever else changed', async () => {
      api.upsert.mockResolvedValue(makeMailbox({ folder: 'Receipts' }));
      await renderForm(makeMailbox());
      await type('Folder', 'Receipts');
      await click(screen.getByRole('button', { name: 'Save mailbox' }));

      expect(api.upsert).toHaveBeenCalledTimes(1);
      const payload = api.upsert.mock.calls[0][0];
      expect(payload).not.toHaveProperty('password');
      expect(payload.folder).toBe('Receipts');
    });

    it('requires a password again when the server or the user name changes', async () => {
      await renderForm(makeMailbox());
      await type('IMAP server', 'imap.other.example');
      expect(screen.getByRole('button', { name: 'Save mailbox' })).toBeDisabled();
      expect(screen.getByText(/Required for a new mailbox, or when the server or user name changes/)).toBeInTheDocument();
      await type('Password', 'new-password');
      expect(screen.getByRole('button', { name: 'Save mailbox' })).toBeEnabled();
    });

    it('sends a typed password to replace the stored one and clears the box afterwards', async () => {
      api.upsert.mockResolvedValue(makeMailbox());
      await renderForm(makeMailbox());
      await type('Password', 'rotated');
      await click(screen.getByRole('button', { name: 'Save mailbox' }));
      expect(api.upsert.mock.calls[0][0].password).toBe('rotated');
      expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
      expect(screen.getByRole('button', { name: 'Save mailbox' })).toBeDisabled();
    });

    it('saves the AI mode and the auto-apply switch', async () => {
      api.upsert.mockResolvedValue(makeMailbox({ aiMode: 'on_demand', autoApply: true }));
      await renderForm(makeMailbox());
      await act(async () => {
        fireEvent.change(screen.getByLabelText('AI mode'), { target: { value: 'on_demand' } });
      });
      await click(screen.getByRole('switch', { name: 'Apply proposals automatically' }));
      await click(screen.getByRole('button', { name: 'Save mailbox' }));
      expect(api.upsert.mock.calls[0][0]).toMatchObject({ aiMode: 'on_demand', autoApply: true });
    });

    it('describes the chosen AI mode under the picker', async () => {
      await renderForm(makeMailbox({ aiMode: 'on_demand' }));
      expect(screen.getByText('The AI is called only when you press Recognize with AI or Draft parser with AI.')).toBeInTheDocument();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('AI mode'), { target: { value: 'automatic' } });
      });
      expect(screen.getByText(/asks the AI about a matched receipt that no approved parser could read completely/)).toBeInTheDocument();
    });

    it('states the gate of auto-apply in its tooltip, so the switch is never a blind one', async () => {
      await renderForm(makeMailbox());
      const help = screen.getByRole('button', { name: /^Off by default\. A proposal is applied without asking only when all of these hold/ });
      expect(help).toHaveAccessibleName(/an approved parser read the whole email/);
      expect(help).toHaveAccessibleName(/by order number or by exact amount and payee with a single candidate/);
      expect(help).toHaveAccessibleName(/adds up to the cent/);
      expect(help).toHaveAccessibleName(/Everything else waits for your approval/);
    });
  });

  it('shows what the server refused beside the fields, and keeps what was typed', async () => {
    api.upsert.mockRejectedValue({ response: { data: { message: 'That host is not allowed' } } });
    await renderForm(null);
    await type('IMAP server', 'localhost');
    await type('User name', 'me');
    await type('Password', 'pw');
    await click(screen.getByRole('button', { name: 'Save mailbox' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That host is not allowed');
    expect((screen.getByLabelText('IMAP server') as HTMLInputElement).value).toBe('localhost');
    expect(onSaved).not.toHaveBeenCalled();
  });

  describe('test connection', () => {
    it('tests the draft on the form, with the typed password only when there is one', async () => {
      api.test.mockResolvedValue({ ok: true, messages: 3 });
      await renderForm(makeMailbox());
      await click(screen.getByRole('button', { name: 'Test connection' }));
      expect(api.test).toHaveBeenCalledWith({
        host: 'imap.example.com',
        port: 993,
        security: 'tls',
        username: 'receipts@example.com',
        folder: 'INBOX',
      });
      expect(screen.getByRole('status')).toHaveTextContent('The connection works. The folder holds 3 messages.');

      await type('Password', 'typed');
      await click(screen.getByRole('button', { name: 'Test connection' }));
      expect(api.test.mock.calls[1][0].password).toBe('typed');
    });

    it('reports a refused connection as an alert', async () => {
      api.test.mockResolvedValue({ ok: false, error: 'Authentication failed' });
      await renderForm(makeMailbox());
      await click(screen.getByRole('button', { name: 'Test connection' }));
      expect(screen.getByRole('alert')).toHaveTextContent('The connection failed: Authentication failed');
    });

    it('reports a failed request as an alert', async () => {
      api.test.mockRejectedValue(new Error('Network Error'));
      await renderForm(makeMailbox());
      await click(screen.getByRole('button', { name: 'Test connection' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Network Error');
    });

    it('is not offered for an empty new form', async () => {
      await renderForm(null);
      expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    });
  });
});
