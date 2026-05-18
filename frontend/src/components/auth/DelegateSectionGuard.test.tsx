import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { DelegateSectionGuard } from './DelegateSectionGuard';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

let state: {
  actingAsUserId: string | null;
  delegateSections: Record<string, boolean> | null;
};

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

describe('DelegateSectionGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state = { actingAsUserId: null, delegateSections: null };
  });

  it('renders children for a non-delegate', () => {
    render(
      <DelegateSectionGuard section="bills">
        <p>content</p>
      </DelegateSectionGuard>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('renders nothing while acting before sections load', () => {
    state = { actingAsUserId: 'o1', delegateSections: null };
    render(
      <DelegateSectionGuard section="bills">
        <p>content</p>
      </DelegateSectionGuard>,
    );
    expect(screen.queryByText('content')).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('renders children when the section is granted', () => {
    state = {
      actingAsUserId: 'o1',
      delegateSections: { bills: true },
    };
    render(
      <DelegateSectionGuard section="bills">
        <p>content</p>
      </DelegateSectionGuard>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects to dashboard when the section is not granted', async () => {
    state = {
      actingAsUserId: 'o1',
      delegateSections: { bills: false },
    };
    render(
      <DelegateSectionGuard section="bills">
        <p>content</p>
      </DelegateSectionGuard>,
    );
    expect(screen.queryByText('content')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/dashboard'),
    );
  });
});
