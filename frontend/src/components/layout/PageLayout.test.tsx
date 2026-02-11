import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { PageLayout } from './PageLayout';

describe('PageLayout', () => {
  it('renders children content', () => {
    render(<PageLayout><p>Page content here</p></PageLayout>);
    expect(screen.getByText('Page content here')).toBeInTheDocument();
  });

  it('wraps content in a min-h-screen container with background', () => {
    const { container } = render(<PageLayout>Content</PageLayout>);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('min-h-screen');
    expect(wrapper.className).toContain('bg-gray-50');
  });
});
