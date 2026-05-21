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
});
