/**
 * SVG chart capture utility for PDF export.
 * Converts Recharts SVG elements to high-resolution PNG images.
 */

export interface CapturedChart {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Font applied to chart text in the rasterized output.
 *
 * On screen, Recharts text (axis ticks, labels, in-chart legends) inherits
 * `font-family: Inter` from the page stylesheet. The clone we serialize here is
 * detached from the document, so it has no stylesheet context and the browser's
 * SVG renderer falls back to its default serif face (Times New Roman). Setting an
 * explicit sans-serif family on the root SVG (inherited by all text/tspan) keeps
 * chart text consistent with the Helvetica used by the rest of the PDF report.
 */
export const CHART_FONT_FAMILY = 'Helvetica, Arial, sans-serif';

/**
 * Resolves chart dimensions from multiple sources for reliability.
 * Recharts sets width/height attributes on the SVG element, which are the most
 * reliable source. Falls back to getBoundingClientRect and container dimensions.
 */
function resolveChartDimensions(
  svg: SVGSVGElement,
  container: HTMLElement,
): { width: number; height: number } | null {
  // Source 1: SVG element's own width/height attributes (set by Recharts)
  const attrWidth = parseFloat(svg.getAttribute('width') || '0');
  const attrHeight = parseFloat(svg.getAttribute('height') || '0');
  if (attrWidth > 50 && attrHeight > 50) {
    return { width: attrWidth, height: attrHeight };
  }

  // Source 2: SVG bounding client rect (CSS-computed layout)
  const svgRect = svg.getBoundingClientRect();
  if (svgRect.width > 50 && svgRect.height > 50) {
    return { width: svgRect.width, height: svgRect.height };
  }

  // Source 3: Container element dimensions
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width > 50 && containerRect.height > 50) {
    return { width: containerRect.width, height: containerRect.height };
  }

  return null;
}

/**
 * Chart colours are CSS variable references (var(--chart-*), see
 * src/lib/chart-colors.ts) that resolve against the document's active colour
 * theme. The serialized standalone SVG has no stylesheet context, so they
 * would render as black. Bake the computed colours into the clone before
 * serialization by reading them from the live elements.
 */
function inlineCssVariableColors(original: SVGSVGElement, clone: SVGSVGElement): void {
  const COLOR_ATTRS = ['fill', 'stroke', 'stop-color'] as const;
  const originalElements = [original, ...Array.from(original.querySelectorAll<SVGElement>('*'))];
  const cloneElements = [clone, ...Array.from(clone.querySelectorAll<SVGElement>('*'))];
  if (originalElements.length !== cloneElements.length) return;

  originalElements.forEach((origEl, i) => {
    const cloneEl = cloneElements[i];
    for (const attr of COLOR_ATTRS) {
      const value = origEl.getAttribute(attr);
      if (value && value.includes('var(')) {
        const computed = getComputedStyle(origEl).getPropertyValue(attr);
        if (computed) {
          cloneEl.setAttribute(attr, computed);
        }
      }
    }
  });
}

/**
 * Captures a single SVG element and converts it to a PNG data URL.
 * Forces a white background regardless of dark mode for print-friendly output.
 *
 * The SVG clone is rendered at (width*scale x height*scale) with a viewBox at the
 * original dimensions, so the browser's SVG renderer natively produces a high-resolution
 * raster without canvas upscaling artifacts.
 */
