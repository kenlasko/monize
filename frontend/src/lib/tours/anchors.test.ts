import { describe, it, expect, afterEach } from 'vitest';
import { findTourAnchor, TOUR_ANCHORS } from './anchors';

function anchorElement(visible: boolean | null): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute('data-tour-id', TOUR_ANCHORS.accountsAddButton);
  if (visible !== null) {
    Object.defineProperty(el, 'checkVisibility', { value: () => visible });
  }
  document.body.appendChild(el);
  return el;
}

describe('findTourAnchor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('prefers the drawn copy of an anchor over a hidden one', () => {
    anchorElement(false);
    const drawn = anchorElement(true);
    expect(findTourAnchor(TOUR_ANCHORS.accountsAddButton)).toBe(drawn);
  });

  it('does not count an anchor that is mounted but not drawn as found', () => {
    anchorElement(false);
    expect(findTourAnchor(TOUR_ANCHORS.accountsAddButton)).toBeNull();
  });

  it('takes the first match where the browser cannot tell', () => {
    const first = anchorElement(null);
    anchorElement(null);
    expect(findTourAnchor(TOUR_ANCHORS.accountsAddButton)).toBe(first);
  });
});
