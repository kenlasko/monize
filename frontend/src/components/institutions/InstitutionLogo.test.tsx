import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InstitutionLogo } from './InstitutionLogo';

describe('InstitutionLogo', () => {
  it('renders the favicon image when a logo is available', () => {
    render(
      <InstitutionLogo institution={{ id: 'i-1', name: 'TD', hasLogo: true }} />,
    );
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', '/api/v1/institutions/i-1/logo');
    expect(img).toHaveAttribute('alt', 'TD');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('renders a letter badge when there is no cached logo', () => {
    render(
      <InstitutionLogo institution={{ id: 'i-1', name: 'TD', hasLogo: false }} />,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('renders the fallback glyph when there is no institution', () => {
    render(<InstitutionLogo institution={undefined} fallbackGlyph="$" />);
    expect(screen.getByText('$')).toBeInTheDocument();
  });

  it('falls back to the badge when the image fails to load', () => {
    render(
      <InstitutionLogo
        institution={{ id: 'i-1', name: 'Acme', hasLogo: true }}
      />,
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
  });
});
