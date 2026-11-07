import { describe, it, expect } from 'vitest';
import {
  HELP_PANEL_DEFAULT_WIDTH,
  HELP_PANEL_MAX_WIDTH,
  HELP_PANEL_MIN_WIDTH,
  clampHelpPanelWidth,
  helpPanelMaxWidth,
} from './help-layout';

describe('help panel bounds', () => {
  it('allows 70% of the window, at most 960, never below the minimum', () => {
    expect(helpPanelMaxWidth(1440)).toBe(HELP_PANEL_MAX_WIDTH);
    expect(helpPanelMaxWidth(1000)).toBe(700);
    expect(helpPanelMaxWidth(3000)).toBe(HELP_PANEL_MAX_WIDTH);
    expect(helpPanelMaxWidth(400)).toBe(HELP_PANEL_MIN_WIDTH);
    expect(helpPanelMaxWidth(0)).toBe(HELP_PANEL_MIN_WIDTH);
  });

  it('leaves the page 640px beside a docked panel, where its xl layouts apply', () => {
    // 70% of 1280 is 896, which would leave the page 384px wide.
    expect(helpPanelMaxWidth(1280, true)).toBe(640);
    expect(1280 - helpPanelMaxWidth(1280, true)).toBeGreaterThanOrEqual(640);
    expect(helpPanelMaxWidth(1440, true)).toBe(800);
    expect(helpPanelMaxWidth(1920, true)).toBe(HELP_PANEL_MAX_WIDTH);
    expect(helpPanelMaxWidth(3000, true)).toBe(HELP_PANEL_MAX_WIDTH);
    // Never below the minimum, whatever the window.
    expect(helpPanelMaxWidth(900, true)).toBe(HELP_PANEL_MIN_WIDTH);
  });

  it('clamps a width into the bounds of the window it is read in', () => {
    expect(clampHelpPanelWidth(500, 1008)).toBe(500);
    expect(clampHelpPanelWidth(100, 1008)).toBe(HELP_PANEL_MIN_WIDTH);
    expect(clampHelpPanelWidth(5000, HELP_PANEL_MAX_WIDTH)).toBe(HELP_PANEL_MAX_WIDTH);
    // A window that shrank after the width was chosen.
    expect(clampHelpPanelWidth(900, helpPanelMaxWidth(1000))).toBe(700);
    expect(clampHelpPanelWidth(900, helpPanelMaxWidth(1280, true))).toBe(640);
  });

  it('turns a value that is not a number into the default', () => {
    expect(clampHelpPanelWidth(Number.NaN, 960)).toBe(HELP_PANEL_DEFAULT_WIDTH);
    expect(clampHelpPanelWidth(Number.POSITIVE_INFINITY, 960)).toBe(HELP_PANEL_DEFAULT_WIDTH);
  });
});
