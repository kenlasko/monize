import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { HelpLink } from './HelpLink';
import { useHelpStore } from '@/store/helpStore';

const getManifest = vi.fn();
vi.mock('@/lib/help', () => ({ helpApi: { getManifest: () => getManifest() } }));

beforeEach(() => {
  getManifest.mockReset();
  getManifest.mockResolvedValue({ version: '1', available: true, pages: [] });
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

const clickAndReport = (init: MouseEventInit = {}) => {
  const link = screen.getByRole('link', { name: 'Learn more' });
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  link.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('HelpLink', () => {
  it('links to the same page on monize.net', () => {
    render(<HelpLink link="budgets">Learn more</HelpLink>);
    const link = screen.getByRole('link', { name: 'Learn more' });
    expect(link).toHaveAttribute('href', 'https://www.monize.net/docs/budgets');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('opens the panel on a plain click once the guide is known to be bundled', () => {
    useHelpStore.getState().setGuideAvailable(true);
    render(<HelpLink link="institutions">Learn more</HelpLink>);
    expect(clickAndReport()).toBe(true);
    expect(useHelpStore.getState().open).toBe(true);
    expect(useHelpStore.getState().history).toEqual([
      { page: 'accounts', section: 'financial-institutions' },
    ]);
  });

  it('leaves a modified click to the browser', () => {
    useHelpStore.getState().setGuideAvailable(true);
    render(<HelpLink link="budgets">Learn more</HelpLink>);
    expect(clickAndReport({ ctrlKey: true })).toBe(false);
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('leaves the anchor to open monize.net when the manifest has not arrived yet', () => {
    getManifest.mockReturnValue(new Promise(() => {}));
    render(<HelpLink link="budgets">Learn more</HelpLink>);
    expect(clickAndReport()).toBe(false);
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('runs an extra onClick before deciding whether to open the panel', () => {
    useHelpStore.getState().setGuideAvailable(true);
    const onClick = vi.fn();
    render(
      <HelpLink link="budgets" onClick={onClick}>
        Learn more
      </HelpLink>,
    );
    clickAndReport();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useHelpStore.getState().open).toBe(true);
  });
});
