import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureSvgAsImage, captureAllChartsAsImages } from './pdf-export-charts';

/**
 * Creates a realistic Recharts DOM structure: .recharts-wrapper > svg.recharts-surface
 */
function createRechartsWrapper(svgAttrs?: Record<string, string>): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.classList.add('recharts-wrapper');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('recharts-surface');
  if (svgAttrs) {
    for (const [key, value] of Object.entries(svgAttrs)) {
      svg.setAttribute(key, value);
    }
  }
  wrapper.appendChild(svg);
  return wrapper;
}

describe('captureSvgAsImage', () => {
  it('returns null when no SVG element is found', async () => {
    const container = document.createElement('div');
    const result = await captureSvgAsImage(container);
    expect(result).toBeNull();
  });

  it('returns null for empty container', async () => {
    const container = document.createElement('div');
    container.innerHTML = '<div>No chart here</div>';
    const result = await captureSvgAsImage(container);
    expect(result).toBeNull();
  });

  it('returns null when SVG has wrong class', async () => {
    const container = document.createElement('div');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('other-class');
    container.appendChild(svg);
    const result = await captureSvgAsImage(container);
    expect(result).toBeNull();
  });
});

describe('captureAllChartsAsImages', () => {
  it('returns empty array when container has no SVGs', async () => {
    const container = document.createElement('div');
    const result = await captureAllChartsAsImages(container);
    expect(result).toEqual([]);
  });

  it('returns empty array when SVGs have wrong class', async () => {
    const container = document.createElement('div');
    const wrapper = document.createElement('div');
    wrapper.classList.add('recharts-wrapper');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('other-class');
    wrapper.appendChild(svg);
    container.appendChild(wrapper);
    const result = await captureAllChartsAsImages(container);
    expect(result).toEqual([]);
  });

  it('returns empty array when chart SVGs have no dimensions', async () => {
    const container = document.createElement('div');
    // Create SVGs in proper Recharts structure but no width/height attributes
    // jsdom returns 0 for getBoundingClientRect, so dimensions will be unresolvable
    for (let i = 0; i < 3; i++) {
      container.appendChild(createRechartsWrapper());
    }
    const result = await captureAllChartsAsImages(container);
    expect(result).toEqual([]);
  });

  it('ignores legend icon SVGs inside recharts-legend-wrapper', async () => {
    const container = document.createElement('div');
    // Main chart SVG (no dimensions, so will be filtered by dimension check)
    container.appendChild(createRechartsWrapper());
    // Legend icon SVG -- nested inside legend wrapper, should not be matched
    const legendWrapper = document.createElement('div');
    legendWrapper.classList.add('recharts-legend-wrapper');
    const legendSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    legendSvg.classList.add('recharts-surface');
    legendSvg.setAttribute('width', '14');
    legendSvg.setAttribute('height', '14');
    legendWrapper.appendChild(legendSvg);
    container.appendChild(legendWrapper);
    const result = await captureAllChartsAsImages(container);
    // Should return empty -- main chart has no dimensions, legend SVG is excluded by selector
    expect(result).toEqual([]);
  });
});

describe('captureSingleSvg via captureSvgAsImage (with mocked Image)', () => {
  let originalImage: typeof Image;

  beforeEach(() => {
    originalImage = global.Image;
    // Mock Image to immediately fire onload
    class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      _src = '';
      get src() {
        return this._src;
      }
      set src(value: string) {
        this._src = value;
        // Fire onload asynchronously to mimic browser behavior
        setTimeout(() => this.onload?.(), 0);
      }
    }
    (global as any).Image = MockImage;
    // Mock canvas getContext since jsdom returns a usable but limited 2d ctx
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    }) as any;
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,test');
  });

  afterEach(() => {
    (global as any).Image = originalImage;
  });

  it('captures an SVG with width/height attributes', async () => {
    const container = document.createElement('div');
    const wrapper = document.createElement('div');
    wrapper.classList.add('recharts-wrapper');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('recharts-surface');
    svg.setAttribute('width', '800');
    svg.setAttribute('height', '400');
    // Add text and line elements that should be normalized
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('fill', 'currentColor');
    svg.appendChild(text);
    const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    svg.appendChild(tspan);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.classList.add('stroke-gray-200');
    svg.appendChild(line);
    wrapper.appendChild(svg);
    container.appendChild(wrapper);

    const result = await captureSvgAsImage(container);
    expect(result).not.toBeNull();
    expect(result?.width).toBe(800);
    expect(result?.height).toBe(400);
    expect(result?.dataUrl).toBe('data:image/png;base64,test');
  });

  it('captureAllChartsAsImages returns multiple captured charts', async () => {
    const container = document.createElement('div');
    for (let i = 0; i < 3; i++) {
      const wrapper = document.createElement('div');
      wrapper.classList.add('recharts-wrapper');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('recharts-surface');
      svg.setAttribute('width', '800');
      svg.setAttribute('height', '400');
      wrapper.appendChild(svg);
      container.appendChild(wrapper);
    }
    const result = await captureAllChartsAsImages(container);
    expect(result).toHaveLength(3);
  });

  it('returns null when capture throws (Image error)', async () => {
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
    (global as any).Image = FailingImage;

    const container = document.createElement('div');
    const wrapper = document.createElement('div');
    wrapper.classList.add('recharts-wrapper');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('recharts-surface');
    svg.setAttribute('width', '800');
    svg.setAttribute('height', '400');
    wrapper.appendChild(svg);
    container.appendChild(wrapper);

    const result = await captureSvgAsImage(container);
    expect(result).toBeNull();
  });
});
