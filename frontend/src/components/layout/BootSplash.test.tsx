import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BootSplash, BOOT_SPLASH_ID, type BootSplashStrings } from './BootSplash';

const strings: BootSplashStrings = {
  loading: 'Loading Monize',
  slowMessage: 'This is taking longer than expected. Check your connection.',
  reload: 'Reload the app',
};

describe('BootSplash', () => {
  it('renders the splash with the localized loading label', () => {
    render(<BootSplash bootTheme={null} strings={strings} />);
    const splash = screen.getByRole('status');
    expect(splash).toHaveAttribute('id', BOOT_SPLASH_ID);
    expect(splash).toHaveAttribute('aria-label', 'Loading Monize');
  });

  it('marks the palette as system-driven when no theme cookie was present', () => {
    render(<BootSplash bootTheme={null} strings={strings} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-boot-theme', 'system');
  });

  it('marks the palette with the cookie theme when one was present', () => {
    render(<BootSplash bootTheme="dark" strings={strings} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-boot-theme', 'dark');
  });

  it('offers a plain-anchor reload path for a hung boot', () => {
    const { container } = render(<BootSplash bootTheme="light" strings={strings} />);
    // The slow block starts visibility:hidden (the CSS animation delay
    // reveals it), so it is queried structurally rather than by role.
    const link = container.querySelector('.boot-splash-slow a');
    // A plain <a href="/">: the whole point is an exit that works when the
    // JS runtime never arrived, so it must not depend on next/link.
    expect(link).toHaveAttribute('href', '/');
    expect(link).toHaveTextContent('Reload the app');
    expect(container.textContent).toContain(
      'This is taking longer than expected. Check your connection.',
    );
  });

  it('reads the active palette tokens with stock fallbacks', () => {
    const { container } = render(<BootSplash bootTheme={null} strings={strings} />);
    const css = container.querySelector('style')?.textContent ?? '';
    // Palette-aware when the stylesheet (and the server-stamped data-theme)
    // arrived; stock colours when it never did.
    expect(css).toContain('var(--color-gray-50');
    expect(css).toContain('var(--color-gray-900');
    expect(css).toContain('var(--color-gray-100');
  });

  it('animates the logo only for a reader who has not asked for less motion', () => {
    const { container } = render(<BootSplash bootTheme={null} strings={strings} />);
    const css = container.querySelector('style')?.textContent ?? '';
    const motion = css.slice(css.indexOf('(prefers-reduced-motion: no-preference)'));
    expect(motion).toContain('monize-boot-logo-in');
    expect(motion).toContain('monize-boot-halo');
    // Outside that block the logo is plainly visible, with no animation to wait on.
    expect(css.slice(0, css.indexOf('(prefers-reduced-motion: no-preference)'))).not.toMatch(
      /animation:\s*monize-boot-(logo|halo)/,
    );
    expect(css).toContain('var(--color-blue-500');
  });

  it('draws the transparent brand logo inline, so it needs no download of its own', () => {
    const { container } = render(<BootSplash bootTheme={null} strings={strings} />);
    // A file would leave the halo glowing around nothing on a slow connection.
    expect(container.querySelector('img')).toBeNull();
    const source = readFileSync(
      resolve(process.cwd(), 'public/icons/monize-logo-transparent.svg'),
      'utf8',
    );
    const drawn = container.querySelector('svg.boot-splash-logo path');
    expect(source).toContain(`d="${drawn?.getAttribute('d')}"`);
    expect(source).toContain(`fill="${drawn?.getAttribute('fill')}"`);
  });
});
