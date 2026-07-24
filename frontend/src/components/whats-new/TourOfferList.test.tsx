import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@/test/render';
import { TourOfferList } from './TourOfferList';
import { useTourStore } from '@/store/tourStore';

vi.mock('@/lib/tours-api', () => ({
  toursApi: { saveProgress: vi.fn().mockResolvedValue({ saved: true }) },
}));

beforeEach(() => {
  useTourStore.setState({ active: null, progress: {}, progressLoaded: true });
  // Desktop so startTour keeps all steps.
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

describe('TourOfferList', () => {
  it('offers the intro row plus the release tours for the matching version', () => {
    render(<TourOfferList currentVersion="1.13.0" onClose={vi.fn()} />);
    expect(
      screen.getByText('New here? Take the introduction tour'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Foreign currency transactions'),
    ).toBeInTheDocument();
    expect(screen.getByText("What's New digest")).toBeInTheDocument();
    expect(screen.getAllByText('Show me')).toHaveLength(3);
  });

  it('starts a tour and closes the modal on click', () => {
    const onClose = vi.fn();
    render(<TourOfferList currentVersion="1.13.0" onClose={onClose} />);
    fireEvent.click(screen.getAllByText('Show me')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('hides the intro row once it has been completed and marks release tours Viewed', () => {
    useTourStore.setState({
      progress: {
        'intro/basics': { status: 'completed', updatedAt: 'now' },
        'release-1.13.0/foreign-currency': { status: 'completed', updatedAt: 'now' },
      },
    });
    render(<TourOfferList currentVersion="1.13.0" onClose={vi.fn()} />);
    expect(
      screen.queryByText('New here? Take the introduction tour'),
    ).toBeNull();
    expect(screen.getByText('Viewed')).toBeInTheDocument();
  });

  it('renders nothing when there is nothing to offer', () => {
    useTourStore.setState({
      progress: { 'intro/basics': { status: 'dismissed', updatedAt: 'now' } },
    });
    const { container } = render(
      <TourOfferList currentVersion="1.12.1" onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
