import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { AppVersion } from './AppVersion';

describe('AppVersion', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('links the version to its GitHub release notes', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.11.0');
    render(<AppVersion className="footer" />);

    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('v1.11.0');
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/releases/tag/v1.11.0',
    );
    expect(link).toHaveAttribute('title', 'View release notes for v1.11.0');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('uses the provided version in the release URL and applies the wrapper class', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '2.0.0');
    const { container } = render(<AppVersion className="text-center mt-6" />);

    expect(container.querySelector('p')).toHaveClass('text-center', 'mt-6');
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/releases/tag/v2.0.0',
    );
  });

  it('renders nothing when the version is unavailable', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '');
    const { container } = render(<AppVersion />);
    expect(container).toBeEmptyDOMElement();
  });
});
