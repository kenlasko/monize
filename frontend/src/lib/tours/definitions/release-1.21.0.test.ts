import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTranslator } from 'use-intl';
import {
  RELEASE_1_21_COMMAND_PALETTE_TOUR,
  RELEASE_1_21_DASHBOARD_EDIT_TOUR,
  RELEASE_1_21_IN_APP_HELP_TOUR,
  RELEASE_1_21_MINOR,
  RELEASE_1_21_TOURS,
} from './release-1.21.0';
import { TOUR_ANCHORS } from '../anchors';
import type { TourAnchorId } from '../anchors';
import { getReleaseTours, getTourById } from '../registry';
import { isTourOfferable } from '../requirements';
import { DOCS_LINKS } from '@/lib/docs-links';
import type { TourDefinition } from '../types';

const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));
const stepOf = (tour: TourDefinition, id: string) => tour.steps.find((s) => s.id === id);
const allMet = {
  transactionEntry: true,
  accountsExist: true,
  securitiesExist: true,
  ownerView: true,
};

describe('1.21 release tours', () => {
  it('are registered on the 1.21 line under stable ids', () => {
    expect(RELEASE_1_21_MINOR).toBe('1.21');
    expect(RELEASE_1_21_TOURS.map((t) => t.id)).toEqual([
      'release-1.21.0/command-palette',
      'release-1.21.0/in-app-help',
      'release-1.21.0/dashboard-edit',
    ]);
    for (const tour of RELEASE_1_21_TOURS) {
      expect(tour.version).toBe('1.21');
      expect(getTourById(tour.id)).toBe(tour);
    }
    expect(getReleaseTours('1.21.2').map((t) => t.id)).toEqual(
      RELEASE_1_21_TOURS.map((t) => t.id),
    );
    expect(getReleaseTours('1.20.0').map((t) => t.id)).not.toContain(
      RELEASE_1_21_COMMAND_PALETTE_TOUR.id,
    );
  });

  it.each(RELEASE_1_21_TOURS.map((t) => [t.id, t] as const))(
    '%s opens route-agnostic, ends on a centered card and links its guide section',
    (_id, tour) => {
      const first = tour.steps[0];
      expect(first.id).toBe('welcome');
      expect(first.route).toBeUndefined();
      expect(first.anchorId).toBeNull();
      const last = tour.steps[tour.steps.length - 1];
      expect(last.id).toBe('done');
      expect(last.route).toBeUndefined();
      expect(last.anchorId).toBeNull();
      expect(tour.docs && DOCS_LINKS[tour.docs]).toBeTruthy();
    },
  );

  it.each(RELEASE_1_21_TOURS.map((t) => [t.id, t] as const))(
    '%s references only declared anchors, one per anchored step',
    (_id, tour) => {
      const anchored = tour.steps.filter((s) => s.anchorId !== null);
      for (const s of anchored) {
        expect(ANCHOR_VALUES.has(s.anchorId as TourAnchorId)).toBe(true);
      }
      const ids = anchored.map((s) => s.anchorId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of tour.steps) {
        if (s.advance && 'anchorId' in s.advance) {
          expect(ANCHOR_VALUES.has(s.advance.anchorId)).toBe(true);
        }
        // Every dynamic part is opened by the reader; nothing here needs a
        // route the engine cannot build.
        expect(s.routeMatch).toBeUndefined();
      }
    },
  );
});

describe('command palette tour', () => {
  const tour = RELEASE_1_21_COMMAND_PALETTE_TOUR;
  const step = (id: string) => stepOf(tour, id);
  const IN_PALETTE = ['searchBox', 'results', 'closePalette'];

  it('asks for the shortcut, walks the open palette, then has the reader close it', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'openPalette',
      'searchBox',
      'results',
      'closePalette',
      'done',
    ]);
    // The palette has no button: an anchorless coach mark waits for its box.
    expect(step('openPalette')?.anchorId).toBeNull();
    expect(step('openPalette')?.unobtrusive).toBe(true);
    expect(step('openPalette')?.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.commandPaletteInput,
    });
    expect(step('closePalette')?.anchorId).toBe(TOUR_ANCHORS.commandPaletteClose);
    expect(step('closePalette')?.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.commandPaletteInput,
    });
  });

  it('opens the palette on a plain page, never over a dialog', () => {
    for (const id of ['openPalette', ...IN_PALETTE]) {
      expect(step(id)?.route).toBe('/dashboard');
    }
  });

  it('keeps the box usable while reading, and never steps Back into a closed palette', () => {
    expect(step('searchBox')?.anchorId).toBe(TOUR_ANCHORS.commandPaletteInput);
    expect(step('searchBox')?.allowInteraction).toBe(true);
    expect(step('results')?.anchorId).toBe(TOUR_ANCHORS.commandPaletteResults);
    for (const id of IN_PALETTE) expect(step(id)?.skipOnBack).toBe(true);
  });

  it('is keyboard only, so a phone sees just the welcome and the closing card', () => {
    for (const id of ['openPalette', ...IN_PALETTE]) {
      expect(step(id)?.skipOnMobile).toBe(true);
    }
    expect(step('welcome')?.skipOnMobile).toBeUndefined();
    expect(step('done')?.skipOnMobile).toBeUndefined();
    expect(tour.requiresData).toBeUndefined();
    expect(isTourOfferable(tour, { ...allMet, ownerView: false })).toBe(true);
  });
});