function captureSingleSvg(
  svg: SVGSVGElement,
  container: HTMLElement,
  scale: number,
): Promise<CapturedChart | null> {
  const dims = resolveChartDimensions(svg, container);
  if (!dims) return Promise.resolve(null);

  const { width, height } = dims;
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);

  const svgClone = svg.cloneNode(true) as SVGSVGElement;

  // Remove inline style -- Recharts sets "width: 100%; height: 100%" which,
  // in a standalone context (no parent container), overrides the explicit
  // width/height attributes and collapses to ~150px default.
  svgClone.removeAttribute('style');

  // Also remove style from direct SVG children (Recharts wrapper groups)
  svgClone.querySelectorAll(':scope > g[style], :scope > svg[style]').forEach((el) => {
    (el as SVGElement).removeAttribute('style');
  });

  // Resolve theme CSS variables to concrete colours while both trees still
  // mirror each other (before the background rect is inserted below).
  inlineCssVariableColors(svg, svgClone);

  // Set the clone to render at scaled resolution natively.
  // viewBox preserves the original coordinate system while width/height
  // at scaled values makes the SVG renderer produce a high-res raster.
  svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgClone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svgClone.setAttribute('width', String(scaledWidth));
  svgClone.setAttribute('height', String(scaledHeight));

  // Pin the font so text renders in sans-serif instead of the renderer's default
  // serif face once the SVG is detached from the page stylesheet. Inherited by
  // every text/tspan descendant.
  svgClone.setAttribute('font-family', CHART_FONT_FAMILY);

  // Add white background rect as the first child
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '100%');
  bgRect.setAttribute('height', '100%');
  bgRect.setAttribute('fill', 'white');
  svgClone.insertBefore(bgRect, svgClone.firstChild);

  // Force dark-mode text to black for print
  const textElements = svgClone.querySelectorAll('text, tspan');
  textElements.forEach((el) => {
    const elem = el as SVGElement;
    const fill = elem.getAttribute('fill');
    if (fill === 'currentColor' || !fill) {
      elem.setAttribute('fill', '#374151');
    }
  });

  // Force grid lines to light gray
  const lines = svgClone.querySelectorAll('line, path');
  lines.forEach((el) => {
    const elem = el as SVGElement;
    if (elem.classList.contains('stroke-gray-200') || elem.classList.contains('stroke-gray-700')) {
      elem.setAttribute('stroke', '#e5e7eb');
      elem.classList.remove('stroke-gray-200', 'stroke-gray-700');
    }
  });

  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(svgClone);
  const base64 = btoa(unescape(encodeURIComponent(svgString)));
  const dataUri = `data:image/svg+xml;base64,${base64}`;

  return new Promise<CapturedChart>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas 2d context'));
        return;
      }
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, scaledWidth, scaledHeight);
      // Draw at 1:1 -- the SVG was already rendered at scaled resolution
      ctx.drawImage(img, 0, 0, scaledWidth, scaledHeight);
      resolve({
        dataUrl: canvas.toDataURL('image/png'),
        width,
        height,
      });
    };
    img.onerror = () => {
      reject(new Error('Failed to load SVG image'));
    };
    img.src = dataUri;
  });
}

/**
 * Captures all main Recharts chart SVGs from a container and converts them to PNG data URLs.
 * Uses a selector that targets only direct-child SVGs of `.recharts-wrapper`, which excludes
 * the small legend icon SVGs that Recharts renders inside `.recharts-legend-wrapper`.
 * Returns an array of captured charts in DOM order.
 */
export async function captureAllChartsAsImages(
  container: HTMLElement,
  scale: number = 3,
): Promise<CapturedChart[]> {
  // Target only main chart SVGs (direct children of .recharts-wrapper).
  // Recharts also renders tiny svg.recharts-surface elements for legend icons
  // inside .recharts-legend-wrapper -- those must be excluded.
  const svgs = container.querySelectorAll('.recharts-wrapper > svg.recharts-surface');
  const results: CapturedChart[] = [];

  for (const svg of Array.from(svgs)) {
    try {
      const chart = await captureSingleSvg(svg as SVGSVGElement, container, scale);
      if (chart) {
        results.push(chart);
      }
    } catch {
      // Skip failed individual charts, continue with the rest
    }
  }

  return results;
}

/**
 * Captures the first Recharts SVG element from a container and converts it to a PNG data URL.
 * Backward-compatible single-chart capture.
 */
export async function captureSvgAsImage(
  container: HTMLElement,
  scale: number = 3,
): Promise<CapturedChart | null> {
  const svg = container.querySelector('svg.recharts-surface') as SVGSVGElement | null;
  if (!svg) return null;

  try {
    return await captureSingleSvg(svg, container, scale);
  } catch {
    return null;
  }
}
