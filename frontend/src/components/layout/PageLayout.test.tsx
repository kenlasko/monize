import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { PageLayout } from './PageLayout';

describe('PageLayout', () => {
  it('renders children content', () => {
    render(<PageLayout><p>Page content here</p></PageLayout>);
    expect(screen.getByText('Page content here')).toBeInTheDocument();
  });

  it('bounds the wrapper to the space below the sticky header (not full min-h-screen)', () => {
    const { container } = render(<PageLayout>Content</PageLayout>);
    const wrapper = container.firstChild as HTMLElement;
    // The wrapper fills the viewport minus the 4rem sticky header rather than a
    // full min-h-screen, which would overflow by the header height (the stray
    // page scrollbar). See #738.
    expect(wrapper.className).toContain('min-h-[calc(100dvh-4rem)]');
    expect(wrapper.className).not.toContain('min-h-screen');
    expect(wrapper.className).toContain('bg-gray-50');
  });
});
