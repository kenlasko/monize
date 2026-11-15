import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import EmergencyClaimPage from './page';

const pushMock = vi.fn();
const searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParams,
}));

vi.mock('@/lib/emergency-access', () => ({
  emergencyAccessApi: {
    previewClaim: vi.fn(),
    completeClaim: vi.fn(),
  },
}));

import { emergencyAccessApi } from '@/lib/emergency-access';
const api = emergencyAccessApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

async function renderPage() {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(<EmergencyClaimPage />);
  });
  return result!;
}

describe('EmergencyClaimPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Array.from(searchParams.keys()).forEach((k) => searchParams.delete(k));
  });

  it('renders an error when token query param is missing', async () => {
    await renderPage();
    expect(
      screen.getByText(/Missing emergency access token/),
    ).toBeInTheDocument();
    expect(api.previewClaim).not.toHaveBeenCalled();
  });

  it('shows the contact greeting and password form, but not the owner or message', async () => {
    searchParams.set('token', 'abc');
    // A stale server that still sends the owner's details must not get them
    // rendered before the claim succeeds (#2173).
    api.previewClaim.mockResolvedValue({
      ownerFirstName: 'Owner',
      ownerLastName: 'One',
      contactFirstName: 'Carol',
      message: 'Bank info is in the safe.',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Hi Carol/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Owner One/)).not.toBeInTheDocument();
    expect(
      screen.queryByText('Bank info is in the safe.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/New Password/i)).toBeInTheDocument();
  });

  it('shows the owner message after a successful claim, then continues to the dashboard', async () => {
    searchParams.set('token', 'abc');
    api.previewClaim.mockResolvedValue({
      contactFirstName: 'Carol',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    api.completeClaim.mockResolvedValue({
      ok: true,
      ownerFirstName: 'Owner',
      ownerLastName: 'One',
      message: 'Bank info is in the safe.',
    });
    await renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText(/New Password/i)).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/New Password/i), {
        target: { value: 'CorrectHorse99!' },
      });
      fireEvent.change(screen.getByLabelText(/Confirm Password/i), {
        target: { value: 'CorrectHorse99!' },
      });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Claim emergency access/i }),
      );
    });

    await waitFor(() =>
      expect(screen.getByText('Bank info is in the safe.')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Message from Owner/)).toBeInTheDocument();
    expect(screen.getByText(/Message from Owner/)).toHaveFocus();
    expect(pushMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Continue to dashboard/i }),
      );
    });
    expect(pushMock).toHaveBeenCalledWith('/dashboard');
  });

  it('completes the claim and navigates to the dashboard', async () => {
    searchParams.set('token', 'abc');
    api.previewClaim.mockResolvedValue({
      contactFirstName: 'Carol',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    api.completeClaim.mockResolvedValue({
      ok: true,
      ownerFirstName: 'Owner',
      ownerLastName: 'One',
      message: null,
    });
    await renderPage();

    await waitFor(() =>
      expect(screen.getByLabelText(/New Password/i)).toBeInTheDocument(),
    );

    const pw = screen.getByLabelText(/New Password/i);
    const confirm = screen.getByLabelText(/Confirm Password/i);
    await act(async () => {
      fireEvent.change(pw, { target: { value: 'CorrectHorse99!' } });
      fireEvent.change(confirm, { target: { value: 'CorrectHorse99!' } });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Claim emergency access/i }),
      );
    });
    await waitFor(() =>
      expect(api.completeClaim).toHaveBeenCalledWith(
        'abc',
        'CorrectHorse99!',
      ),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'));
  });

  it('shows an error UI when the preview fails', async () => {
    searchParams.set('token', 'expired');
    api.previewClaim.mockRejectedValue(
      new Error('Link expired or already used'),
    );
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/Link expired or already used/),
      ).toBeInTheDocument(),
    );
  });

  it('keeps the user on the page when completeClaim fails', async () => {
    searchParams.set('token', 'abc');
    api.previewClaim.mockResolvedValue({
      contactFirstName: 'Carol',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    api.completeClaim.mockRejectedValue(new Error('already claimed'));
    await renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText(/New Password/i)).toBeInTheDocument(),
    );
    const pw = screen.getByLabelText(/New Password/i);
    const confirm = screen.getByLabelText(/Confirm Password/i);
    await act(async () => {
      fireEvent.change(pw, { target: { value: 'CorrectHorse99!' } });
      fireEvent.change(confirm, { target: { value: 'CorrectHorse99!' } });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Claim emergency access/i }),
      );
    });
    await act(async () => {});
    await waitFor(() => expect(api.completeClaim).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
  });
});
