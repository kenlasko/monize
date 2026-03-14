import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { HttpWarningBanner } from './HttpWarningBanner';

describe('HttpWarningBanner', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, protocol: 'http:' },
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  it('renders nothing when httpsHeadersActive is false', async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<HttpWarningBanner httpsHeadersActive={false} />));
    });
    expect(container!.firstChild).toBeNull();
  });

  it('renders nothing when protocol is https', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, protocol: 'https:' },
      writable: true,
    });
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<HttpWarningBanner httpsHeadersActive={true} />));
    });
    expect(container!.firstChild).toBeNull();
  });

  it('renders warning when httpsHeadersActive and protocol is http', async () => {
    await act(async () => {
      render(<HttpWarningBanner httpsHeadersActive={true} />);
    });
    expect(screen.getByText('HTTPS Required')).toBeInTheDocument();
  });

  it('displays actionable guidance mentioning DISABLE_HTTPS_HEADERS', async () => {
    await act(async () => {
      render(<HttpWarningBanner httpsHeadersActive={true} />);
    });
    expect(screen.getByText('DISABLE_HTTPS_HEADERS=true')).toBeInTheDocument();
  });

  it('renders HTTPS Required label in bold', async () => {
    await act(async () => {
      render(<HttpWarningBanner httpsHeadersActive={true} />);
    });
    const label = screen.getByText('HTTPS Required');
    expect(label.tagName).toBe('SPAN');
    expect(label.className).toContain('font-semibold');
  });

  it('uses amber color scheme', async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<HttpWarningBanner httpsHeadersActive={true} />));
    });
    const banner = container!.firstChild as HTMLElement;
    expect(banner.className).toContain('bg-amber-50');
    expect(banner.className).toContain('text-amber-800');
  });

  it('dismiss button hides the banner', async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<HttpWarningBanner httpsHeadersActive={true} />));
    });
    expect(container!.firstChild).not.toBeNull();

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss HTTPS warning' });
    await act(async () => {
      fireEvent.click(dismissBtn);
    });
    expect(container!.firstChild).toBeNull();
  });

  it('dismiss button has accessible aria-label', async () => {
    await act(async () => {
      render(<HttpWarningBanner httpsHeadersActive={true} />);
    });
    expect(screen.getByLabelText('Dismiss HTTPS warning')).toBeInTheDocument();
  });
});
