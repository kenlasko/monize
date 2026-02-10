import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PageLayout } from './PageLayout';

// Mock AppHeader to isolate PageLayout testing
vi.mock('./AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header">AppHeader</div>,
}));

describe('PageLayout', () => {
  it('renders the AppHeader', () => {
    render(<PageLayout>Content</PageLayout>);
    expect(screen.getByTestId('app-header')).toBeInTheDocument();
  });

  it('renders children content', () => {
    render(<PageLayout><p>Page content here</p></PageLayout>);
    expect(screen.getByText('Page content here')).toBeInTheDocument();
  });

  it('wraps content in a min-h-screen container', () => {
    const { container } = render(<PageLayout>Content</PageLayout>);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('min-h-screen');
  });
});
