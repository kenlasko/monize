import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@/test/render';

vi.mock('@/lib/tours-api', () => ({
  toursApi: { saveProgress: vi.fn().mockResolvedValue({ saved: true }) },
}));

import { TourBanner } from './TourBanner';
import { useTourStore } from '@/store/tourStore';

beforeEach(() => {
  useTourStore.setState({ active: null, progress: {}, progressLoaded: true });
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

describe('TourBanner', () => {
  it('invites the user to take the tour and starts it on click', () => {
    render(<TourBanner />);
    expect(screen.getByText('Take a quick tour')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Take the tour'));
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('flips to "Retake the tour" once the intro is completed', () => {
    useTourStore.setState({
      progress: { 'intro/basics': { status: 'completed', updatedAt: 'now' } },
    });
    render(<TourBanner />);
    expect(screen.getByText('Retake the tour')).toBeInTheDocument();
  });

  it('can be dismissed for the session', () => {
    const { container } = render(<TourBanner />);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden while a tour is running', () => {
    render(<TourBanner />);
    const { container } = render(<TourBanner />);
    // Start a tour -> both instances hide.
    fireEvent.click(screen.getAllByText('Take the tour')[0]);
    cleanup();
    const { container: reRendered } = render(<TourBanner />);
    expect(reRendered).toBeEmptyDOMElement();
    void container;
  });
});
