import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@/test/render';
import { useCollapsingHeaderTitle } from './useCollapsingHeaderTitle';
import { useMobileChromeStore } from '@/store/mobileChromeStore';

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let notify: Callback;
const disconnect = vi.fn();

function Title({ text = 'Budgets', figure }: { text?: string; figure?: string }) {
  const ref = useCollapsingHeaderTitle<HTMLHeadingElement>({ title: text, figure });
  return <h1 ref={ref}>{text}</h1>;
}

const scrolled = (isIntersecting: boolean, top: number) =>
  act(() => notify([{ isIntersecting, boundingClientRect: { top } as DOMRectReadOnly }]));

const current = () => useMobileChromeStore.getState().collapsedTitle;

describe('useCollapsingHeaderTitle', () => {
  beforeEach(() => {
    useMobileChromeStore.setState({ collapsedTitle: null });
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: Callback) {
          notify = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    disconnect.mockClear();
  });

  it('hands over the title once it has scrolled behind the header', () => {
    render(<Title />);
    expect(current()).toBeNull();
    scrolled(false, -40);
    expect(current()).toMatchObject({ title: 'Budgets' });
  });

  it('takes it back when the title returns', () => {
    render(<Title />);
    scrolled(false, -40);
    scrolled(true, 120);
    expect(current()).toBeNull();
  });

  it('ignores a title that is off screen below the header', () => {
    render(<Title />);
    scrolled(false, 900);
    expect(current()).toBeNull();
  });

  it('follows a figure that changes while collapsed', () => {
    const { rerender } = render(<Title figure="$1.00" />);
    scrolled(false, -40);
    rerender(<Title figure="$2.00" />);
    expect(current()).toMatchObject({ figure: '$2.00' });
  });

  it('does not watch a title that has nothing to hand over', () => {
    const observe = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = observe;
        disconnect() {}
      },
    );
    function Silent() {
      const ref = useCollapsingHeaderTitle<HTMLHeadingElement>(null);
      return <h1 ref={ref}>Quiet</h1>;
    }
    render(<Silent />);
    expect(observe).not.toHaveBeenCalled();
  });

  it('leaves nothing behind when the page goes', () => {
    const { unmount } = render(<Title />);
    scrolled(false, -40);
    unmount();
    expect(current()).toBeNull();
    expect(disconnect).toHaveBeenCalled();
  });
});
