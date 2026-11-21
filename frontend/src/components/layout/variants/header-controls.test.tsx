import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { HEADER_SEARCH_VARIANTS, HEADER_USER_VARIANTS, type HeaderUserSlotProps } from './header-controls';

const userProps = (onOpen = vi.fn()): HeaderUserSlotProps => ({
  standard: <button type="button">standard settings</button>,
  name: 'Demo',
  active: false,
  onOpen,
  anchor: { 'data-tour-id': 'nav-settings' },
});

describe('header search slot', () => {
  beforeEach(() => useCommandPaletteStore.setState({ open: false }));

  it('keeps the Standard inline search as given', () => {
    render(createElement(HEADER_SEARCH_VARIANTS.standard, { standard: <input aria-label="inline search" /> }));
    expect(screen.getByLabelText('inline search')).toBeInTheDocument();
  });

  it.each(['folio', 'pebble'] as const)('opens the command palette in the %s style', (style) => {
    render(createElement(HEADER_SEARCH_VARIANTS[style]!, { standard: null }));
    const trigger = screen.getByRole('button', { name: /Search or jump to/ });
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    fireEvent.click(trigger);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});

describe('header user slot', () => {
  it('keeps the Standard settings button as given', () => {
    render(createElement(HEADER_USER_VARIANTS.standard, userProps()));
    expect(screen.getByRole('button', { name: 'standard settings' })).toBeInTheDocument();
  });

  it.each(['folio', 'pebble'] as const)(
    'names the reader and opens settings in the %s style, carrying the tour anchor',
    (style) => {
      const onOpen = vi.fn();
      render(createElement(HEADER_USER_VARIANTS[style]!, userProps(onOpen)));
      const button = screen.getByRole('button', { name: 'Demo, settings' });
      expect(button).toHaveAttribute('data-tour-id', 'nav-settings');
      fireEvent.click(button);
      expect(onOpen).toHaveBeenCalled();
    },
  );
});
