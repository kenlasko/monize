import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useTourAnchor } from './useTourAnchor';
import { TOUR_ANCHORS } from '@/lib/tours/anchors';

function addAnchor(id: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-tour-id', id);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useTourAnchor', () => {
  it('resolves immediately to found for a centered (null) step', () => {
    const { result } = renderHook(() => useTourAnchor(null));
    expect(result.current.status).toBe('found');
    expect(result.current.element).toBeNull();
  });

  it('resolves to found when the element is already present', async () => {
    const el = addAnchor(TOUR_ANCHORS.dashboardWidgets);
    const { result } = renderHook(() =>
      useTourAnchor(TOUR_ANCHORS.dashboardWidgets),
    );
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current.element).toBe(el);
  });

  it('resolves once the element appears after mount', async () => {
    const { result } = renderHook(() =>
      useTourAnchor(TOUR_ANCHORS.accountsAddButton),
    );
    expect(result.current.status).toBe('waiting');
    const el = addAnchor(TOUR_ANCHORS.accountsAddButton);
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current.element).toBe(el);
  });

  it('times out when the element never appears', async () => {
    const { result } = renderHook(() =>
      useTourAnchor(TOUR_ANCHORS.transactionForm, { timeoutMs: 30 }),
    );
    await waitFor(() => expect(result.current.status).toBe('timeout'));
    expect(result.current.element).toBeNull();
  });

  it('is inert (found, no element) when disabled', () => {
    const { result } = renderHook(() =>
      useTourAnchor(TOUR_ANCHORS.navAccounts, { enabled: false }),
    );
    expect(result.current.status).toBe('found');
    expect(result.current.element).toBeNull();
  });
});
