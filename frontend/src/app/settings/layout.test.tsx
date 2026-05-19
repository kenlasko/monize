import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import SettingsLayout from './layout';

const replaceMock = vi.fn();
let pathname = '/settings';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => pathname,
}));

let actingAsUserId: string | null = null;
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => selector({ actingAsUserId }),
}));

describe('SettingsLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actingAsUserId = null;
    pathname = '/settings';
  });

  it('renders children for a normal (non-delegate) user', () => {
    render(
      <SettingsLayout>
        <div data-testid="child">settings</div>
      </SettingsLayout>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('renders children for a delegate at the root /settings (Security-only view)', () => {
    actingAsUserId = 'owner-1';
    pathname = '/settings';
    render(
      <SettingsLayout>
        <div data-testid="child">settings</div>
      </SettingsLayout>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('redirects a delegate away from a /settings sub-route back to /settings', () => {
    actingAsUserId = 'owner-1';
    pathname = '/settings/shared-access';
    render(
      <SettingsLayout>
        <div data-testid="child">settings</div>
      </SettingsLayout>,
    );
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith('/settings');
  });
});
