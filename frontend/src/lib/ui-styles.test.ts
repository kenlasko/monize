import { describe, expect, it } from 'vitest';
import { COLOR_THEMES } from './color-themes';
import {
  UI_STYLES,
  UI_STYLE_COMPANION_PALETTE,
  UI_STYLE_PALETTES,
  paletteAfterStyleChange,
} from './ui-styles';

describe('UI style palettes', () => {
  it.each(UI_STYLES)('%s offers only real palettes, each once', (style) => {
    const list = UI_STYLE_PALETTES[style];
    expect(list.every((p) => (COLOR_THEMES as readonly string[]).includes(p))).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });

  it.each(UI_STYLES)('%s keeps the accessibility palettes', (style) => {
    expect(UI_STYLE_PALETTES[style]).toEqual(
      expect.arrayContaining(['highcontrast', 'colorblind']),
    );
  });

  it.each(['classic', 'modern'] as const)('%s lists its companion first', (style) => {
    expect(UI_STYLE_PALETTES[style][0]).toBe(UI_STYLE_COMPANION_PALETTE[style]);
  });

  it('Standard offers every palette', () => {
    expect(UI_STYLE_PALETTES.standard).toEqual(COLOR_THEMES);
  });
});

describe('paletteAfterStyleChange', () => {
  it('keeps a palette the style offers', () => {
    expect(paletteAfterStyleChange('modern', 'nord')).toBe('nord');
    expect(paletteAfterStyleChange('classic', 'highcontrast')).toBe('highcontrast');
  });

  it('moves to the companion otherwise', () => {
    expect(paletteAfterStyleChange('classic', 'nord')).toBe('ledger');
    expect(paletteAfterStyleChange('modern', 'latte')).toBe('studio');
  });

  it('never changes the palette for Standard', () => {
    for (const palette of COLOR_THEMES) {
      expect(paletteAfterStyleChange('standard', palette)).toBe(palette);
    }
  });
});