describe('in-app help tour', () => {
  const tour = RELEASE_1_21_IN_APP_HELP_TOUR;
  const step = (id: string) => stepOf(tour, id);

  it('opens the panel from the page title, walks it, closes it, then shows the other ways in', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'pageHelp',
      'panel',
      'panelControls',
      'helpMenu',
      'learnMore',
      'done',
    ]);
    expect(step('pageHelp')?.anchorId).toBe(TOUR_ANCHORS.pageHelpButton);
    expect(step('pageHelp')?.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.helpPanel,
    });
    expect(step('panel')?.anchorId).toBe(TOUR_ANCHORS.helpPanel);
    // The reader can scroll and follow links in the panel while reading.
    expect(step('panel')?.allowInteraction).toBe(true);
    expect(step('panelControls')?.anchorId).toBe(TOUR_ANCHORS.helpPanelToolbar);
    expect(step('panelControls')?.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.helpPanel,
    });
    expect(step('panel')?.skipOnBack).toBe(true);
    expect(step('panelControls')?.skipOnBack).toBe(true);
  });

  it('stays on one page that always has a ? beside its title', () => {
    for (const s of tour.steps.slice(1, -1)) expect(s.route).toBe('/transactions');
  });

  it('skips the header Help menu on a phone, where it lives in the drawer', () => {
    expect(step('helpMenu')?.anchorId).toBe(TOUR_ANCHORS.helpMenuButton);
    expect(step('helpMenu')?.skipOnMobile).toBe(true);
    expect(step('learnMore')?.anchorId).toBeNull();
    expect(step('learnMore')?.unobtrusive).toBe(true);
  });
});

describe('dashboard edit tour', () => {
  const tour = RELEASE_1_21_DASHBOARD_EDIT_TOUR;
  const step = (id: string) => stepOf(tour, id);

  it('enters edit mode from the gear, walks the bar and the grid, and leaves on Done or Cancel', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'enterEdit',
      'editBar',
      'arrange',
      'finish',
      'done',
    ]);
    expect(step('enterEdit')?.anchorId).toBe(TOUR_ANCHORS.dashboardCustomize);
    expect(step('enterEdit')?.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.dashboardEditBar,
    });
    expect(step('editBar')?.anchorId).toBe(TOUR_ANCHORS.dashboardEditBar);
    expect(step('finish')?.anchorId).toBe(TOUR_ANCHORS.dashboardEditActions);
    expect(step('finish')?.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.dashboardEditBar,
    });
    for (const id of ['editBar', 'arrange', 'finish']) {
      expect(step(id)?.skipOnBack).toBe(true);
    }
    for (const s of tour.steps.slice(1, -1)) expect(s.route).toBe('/dashboard');
  });

  it('lets the reader try a drag on the grid without dimming it', () => {
    expect(step('arrange')?.anchorId).toBe(TOUR_ANCHORS.dashboardWidgets);
    expect(step('arrange')?.allowInteraction).toBe(true);
    expect(step('arrange')?.unobtrusive).toBe(true);
  });

  it('is owner-only: a delegate dashboard has no gear', () => {
    expect(tour.requiresData).toBe('ownerView');
    expect(isTourOfferable(tour, allMet)).toBe(true);
    expect(isTourOfferable(tour, { ...allMet, ownerView: false })).toBe(false);
  });
});

describe('1.21 tour copy', () => {
  const messagesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'i18n',
    'messages',
  );
  const locales = readdirSync(messagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // A regional variant carries only the leaves that differ from its base.
    .map((entry) => entry.name)
    .filter((locale) => !['en-GB', 'en-US'].includes(locale));
  const load = (locale: string) => {
    const messages = JSON.parse(readFileSync(join(messagesDir, locale, 'tours.json'), 'utf8'));
    const t = createTranslator({ locale: 'en', messages, namespace: undefined });
    return t as unknown as (key: string) => string;
  };

  it.each(locales)('formats every step in "%s" without an ICU error', (locale) => {
    const translate = load(locale);
    for (const tour of RELEASE_1_21_TOURS) {
      expect(translate(`${tour.i18nPrefix}.title`).length).toBeGreaterThan(0);
      for (const s of tour.steps) {
        const base = `${tour.i18nPrefix}.steps.${s.id}`;
        expect(translate(`${base}.title`).length).toBeGreaterThan(0);
        expect(translate(`${base}.body`).length).toBeGreaterThan(0);
        expect(translate(`${base}.body`)).not.toContain('--');
      }
    }
  });

  it('closes the palette, the panel and edit mode with their buttons, never the Esc key', () => {
    // The tour claims Escape to end itself, so copy that sends the reader to
    // the key would end the tour instead of moving it on.
    const translate = load('en');
    const body = (tour: TourDefinition, id: string) =>
      translate(`${tour.i18nPrefix}.steps.${id}.body`);
    expect(body(RELEASE_1_21_COMMAND_PALETTE_TOUR, 'closePalette')).toMatch(/^Click \*\*esc\*\*/);
    expect(body(RELEASE_1_21_IN_APP_HELP_TOUR, 'panelControls')).toContain('Click **Close**');
    expect(body(RELEASE_1_21_DASHBOARD_EDIT_TOUR, 'finish')).toMatch(
      /Click \*\*Done\*\*.*\*\*Cancel\*\*/,
    );
    expect(body(RELEASE_1_21_DASHBOARD_EDIT_TOUR, 'finish')).not.toMatch(/Esc/i);
  });
});
