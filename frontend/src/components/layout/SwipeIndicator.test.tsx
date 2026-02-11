import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { SwipeIndicator } from './SwipeIndicator';

describe('SwipeIndicator', () => {
  it('renders nothing when not a swipe page', () => {
    const { container } = render(
      <SwipeIndicator currentIndex={-1} totalPages={6} isSwipePage={false} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders dots for each page on a swipe page', () => {
    const { container } = render(
      <SwipeIndicator currentIndex={0} totalPages={6} isSwipePage={true} />,
    );
    const dots = container.querySelectorAll('.rounded-full');
    expect(dots).toHaveLength(6);
  });

  it('highlights the current page dot', () => {
    const { container } = render(
      <SwipeIndicator currentIndex={2} totalPages={6} isSwipePage={true} />,
    );
    const dots = container.querySelectorAll('.rounded-full');
    expect(dots[2].className).toContain('bg-blue-500');
    expect(dots[2].className).toContain('w-2');
  });

  it('shows inactive styling for non-current dots', () => {
    const { container } = render(
      <SwipeIndicator currentIndex={0} totalPages={6} isSwipePage={true} />,
    );
    const dots = container.querySelectorAll('.rounded-full');
    expect(dots[1].className).toContain('bg-gray-300');
    expect(dots[1].className).toContain('w-1.5');
  });

  it('is marked as aria-hidden', () => {
    const { container } = render(
      <SwipeIndicator currentIndex={0} totalPages={6} isSwipePage={true} />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
  });
});
