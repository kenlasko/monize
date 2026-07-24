import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@/test/render';
import toast from 'react-hot-toast';

const resetProgress = vi.fn().mockResolvedValue({ reset: true });
vi.mock('@/lib/tours-api', () => ({
  toursApi: {
    resetProgress: () => resetProgress(),
    saveProgress: vi.fn().mockResolvedValue({ saved: true }),
  },
}));

import { TourSettingsRow } from './TourSettingsRow';
import { useTourStore } from '@/store/tourStore';

beforeEach(() => {
  resetProgress.mockClear();
  useTourStore.setState({
    active: null,
    progress: { 'intro/basics': { status: 'completed', updatedAt: 'now' } },
    progressLoaded: true,
  });
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('min-width'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => cleanup());

describe('TourSettingsRow', () => {
  it('starts the introduction tour', () => {
    render(<TourSettingsRow />);
    fireEvent.click(screen.getByText('Start introduction tour'));
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('resets tour progress and clears the local map', async () => {
    render(<TourSettingsRow />);
    fireEvent.click(screen.getByText('Reset tour progress'));
    await waitFor(() => expect(resetProgress).toHaveBeenCalled());
    expect(useTourStore.getState().progress).toEqual({});
    expect(toast.success).toHaveBeenCalled();
  });
});
