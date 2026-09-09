import { describe, it, expect } from 'vitest';
import { buildManifest } from './pwa-manifest';
import { THEME_SWATCHES } from './theme-swatches';

describe('buildManifest', () => {
  it('serves the default light splash palette for a light resolved theme', () => {
    const manifest = buildManifest('light');
    expect(manifest.background_color).toBe(THEME_SWATCHES.default.light.page);
    expect(manifest.theme_color).toBe(THEME_SWATCHES.default.light.page);
  });

  it('serves the default dark splash palette for a dark resolved theme', () => {
    const manifest = buildManifest('dark');
    expect(manifest.background_color).toBe(THEME_SWATCHES.default.dark.page);
    expect(manifest.theme_color).toBe(THEME_SWATCHES.default.dark.page);
  });

  it('follows the active colour palette', () => {
    const nordDark = buildManifest('dark', 'nord');
    expect(nordDark.background_color).toBe(THEME_SWATCHES.nord.dark.page);

    const latteLight = buildManifest('light', 'latte');
    expect(latteLight.background_color).toBe(THEME_SWATCHES.latte.light.page);
  });

  it('falls back to the default light palette when no cookies exist', () => {
    const manifest = buildManifest(null, null);
    expect(manifest.background_color).toBe(THEME_SWATCHES.default.light.page);
    expect(manifest.theme_color).toBe(THEME_SWATCHES.default.light.page);
  });

  it('keeps the identity fields and icon set stable across themes', () => {
    const light = buildManifest('light');
    const dark = buildManifest('dark', 'midnight');

    expect(light.id).toBe('/');
    expect(light.name).toBe('Monize - Personal Finance Manager');
    expect(light.short_name).toBe('Monize');
    expect(light.start_url).toBe('/');
    expect(light.display).toBe('standalone');
    expect(light.icons).toHaveLength(4);
    expect(
      light.icons?.filter((icon) => icon.purpose === 'maskable'),
    ).toHaveLength(2);

    // Only the splash palette may differ between the two.
    expect({ ...dark, background_color: null, theme_color: null }).toEqual({
      ...light,
      background_color: null,
      theme_color: null,
    });
  });
});

// The Web Share Target was removed: the OS share sheet handed files to a
// review screen that could not reliably find them again, so Monize no longer
// asks to be in that sheet at all. Declaring the member is what puts it back,
// hence a guard rather than a deleted test.
describe('buildManifest share target removal', () => {
  it('declares no share_target member on any theme', () => {
    for (const manifest of [
      buildManifest('light'),
      buildManifest('dark'),
      buildManifest('dark', 'midnight'),
      buildManifest(null),
    ]) {
      expect(manifest).not.toHaveProperty('share_target');
    }
  });
});
