import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import SharedAccessPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title }: any) => <h1>{title}</h1>,
}));
vi.mock('@/components/settings/SharedAccessSection', () => ({
  SharedAccessSection: () => <div data-testid="shared-access-section" />,
}));

const mockUseDemoMode = vi.fn();
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

describe('SharedAccessPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the section when not in demo mode', () => {
    mockUseDemoMode.mockReturnValue(false);
    render(<SharedAccessPage />);
    expect(screen.getByText('Shared Access')).toBeInTheDocument();
    expect(screen.getByTestId('shared-access-section')).toBeInTheDocument();
  });

  it('shows a restricted message in demo mode', () => {
    mockUseDemoMode.mockReturnValue(true);
    render(<SharedAccessPage />);
    expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
    expect(
      screen.queryByTestId('shared-access-section'),
    ).not.toBeInTheDocument();
  });
});
