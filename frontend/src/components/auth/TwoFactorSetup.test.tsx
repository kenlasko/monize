import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import toast from 'react-hot-toast';

const mockSetupData = {
  secret: 'JBSWY3DPEHPK3PXP',
  qrCodeDataUrl: 'data:image/png;base64,fakeqrcode',
  otpauthUrl: 'otpauth://totp/Monize:test@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Monize',
};

vi.mock('@/lib/auth', () => ({
  authApi: {
    setup2FA: vi.fn(),
    confirmSetup2FA: vi.fn(),
  },
}));

describe('TwoFactorSetup', () => {
  const onComplete = vi.fn();
  const onSkip = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state on mount while fetching setup data', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockReturnValue(new Promise(() => {})); // never resolves

    render(<TwoFactorSetup onComplete={onComplete} />);

    // Should show a spinner (the loading div contains animate-spin)
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('displays QR code after setup data loads', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockResolvedValue(mockSetupData);

    render(<TwoFactorSetup onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByAltText('2FA QR Code')).toBeInTheDocument();
    });

    const qrImage = screen.getByAltText('2FA QR Code') as HTMLImageElement;
    expect(qrImage.src).toBe(mockSetupData.qrCodeDataUrl);
  });

  it('shows error state when setup fails', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockRejectedValue({
      response: { data: { message: 'Setup failed' } },
    });

    render(<TwoFactorSetup onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load 2FA setup. Please try again.')).toBeInTheDocument();
    });
  });

  it('toggles manual key display when clicked', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockResolvedValue(mockSetupData);

    render(<TwoFactorSetup onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("Can't scan? Enter key manually")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Can't scan? Enter key manually"));
    expect(screen.getByText(mockSetupData.secret)).toBeInTheDocument();
    expect(screen.getByText('Hide manual key')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Hide manual key'));
    expect(screen.queryByText(mockSetupData.secret)).not.toBeInTheDocument();
  });

  it('filters non-digit characters from code input', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockResolvedValue(mockSetupData);

    render(<TwoFactorSetup onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('000000');
    fireEvent.change(input, { target: { value: '12ab34' } });
    expect(input).toHaveValue('1234');
  });

  it('calls confirmSetup2FA and onComplete on successful verification', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockResolvedValue(mockSetupData);
    vi.mocked(authApi.confirmSetup2FA).mockResolvedValue({ message: 'ok' });

    render(<TwoFactorSetup onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('000000');
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify and Enable'));

    await waitFor(() => {
      expect(authApi.confirmSetup2FA).toHaveBeenCalledWith('123456');
      expect(toast.success).toHaveBeenCalledWith('Two-factor authentication enabled!');
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('shows error toast on failed verification', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockResolvedValue(mockSetupData);
    vi.mocked(authApi.confirmSetup2FA).mockRejectedValue({
      response: { data: { message: 'Invalid code' } },
    });

    render(<TwoFactorSetup onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('000000');
    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.click(screen.getByText('Verify and Enable'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Invalid code');
    });
  });

  it('shows skip button when onSkip is provided and not forced', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockResolvedValue(mockSetupData);

    render(<TwoFactorSetup onComplete={onComplete} onSkip={onSkip} isForced={false} />);

    await waitFor(() => {
      expect(screen.getByText('Skip for now')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Skip for now'));
    expect(onSkip).toHaveBeenCalled();
  });

  it('hides skip button when isForced is true', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.setup2FA).mockResolvedValue(mockSetupData);

    render(<TwoFactorSetup onComplete={onComplete} onSkip={onSkip} isForced={true} />);

    await waitFor(() => {
      expect(screen.getByText('Verify and Enable')).toBeInTheDocument();
    });

    expect(screen.queryByText('Skip for now')).not.toBeInTheDocument();
  });
});
