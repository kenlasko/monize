import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { AuthShell } from './AuthShell';
import { CARD_CLASS } from '@/components/ui/Card';

function renderShell(ui: React.ReactElement) {
  return render(ui);
}

describe('AuthShell', () => {
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
