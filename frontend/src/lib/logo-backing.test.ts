import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOGO_SAMPLE_SIZE,
  cachedLogoBacking,
  classifyLogoPixels,
  clearLogoBackingCache,
  logoBackingFor,
} from './logo-backing';

type Rgba = [number, number, number, number];

const CLEAR: Rgba = [0, 0, 0, 0];

/** A size x size image whose pixels come from `paint`. */
function image(paint: (x: number, y: number) => Rgba, size = LOGO_SAMPLE_SIZE): number[] {
  const data: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) data.push(...paint(x, y));
  }
  return data;
}

/** Ink in a centred square covering the middle half, transparent elsewhere. */
function glyph(ink: Rgba): number[] {
  const lo = LOGO_SAMPLE_SIZE / 4;
  const hi = (LOGO_SAMPLE_SIZE * 3) / 4;
  return image((x, y) => (x >= lo && x < hi && y >= lo && y < hi ? ink : CLEAR));
}

describe('classifyLogoPixels', () => {
  it('fills a black logo on transparency light, for dark mode', () => {
    expect(classifyLogoPixels(glyph([0, 0, 0, 255]), LOGO_SAMPLE_SIZE)).toBe('light');
  });

  it('fills a dark navy logo light too', () => {
    expect(classifyLogoPixels(glyph([0, 32, 64, 255]), LOGO_SAMPLE_SIZE)).toBe('light');
  });

  it('fills a white logo on transparency dark, for light mode', () => {
    expect(classifyLogoPixels(glyph([255, 255, 255, 255]), LOGO_SAMPLE_SIZE)).toBe('dark');
  });

  it('fills a pale yellow logo dark', () => {
    expect(classifyLogoPixels(glyph([255, 230, 120, 255]), LOGO_SAMPLE_SIZE)).toBe('dark');
  });

  it('leaves a mid-tone logo alone: it reads on both cards', () => {
    expect(classifyLogoPixels(glyph([220, 40, 40, 255]), LOGO_SAMPLE_SIZE)).toBe('none');
    expect(classifyLogoPixels(glyph([30, 110, 220, 255]), LOGO_SAMPLE_SIZE)).toBe('none');
  });

  it('leaves an opaque logo alone, whatever its colour', () => {
    // A logo that paints its own background already contrasts with itself.
    const white = image(() => [255, 255, 255, 255]);
    const black = image(() => [0, 0, 0, 255]);
    expect(classifyLogoPixels(white, LOGO_SAMPLE_SIZE)).toBe('none');
    expect(classifyLogoPixels(black, LOGO_SAMPLE_SIZE)).toBe('none');
  });

  it('reads only the round chip: transparent corners do not make an opaque disc transparent', () => {
    const radius = LOGO_SAMPLE_SIZE / 2;
    const whiteDisc = image((x, y) => {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      return dx * dx + dy * dy <= radius * radius ? [255, 255, 255, 255] : CLEAR;
    });
    expect(classifyLogoPixels(whiteDisc, LOGO_SAMPLE_SIZE)).toBe('none');
  });

  it('decides by the dominant colour, not a small accent', () => {
    // Mostly black ink with a white highlight strip: the black decides.
    const lo = LOGO_SAMPLE_SIZE / 4;
    const hi = (LOGO_SAMPLE_SIZE * 3) / 4;
    const data = image((x, y) => {
      if (x < lo || x >= hi || y < lo || y >= hi) return CLEAR;
      return y === lo ? [255, 255, 255, 255] : [0, 0, 0, 255];
    });
    expect(classifyLogoPixels(data, LOGO_SAMPLE_SIZE)).toBe('light');
  });

  it('ignores faint antialiasing when choosing the dominant colour', () => {
    // A thin black glyph with a wide half-transparent white halo.
    const lo = LOGO_SAMPLE_SIZE / 4;
    const hi = (LOGO_SAMPLE_SIZE * 3) / 4;
    const data = image((x, y) => {
      if (x < lo || x >= hi || y < lo || y >= hi) return CLEAR;
      return x === lo ? [0, 0, 0, 255] : [255, 255, 255, 100];
    });
    expect(classifyLogoPixels(data, LOGO_SAMPLE_SIZE)).toBe('light');
  });

  it('leaves a fully transparent image alone', () => {
    expect(classifyLogoPixels(image(() => CLEAR), LOGO_SAMPLE_SIZE)).toBe('none');
  });
});

describe('logoBackingFor', () => {
  afterEach(() => {
    clearLogoBackingCache();
    vi.restoreAllMocks();
  });

  function stubCanvas(data: number[] | null) {
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((() =>
        data === null
          ? null
          : {
              drawImage,
              clearRect: vi.fn(),
              getImageData: () => ({ data: Uint8ClampedArray.from(data) }),
            }) as unknown as HTMLCanvasElement['getContext']);
    return { getContext, drawImage };
  }

  it('reads the loaded image and remembers the answer per URL', () => {
    const { getContext, drawImage } = stubCanvas(glyph([0, 0, 0, 255]));
    const img = document.createElement('img');

    expect(cachedLogoBacking('/api/v1/payees/p-1/logo')).toBeUndefined();
    expect(logoBackingFor('/api/v1/payees/p-1/logo', img)).toBe('light');
    expect(drawImage).toHaveBeenCalledWith(img, 0, 0, LOGO_SAMPLE_SIZE, LOGO_SAMPLE_SIZE);
    expect(cachedLogoBacking('/api/v1/payees/p-1/logo')).toBe('light');

    // One canvas serves every read.
    logoBackingFor('/api/v1/payees/p-2/logo', img);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('re-reads a URL on every load, so a refetched logo is not judged by its predecessor', () => {
    let pixels = glyph([0, 0, 0, 255]);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage: vi.fn(),
      clearRect: vi.fn(),
      getImageData: () => ({ data: Uint8ClampedArray.from(pixels) }),
    })) as unknown as HTMLCanvasElement['getContext']);
    const img = document.createElement('img');
    expect(logoBackingFor('/api/v1/payees/p-1/logo', img)).toBe('light');

    pixels = glyph([255, 255, 255, 255]);
    expect(logoBackingFor('/api/v1/payees/p-1/logo', img)).toBe('dark');
    expect(cachedLogoBacking('/api/v1/payees/p-1/logo')).toBe('dark');
  });

  it('adds no fill when the browser offers no canvas', () => {
    stubCanvas(null);
    expect(logoBackingFor('/api/v1/payees/p-2/logo', document.createElement('img'))).toBe(
      'none',
    );
  });

  it('adds no fill when reading the pixels throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage: vi.fn(),
      getImageData: () => {
        throw new DOMException('tainted', 'SecurityError');
      },
    })) as unknown as HTMLCanvasElement['getContext']);
    expect(logoBackingFor('/api/v1/payees/p-3/logo', document.createElement('img'))).toBe(
      'none',
    );
  });

  it('has no cached answer for a missing URL', () => {
    expect(cachedLogoBacking(null)).toBeUndefined();
  });
});
