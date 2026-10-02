import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { act, fireEvent, render, screen, within } from '@/test/render';
import {
  BANK_SYNC_PRIVACY_TEMPLATE_URL,
  BANK_SYNC_TERMS_TEMPLATE_URL,
  ENABLE_BANKING_REGISTRATION,
} from '@/lib/bank-sync-links';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@/types/auth';
import { BankSyncRegistrationValues } from './BankSyncRegistrationValues';

const REDIRECT = 'https://monize.example/settings/bank-sync/callback';
const EMAIL = 'owner@example.test';

const user = (over: Partial<User> = {}): User => ({
  id: 'user-1',
  email: EMAIL,
  authProvider: 'local',
  role: 'user',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const LABELS = [
  "Choose your application's environment",
  'Choose how to generate a private RSA key',
  'Application name',
  'Allowed redirect URLs',
  'Application description',
  'Email for data protection matters',
  'Privacy URL of the application',
  'Terms URL of the application',
];

const VALUES = [
  'Production',
  'Generate in the browser (using SubtleCrypto) and export private key',
  'Monize',
  REDIRECT,
  ENABLE_BANKING_REGISTRATION.description,
  EMAIL,
  BANK_SYNC_PRIVACY_TEMPLATE_URL,
  BANK_SYNC_TERMS_TEMPLATE_URL,
];

/** The definition-list parts, in document order (jsdom maps no role to dt/dd). */
const terms = (container: HTMLElement) => Array.from(container.querySelectorAll('dt'));
const definitions = (container: HTMLElement) => Array.from(container.querySelectorAll('dd'));

const copyButton = (label: string) => screen.queryByRole('button', { name: `Copy ${label}` });

// Reset before each test, where nothing is mounted and the write needs no act().
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: user(), isAuthenticated: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('BankSyncRegistrationValues', () => {
  it('lists the eight form labels in order, each with its value', () => {
    const { container } = render(<BankSyncRegistrationValues redirectUrl={REDIRECT} />);

    expect(terms(container).map((term) => term.textContent)).toEqual(LABELS);
    expect(definitions(container)).toHaveLength(8);
    definitions(container).forEach((definition, index) => {
      expect(definition).toHaveTextContent(VALUES[index]);
    });
  });

  it('titles the block and explains why it is in English and what the two URLs are', () => {
    render(<BankSyncRegistrationValues redirectUrl={REDIRECT} />);

    expect(
      screen.getByRole('heading', { name: 'Values to paste into the form' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The labels and values stay in English because the control panel is in English.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The two URLs point to the Monize templates. In restricted mode Enable Banking does not check them. If other people use your Monize instance, publish your own pages with your name instead.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the redirect URL it was given, not a value of its own', () => {
    const { container } = render(
      <BankSyncRegistrationValues redirectUrl="https://other.example/cb" />,
    );

    expect(definitions(container)[3]).toHaveTextContent('https://other.example/cb');
  });

  it('has no copy button for the two radio choices', () => {
    render(<BankSyncRegistrationValues redirectUrl={REDIRECT} />);

    expect(copyButton(LABELS[0])).toBeNull();
    expect(copyButton(LABELS[1])).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it.each([
    [2, 'Monize'],
    [3, REDIRECT],
    [4, ENABLE_BANKING_REGISTRATION.description],
    [5, EMAIL],
    [6, BANK_SYNC_PRIVACY_TEMPLATE_URL],
    [7, BANK_SYNC_TERMS_TEMPLATE_URL],
  ])('copies the exact value of row %i', async (index, value) => {
    render(<BankSyncRegistrationValues redirectUrl={REDIRECT} />);

    await act(async () => {
      fireEvent.click(copyButton(LABELS[index]) as HTMLElement);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(value);
    expect(toast.success).toHaveBeenCalledWith('Copied');
  });

  it('keeps the button inside its own row, never around the row', () => {
    const { container } = render(<BankSyncRegistrationValues redirectUrl={REDIRECT} />);

    const rows = definitions(container);
    expect(within(rows[2]).getAllByRole('button')).toHaveLength(1);
    expect(within(rows[0]).queryByRole('button')).toBeNull();
    for (const button of screen.getAllByRole('button')) {
      expect(button.querySelector('a, button')).toBeNull();
    }
  });

  it('reports a copy that failed', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'));
    render(<BankSyncRegistrationValues redirectUrl={REDIRECT} />);

    await act(async () => {
      fireEvent.click(copyButton(LABELS[2]) as HTMLElement);
    });

    expect(toast.error).toHaveBeenCalledWith('Could not copy');
    expect(toast.success).not.toHaveBeenCalled();
  });

  describe('when no email is known', () => {
    it.each([
      ['no signed-in user', null],
      ['a blank email', user({ email: '   ' })],
    ])('shows a placeholder and no copy button for %s', (_name, signedIn) => {
      useAuthStore.setState({ user: signedIn, isAuthenticated: signedIn !== null });
      const { container } = render(<BankSyncRegistrationValues redirectUrl={REDIRECT} />);

      const definition = definitions(container)[5];
      const placeholder = within(definition).getByText('Your email address');
      expect(placeholder).toHaveClass('italic');
      expect(within(definition).queryByRole('button')).toBeNull();
      expect(copyButton(LABELS[5])).toBeNull();
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });
  });
});
