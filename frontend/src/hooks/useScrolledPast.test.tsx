import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@/test/render';
import { useScrolledPast } from './useScrolledPast';

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let notify: Callback | undefined;
const observe = vi.fn();

function Band({ enabled = true }: { enabled?: boolean }) {
  const [ref, past] = useScrolledPast<HTMLDivElement>(enabled);
  return (
    <div ref={ref} data-testid="band">
      {past ? 'past' : 'in view'}
    </div>
  );
}

const scrolled = (isIntersecting: boolean, top: number) =>
  act(() => notify?.([{ isIntersecting, boundingClientRect: { top } as DOMRectReadOnly }]));

describe('useScrolledPast', () => {
  beforeEach(() => {
    notify = undefined;
    observe.mockClear();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: Callback) {
          notify = callback;
        }
        observe = observe;
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns true once the element has scrolled up behind the header, and back', () => {
    render(<Band />);
    expect(screen.getByTestId('band')).toHaveTextContent('in view');
    scrolled(false, -300);
    expect(screen.getByTestId('band')).toHaveTextContent('past');
    scrolled(true, 40);
    expect(screen.getByTestId('band')).toHaveTextContent('in view');
  });

  it('ignores an element that is still below the fold', () => {
    render(<Band />);
    scrolled(false, 1200);
    expect(screen.getByTestId('band')).toHaveTextContent('in view');
  });

  it('watches nothing while disabled, and forgets a stale answer', () => {
    const { rerender } = render(<Band />);
    scrolled(false, -300);
    rerender(<Band enabled={false} />);
    expect(screen.getByTestId('band')).toHaveTextContent('in view');
    observe.mockClear();
    render(<Band enabled={false} />);
    expect(observe).not.toHaveBeenCalled();
  });
});
