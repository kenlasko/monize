import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import EmergencyAccessPage from './page';
import type { EmergencyAccessView } from '@/types/emergency-access';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

const mockUseDemoMode = vi.fn();
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

const mockActingAs = vi.fn();
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (s: { actingAsUserId: string | null }) => unknown) =>
    selector({ actingAsUserId: mockActingAs() }),
}));

vi.mock('@/lib/emergency-access', () => ({
  emergencyAccessApi: {
    get: vi.fn(),
    updateSettings: vi.fn(),
    addContact: vi.fn(),
    updateContact: vi.fn(),
    removeContact: vi.fn(),
    reset: vi.fn(),
    previewClaim: vi.fn(),
    completeClaim: vi.fn(),
  },
}));

import { emergencyAccessApi } from '@/lib/emergency-access';
const api = emergencyAccessApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function makeView(overrides: Partial<EmergencyAccessView> = {}): EmergencyAccessView {
  return {
    emailConfigured: true,
    enabled: false,
    grantAfterDays: 14,
    reminderAfterDays: 7,
    message: null,
    lastReminderSentAt: null,
    grantedAt: null,
    lastActivityAt: new Date().toISOString(),
    contacts: [],
    ...overrides,
  };
}

async function renderPage() {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(<EmergencyAccessPage />);
  });
  return result!;
}

