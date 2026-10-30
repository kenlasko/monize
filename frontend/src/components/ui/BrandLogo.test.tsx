import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { clearLogoBackingCache, LOGO_SAMPLE_SIZE } from '@/lib/logo-backing';
import { BrandLogo } from './BrandLogo';

/** A canvas whose pixels are one colour in a centred square, clear elsewhere. */
function stubCanvasWithGlyph(ink: [number, number, number, number]) {
  const data: number[] = [];
  const lo = LOGO_SAMPLE_SIZE / 4;
  const hi = (LOGO_SAMPLE_SIZE * 3) / 4;
  for (let y = 0; y < LOGO_SAMPLE_SIZE; y += 1) {
    for (let x = 0; x < LOGO_SAMPLE_SIZE; x += 1) {
      data.push(...(x >= lo && x < hi && y >= lo && y < hi ? ink : [0, 0, 0, 0]));
    }
  }
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    getImageData: () => ({ data: Uint8ClampedArray.from(data) }),
  })) as unknown as HTMLCanvasElement['getContext']);
}

describe('BrandLogo', () => {
  it('renders the cached image when a source is given', () => {
    render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Starbucks" />);
    const img = screen.getByAltText('Starbucks') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/v1/payees/p-1/logo');
  });

  it('falls back to the initial badge when there is no source', () => {
    render(<BrandLogo src={null} name="Starbucks" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('falls back to the badge when the image fails to load', () => {
    // A 404 from the logo route (no icon cached yet, or the fetch failed) has
    // to look the same to the reader as having no icon at all.
    render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Starbucks" />);
    fireEvent.error(screen.getByAltText('Starbucks'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('retries for a different entity after a failure', () => {
    // The error flag belongs to the image that failed; keeping it across a
    // switch would leave the next payee permanently badged.
    const { rerender } = render(
      <BrandLogo src="/api/v1/payees/p-1/logo" name="Starbucks" />,
    );
    fireEvent.error(screen.getByAltText('Starbucks'));
    rerender(<BrandLogo src="/api/v1/payees/p-2/logo" name="Amazon" />);
    expect((screen.getByAltText('Amazon') as HTMLImageElement).src).toContain(
      '/payees/p-2/logo',
    );
  });

  it('uses the glyph when there is no name to take an initial from', () => {
    render(<BrandLogo src={null} name={null} fallbackGlyph="$" />);
    expect(screen.getByText('$')).toBeInTheDocument();
  });

  it('prefers a supplied fallback icon over the glyph', () => {
    const { container } = render(
      <BrandLogo src={null} name={null} fallbackIcon={<svg data-testid="i" />} />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
  });

  describe('backing behind a transparent logo', () => {
    afterEach(() => {
      clearLogoBackingCache();
      vi.restoreAllMocks();
    });

    it('fills a dark logo light in dark mode once it has loaded', () => {
      stubCanvasWithGlyph([0, 0, 0, 255]);
      render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Uber" />);
      const img = screen.getByAltText('Uber');
      expect(img.className).not.toContain('bg-');

      fireEvent.load(img);
      expect(img.className).toContain('dark:bg-white');
      expect(img.className).not.toContain('bg-gray-800');
    });

    it('fills a white logo dark in light mode, and clears it in dark mode', () => {
      stubCanvasWithGlyph([255, 255, 255, 255]);
      render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Uber" />);
      const img = screen.getByAltText('Uber');

      fireEvent.load(img);
      expect(img.className).toContain('bg-gray-800');
      expect(img.className).toContain('dark:bg-transparent');
    });

    it('insets the logo by a tenth of its size so the fill frames it', () => {
      stubCanvasWithGlyph([0, 0, 0, 255]);
      render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Uber" size={40} />);
      const img = screen.getByAltText('Uber');
      expect(img.style.getPropertyValue('--brand-logo-inset')).toBe('4px');
    });

    it('leaves a logo that contrasts with both cards unfilled', () => {
      stubCanvasWithGlyph([220, 40, 40, 255]);
      render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Uber" />);
      const img = screen.getByAltText('Uber');

      fireEvent.load(img);
      expect(img.className).not.toContain('bg-');
    });

    it('draws a logo already read with its fill from the first paint', () => {
      stubCanvasWithGlyph([0, 0, 0, 255]);
      const { unmount } = render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Uber" />);
      fireEvent.load(screen.getByAltText('Uber'));
      unmount();

      render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Uber" />);
      expect(screen.getByAltText('Uber').className).toContain('dark:bg-white');
    });

    it('drops the previous logo fill when the source changes', () => {
      stubCanvasWithGlyph([0, 0, 0, 255]);
      const { rerender } = render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Uber" />);
      fireEvent.load(screen.getByAltText('Uber'));

      rerender(<BrandLogo src="/api/v1/payees/p-2/logo" name="Lyft" />);
      expect(screen.getByAltText('Lyft').className).not.toContain('bg-');
    });
  });
});
