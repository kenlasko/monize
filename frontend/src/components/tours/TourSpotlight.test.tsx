import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@/test/render';
import { TourSpotlight } from './TourSpotlight';

const RECT = { top: 100, left: 200, width: 120, height: 40 };

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('TourSpotlight', () => {
  it('renders a single full-screen dim panel for a centered step', () => {
    render(
      <TourSpotlight rect={null} interactive={false} reducedMotion={false} />,
    );
    const dims = document.body.querySelectorAll('.inset-0');
    // The portal renders exactly one full-screen dimming div.
    expect(dims.length).toBe(1);
  });

  it('renders framing panels and a highlight ring around an anchor', () => {
    render(
      <TourSpotlight rect={RECT} interactive={false} reducedMotion={false} />,
    );
    expect(document.body.querySelector('.ring-blue-500')).not.toBeNull();
  });

  it('adds a hole blocker on passive steps and omits it on interactive steps', () => {
    const { unmount } = render(
      <TourSpotlight rect={RECT} interactive={false} reducedMotion={false} />,
    );
    const wrapper = document.body.querySelector('.inset-0')!;
    const passiveChildren = wrapper.childElementCount;
    unmount();
    document.body.innerHTML = '';

    render(
      <TourSpotlight rect={RECT} interactive={true} reducedMotion={false} />,
    );
    const interactiveWrapper = document.body.querySelector('.inset-0')!;
    // Interactive steps drop the transparent blocker over the hole.
    expect(interactiveWrapper.childElementCount).toBe(passiveChildren - 1);
  });

  it('drops the animation classes under reduced motion', () => {
    render(
      <TourSpotlight rect={RECT} interactive={false} reducedMotion={true} />,
    );
    expect(document.body.querySelector('.transition-all')).toBeNull();
  });
});
