import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@/test/render';
import { DemoBanner } from './DemoBanner';
import { useDemoStore } from '@/store/demoStore';

beforeEach(() => {
  useDemoStore.setState({ isDemoMode: false });
});

afterEach(() => cleanup());

describe('DemoBanner', () => {
  it('renders nothing outside demo mode', () => {
    const { container } = render(<DemoBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the demo label and message in demo mode', () => {
    useDemoStore.setState({ isDemoMode: true });
    render(<DemoBanner />);
    expect(screen.getByText('Demo Mode')).toBeInTheDocument();
    expect(
      screen.getByText(/resets daily at 4:00 AM UTC/i),
    ).toBeInTheDocument();
  });
});
