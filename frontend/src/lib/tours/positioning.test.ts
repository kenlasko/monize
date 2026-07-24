import { describe, it, expect } from 'vitest';
import { computeTooltipPosition, inflateRect } from './positioning';

const VIEWPORT = { width: 1000, height: 800 };
const TOOLTIP = { width: 300, height: 120 };

describe('computeTooltipPosition', () => {
  it('places below and centers horizontally on the anchor for auto', () => {
    const anchor = { top: 100, left: 400, width: 200, height: 40 };
    const pos = computeTooltipPosition(anchor, TOOLTIP, VIEWPORT, 'auto');

    expect(pos.placement).toBe('bottom');
    expect(pos.top).toBe(100 + 40 + 12);
    // centered: anchorCenterX (500) - tooltipWidth/2 (150) = 350
    expect(pos.left).toBe(350);
  });

  it('flips above when there is not enough room below', () => {
    const anchor = { top: 760, left: 400, width: 200, height: 30 };
    const pos = computeTooltipPosition(anchor, TOOLTIP, VIEWPORT, 'bottom');

    expect(pos.placement).toBe('top');
    expect(pos.top).toBe(760 - TOOLTIP.height - 12);
  });

  it('clamps horizontally within the viewport edges', () => {
    const anchor = { top: 100, left: 970, width: 20, height: 20 };
    const pos = computeTooltipPosition(anchor, TOOLTIP, VIEWPORT, 'bottom');

    // Would overflow right; clamped to viewport.width - tooltip.width - margin.
    expect(pos.left).toBe(1000 - 300 - 8);
  });

  it('clamps to the left margin when the anchor is near the left edge', () => {
    const anchor = { top: 100, left: 0, width: 20, height: 20 };
    const pos = computeTooltipPosition(anchor, TOOLTIP, VIEWPORT, 'bottom');

    expect(pos.left).toBe(8);
  });

  it('places to the right and flips to the left near the right edge', () => {
    const anchor = { top: 300, left: 900, width: 60, height: 40 };
    const pos = computeTooltipPosition(anchor, TOOLTIP, VIEWPORT, 'right');

    expect(pos.placement).toBe('left');
    expect(pos.left).toBe(900 - TOOLTIP.width - 12);
  });

  it('keeps an explicit side when it has room (no flip)', () => {
    const anchor = { top: 300, left: 400, width: 100, height: 40 };
    const pos = computeTooltipPosition(anchor, TOOLTIP, VIEWPORT, 'top');
    expect(pos.placement).toBe('top');
  });
});

describe('inflateRect', () => {
  it('grows the rect symmetrically', () => {
    expect(inflateRect({ top: 100, left: 100, width: 50, height: 40 }, 8)).toEqual(
      { top: 92, left: 92, width: 66, height: 56 },
    );
  });
});
