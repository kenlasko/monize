import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { HeroHeadline, HeroPanelActiveContext } from './hero-parts';

const collapsingTitle = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useCollapsingHeaderTitle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCollapsingHeaderTitle')>()),
  useCollapsingHeaderTitle: (content: unknown) => {
    collapsingTitle(content);
    return () => {};
  },
}));

const collapsed = { title: 'Net worth', figure: '$1.00' };

describe('HeroHeadline', () => {
  beforeEach(() => collapsingTitle.mockClear());

  it('offers its figure to the app header where it is on screen', () => {
    render(
      <HeroHeadline negative={false} collapsed={collapsed}>
        $1.00
      </HeroHeadline>,
    );
    expect(collapsingTitle).toHaveBeenLastCalledWith(collapsed);
  });

  it('offers nothing from the set off screen', () => {
    render(
      <HeroPanelActiveContext.Provider value={false}>
        <HeroHeadline negative={false} collapsed={collapsed}>
          $1.00
        </HeroHeadline>
      </HeroPanelActiveContext.Provider>,
    );
    expect(collapsingTitle).toHaveBeenLastCalledWith(null);
  });
});
