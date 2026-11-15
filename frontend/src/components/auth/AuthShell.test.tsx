import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, act } from '@/test/render';
import { authApi } from '@/lib/auth';
import { AuthShell } from './AuthShell';
import { CARD_CLASS } from '@/components/ui/Card';

vi.mock('@/lib/auth', () => ({ authApi: { getAuthMethods: vi.fn() } }));
const getAuthMethods = vi.mocked(authApi.getAuthMethods);
const SHOT = 'auth-brand-shot-dashboard-overview';

function renderShell(ui: React.ReactElement) {
  return render(ui);
}

async function renderSettled(ui: React.ReactElement) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(ui);
  });
  return view;
}

describe('AuthShell', () => {
  beforeEach(() => {
    getAuthMethods.mockReset();
    // Pending by default: a sync test must not see a state update land outside act().
    getAuthMethods.mockReturnValue(new Promise(() => {}));
  });

  it('renders the transparent brand mark, title, subtitle and body', () => {
    const { getByRole, getByText, getByAltText } = renderShell(
      <AuthShell title="Sign in" subtitle={<span>or register</span>}>
        <div>form body</div>
      </AuthShell>,
    );
    expect(getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(getByText('or register')).toBeInTheDocument();
    expect(getByText('form body')).toBeInTheDocument();
    // The boxed logo bakes in a white background rect and renders as a white
    // square in dark mode; the shell must use the transparent mark.
    const logo = getByAltText('Monize') as HTMLImageElement;
    expect(logo.src).toContain('monize-logo-transparent');
    // Over the heading at every width, not only where the brand panel is hidden.
    expect(logo.className).not.toContain('hidden');
  });

  it('sets the brand panel beside the form on every screen', () => {
    const { getByTestId } = renderShell(<AuthShell title="t">x</AuthShell>);
    expect(getByTestId('auth-brand-panel')).toBeInTheDocument();
  });

  it('shows the panel at once, with no picture until the server answers', async () => {
    getAuthMethods.mockReturnValue(new Promise(() => {}));
    const { getByTestId, queryByTestId, container } = await renderSettled(
      <AuthShell title="t">x</AuthShell>,
    );
    expect(getByTestId('auth-brand-panel')).toBeInTheDocument();
    expect(queryByTestId(SHOT)).not.toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain('lg:grid-cols-2');
  });

  it('adds the picture once the server allows the panel', async () => {
    getAuthMethods.mockResolvedValue({ brandPanel: true } as never);
    const { getByTestId } = await renderSettled(<AuthShell title="t">x</AuthShell>);
    expect(getByTestId(SHOT)).toBeInTheDocument();
  });

  it('keeps the panel without a picture when the request fails', async () => {
    getAuthMethods.mockRejectedValue(new Error('network'));
    const { getByTestId, queryByTestId } = await renderSettled(<AuthShell title="t">x</AuthShell>);
    expect(getByTestId('auth-brand-panel')).toBeInTheDocument();
    expect(queryByTestId(SHOT)).not.toBeInTheDocument();
  });

  it('drops the panel and the second column when the administrator hides it', async () => {
    getAuthMethods.mockResolvedValue({ brandPanel: false } as never);
    const { queryByTestId, container, getByText } = await renderSettled(
      <AuthShell title="t">x</AuthShell>,
    );
    expect(queryByTestId('auth-brand-panel')).not.toBeInTheDocument();
    expect(container.firstElementChild?.className).not.toContain('grid');
    expect(getByText('x')).toBeInTheDocument();
  });

  it('wraps the body in the shared Card surface', () => {
    const { getByText } = renderShell(
      <AuthShell title="t">
        <div>inside</div>
      </AuthShell>,
    );
    const card = getByText('inside').parentElement as HTMLElement;
    for (const cls of CARD_CLASS.split(/\s+/)) {
      expect(card.classList.contains(cls)).toBe(true);
    }
  });

  it('renders the body bare when plain is set', () => {
    const { getByText } = renderShell(
      <AuthShell plain>
        <p>status line</p>
      </AuthShell>,
    );
    const body = getByText('status line');
    expect(body.parentElement?.className ?? '').not.toContain('bg-white');
  });

  it('widens the column for multi-field forms', () => {
    const { getByText, rerender } = renderShell(
      <AuthShell wide>
        <div>x</div>
      </AuthShell>,
    );
    expect(document.querySelector('.max-w-lg')).toBeTruthy();
    expect(document.querySelector('.max-w-md')).toBeFalsy();
    rerender(
      <AuthShell>
        <div>x</div>
      </AuthShell>,
    );
    expect(getByText('x')).toBeInTheDocument();
    expect(document.querySelector('.max-w-md')).toBeTruthy();
  });

  it('omits the language picker and version line unless asked', () => {
    renderShell(
      <AuthShell>
        <div>x</div>
      </AuthShell>,
    );
    expect(document.querySelector('select')).toBeFalsy();
  });
});