describe('EmergencyAccessPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDemoMode.mockReturnValue(false);
    mockActingAs.mockReturnValue(null);
  });

  it('blocks access for delegate sessions', async () => {
    mockActingAs.mockReturnValue('other-user');
    api.get.mockResolvedValue(makeView());
    await renderPage();
    expect(
      screen.getByText(/Emergency access can only be configured by the account owner/),
    ).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('blocks access in demo mode', async () => {
    mockUseDemoMode.mockReturnValue(true);
    await renderPage();
    expect(
      screen.getByText(/Emergency access is disabled in demo mode/),
    ).toBeInTheDocument();
  });

  it('shows the SMTP-not-configured notice when emailConfigured is false', async () => {
    api.get.mockResolvedValue(makeView({ emailConfigured: false }));
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Email is not configured/)).toBeInTheDocument(),
    );
    // Submit button is disabled in this branch
    expect(
      (screen.getByRole('button', { name: /Save settings/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('loads settings + contacts and renders them', async () => {
    api.get.mockResolvedValue(
      makeView({
        enabled: true,
        message: 'top-secret',
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText('Carol')).toBeInTheDocument(),
    );
    expect(screen.getByText('carol@example.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('top-secret')).toBeInTheDocument();
  });

  it('saves settings via the API', async () => {
    const initial = makeView();
    const updated = makeView({ enabled: true, message: 'note' });
    api.get.mockResolvedValue(initial);
    api.updateSettings.mockResolvedValue(updated);
    await renderPage();

    await waitFor(() => screen.getByRole('button', { name: /Save settings/i }));
    const textarea = screen.getByPlaceholderText(/Notes, instructions/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'note' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));
    });

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0]).toMatchObject({
      enabled: false,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      message: 'note',
    });
  });

  it('adds a contact via the API', async () => {
    api.get.mockResolvedValue(makeView());
    api.addContact.mockResolvedValue({
      id: 'new',
      firstName: 'Carol',
      email: 'carol@example.com',
      createdAt: new Date().toISOString(),
    });
    await renderPage();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Add contact/i })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add contact/i }));
    });

    const firstName = screen.getByLabelText(/First name/i);
    const email = screen.getByLabelText(/^Email$/i);
    await act(async () => {
      fireEvent.input(firstName, { target: { value: 'Carol' } });
      fireEvent.input(email, { target: { value: 'carol@example.com' } });
    });
    // Submit the contact form by dispatching a submit event on the form node
    // (react-hook-form's async validation pipeline is more reliable than
    // clicking a button in jsdom).
    const form = firstName.closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
    });
    // Drain any pending promise microtasks
    await act(async () => {});

    await waitFor(() => expect(api.addContact).toHaveBeenCalled());
    expect(api.addContact.mock.calls[0][0]).toEqual({
      firstName: 'Carol',
      email: 'carol@example.com',
    });
  });

  it('renders a warning when access has already been granted', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
  });

  it('renders an unable-to-load message when the initial fetch fails', async () => {
    api.get.mockRejectedValue(new Error('network down'));
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/Unable to load emergency access/),
      ).toBeInTheDocument(),
    );
  });

  it('opens the contact form pre-populated when editing an existing contact', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    api.updateContact.mockResolvedValue({
      id: 'c1',
      firstName: 'Carrie',
      email: 'carrie@example.com',
      createdAt: new Date().toISOString(),
    });
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText('Carol')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    });

    const firstName = screen.getByLabelText(/First name/i);
    expect((firstName as HTMLInputElement).value).toBe('Carol');

    await act(async () => {
      fireEvent.input(firstName, { target: { value: 'Carrie' } });
      fireEvent.input(screen.getByLabelText(/^Email$/i), {
        target: { value: 'carrie@example.com' },
      });
    });
    const form = firstName.closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
    });
    await act(async () => {});

    await waitFor(() => expect(api.updateContact).toHaveBeenCalled());
    expect(api.updateContact.mock.calls[0][0]).toBe('c1');
    expect(api.updateContact.mock.calls[0][1]).toEqual({
      firstName: 'Carrie',
      email: 'carrie@example.com',
    });
  });

  it('removes a contact via the confirm dialog', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    api.removeContact.mockResolvedValue(undefined);
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText('Carol')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    });
    await waitFor(() =>
      expect(screen.getByText('Remove contact')).toBeInTheDocument(),
    );
    // After the dialog opens there are two "Remove" buttons (the list row
    // button and the confirm button). Click the last one, which is the
    // freshly-rendered confirm button.
    const removeButtons = screen.getAllByRole('button', { name: /^Remove$/i });
    await act(async () => {
      fireEvent.click(removeButtons[removeButtons.length - 1]);
    });
    await waitFor(() =>
      expect(api.removeContact).toHaveBeenCalledWith('c1'),
    );
  });

  it('toggles the enable switch via setValue', async () => {
    api.get.mockResolvedValue(makeView());
    api.updateSettings.mockResolvedValue(makeView({ enabled: true }));
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Save settings/i }),
      ).toBeInTheDocument(),
    );
    const toggle = screen.getByRole('switch', {
      name: /Enable emergency access/i,
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));
    });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0].enabled).toBe(true);
  });

  it('shows a toast and stays on the page when reset() fails', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    api.reset.mockRejectedValue(new Error('server down'));
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Clear granted state/i }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Clear' }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    await act(async () => {});
    await waitFor(() => expect(api.reset).toHaveBeenCalled());
    // The warning banner is still on screen because reset() rejected.
    expect(
      screen.getByText('Emergency access already granted'),
    ).toBeInTheDocument();
  });

  it('shows a toast and keeps the contact when removeContact() fails', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    api.removeContact.mockRejectedValue(new Error('still has pending grant'));
    await renderPage();
    await waitFor(() => screen.getByText('Carol'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    });
    await waitFor(() => screen.getByText('Remove contact'));
    const removeButtons = screen.getAllByRole('button', { name: /^Remove$/i });
    await act(async () => {
      fireEvent.click(removeButtons[removeButtons.length - 1]);
    });
    await act(async () => {});
    await waitFor(() => expect(api.removeContact).toHaveBeenCalled());
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });

  it('closes the contact modal via Cancel', async () => {
    api.get.mockResolvedValue(makeView());
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Add contact/i }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add contact/i }));
    });
    await waitFor(() => screen.getByText('Add emergency contact'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    });
    await waitFor(() =>
      expect(
        screen.queryByText('Add emergency contact'),
      ).not.toBeInTheDocument(),
    );
  });

  it('shows a toast when settings save fails', async () => {
    api.get.mockResolvedValue(makeView());
    api.updateSettings.mockRejectedValue(new Error('validation failed'));
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Save settings/i }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));
    });
    await act(async () => {});
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
  });

  it('shows a toast when adding a contact fails', async () => {
    api.get.mockResolvedValue(makeView());
    api.addContact.mockRejectedValue(new Error('duplicate'));
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Add contact/i }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add contact/i }));
    });
    const firstName = screen.getByLabelText(/First name/i);
    await act(async () => {
      fireEvent.input(firstName, { target: { value: 'Carol' } });
      fireEvent.input(screen.getByLabelText(/^Email$/i), {
        target: { value: 'carol@example.com' },
      });
    });
    const form = firstName.closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
    });
    await act(async () => {});
    await waitFor(() => expect(api.addContact).toHaveBeenCalled());
    // Modal stays open because the API rejected.
    expect(screen.getByText('Add emergency contact')).toBeInTheDocument();
  });

  it('cancels the remove-contact confirm dialog without calling the API', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await renderPage();
    await waitFor(() => screen.getByText('Carol'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    });
    await waitFor(() => screen.getByText('Remove contact'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    });
    await waitFor(() =>
      expect(screen.queryByText('Remove contact')).not.toBeInTheDocument(),
    );
    expect(api.removeContact).not.toHaveBeenCalled();
  });

  it('cancels the clear-granted confirm dialog without calling the API', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Clear granted state/i }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Cancel$/i }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    });
    expect(api.reset).not.toHaveBeenCalled();
  });

  it('clears the granted state via the confirm dialog', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    api.reset.mockResolvedValue(makeView());
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Clear granted state/i }),
      );
    });
    // The dialog confirm button is labelled "Clear" (singular) -- look for
    // it by exact name match.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Clear' }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    await waitFor(() => expect(api.reset).toHaveBeenCalled());
  });
});
