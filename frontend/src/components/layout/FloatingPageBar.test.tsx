import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { FloatingPageBar, HEADER_SURFACE_CLASS } from './FloatingPageBar';

describe('FloatingPageBar', () => {
  it('wears the app header surface, edge to edge, with the page gutters inside', () => {
    render(
      <FloatingPageBar visible testId="floating">
        <span>Contents</span>
      </FloatingPageBar>,
    );
    const wrapper = screen.getByTestId('floating');
    expect(wrapper).toHaveClass('fixed', 'inset-x-0', 'translate-y-0', 'opacity-100');
    // Flush under the header: no gap or gutter on the pinned wrapper itself.
    expect(wrapper.className).not.toMatch(/\b(px|pt|mt)-/);
    const surface = screen.getByText('Contents').parentElement as HTMLElement;
    for (const token of HEADER_SURFACE_CLASS.split(' ')) expect(surface).toHaveClass(token);
    expect(surface).toHaveClass('px-4', 'sm:px-6', 'lg:px-12', 'pointer-events-auto');
    expect(wrapper).toHaveAttribute('aria-hidden', 'false');
  });

  it('slides up out of view, inert and hidden, while not shown', () => {
    render(
      <FloatingPageBar visible={false} testId="floating">
        <button type="button">Act</button>
      </FloatingPageBar>,
    );
    const wrapper = screen.getByTestId('floating');
    expect(wrapper).toHaveClass('-translate-y-full', 'opacity-0');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper).toHaveAttribute('inert');
    expect(screen.queryByRole('button', { name: 'Act' })).not.toBeInTheDocument();
  });
});
