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

  it('clamps a width into the bounds of the window it is read in', () => {
    expect(clampHelpPanelWidth(500, 1440)).toBe(500);
    expect(clampHelpPanelWidth(100, 1440)).toBe(HELP_PANEL_MIN_WIDTH);
    expect(clampHelpPanelWidth(5000, 1440)).toBe(HELP_PANEL_MAX_WIDTH);
    // A window that shrank after the width was chosen.
    expect(clampHelpPanelWidth(900, 1000)).toBe(700);
  });

  it('turns a value that is not a number into the default', () => {
    expect(clampHelpPanelWidth(Number.NaN, 1440)).toBe(HELP_PANEL_DEFAULT_WIDTH);
    expect(clampHelpPanelWidth(Number.POSITIVE_INFINITY, 1440)).toBe(HELP_PANEL_DEFAULT_WIDTH);
  });
});
