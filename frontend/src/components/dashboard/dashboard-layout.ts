import {
  DASHBOARD_WIDGETS,
  resolveDashboardWidgets,
  type DashboardWidgetId,
} from './widget-registry';
import { isRecord } from '@/lib/helpers/is-record';

/** Width presets, narrowest first: 4, 6, 8 and 12 of the grid's 12 columns at `lg` and up. */
export const WIDGET_WIDTHS = ['third', 'half', 'twoThirds', 'full'] as const;
/** Height presets, shortest first. A height is a floor, never a clip. */
export const WIDGET_HEIGHTS = ['auto', 'compact', 'standard', 'tall'] as const;

export type WidgetWidth = (typeof WIDGET_WIDTHS)[number];
export type WidgetHeight = (typeof WIDGET_HEIGHTS)[number];

/** Where a widget's size is stored, inside its slice of `dashboardWidgetConfig`. */
export const GRID_WIDTH_KEY = 'gridWidth';
export const GRID_HEIGHT_KEY = 'gridHeight';

/** Columns each width preset spans of the grid's 12 at `lg` and up. */
export const WIDTH_SPANS: Record<WidgetWidth, number> = { third: 4, half: 6, twoThirds: 8, full: 12 };
/** Each height preset's floor in px at `lg` and up; auto has none. */
export const HEIGHT_FLOORS_PX: Record<WidgetHeight, number> = { auto: 0, compact: 390, standard: 540, tall: 720 };

/**
 * Complete literal class strings so Tailwind sees every one; they cannot be
 * built from the numbers above. A test holds the two in step.
 */
export const WIDTH_CLASSES: Record<WidgetWidth, string> = {
  third: 'lg:col-span-4',
  half: 'lg:col-span-6',
  twoThirds: 'lg:col-span-8',
  full: 'lg:col-span-12',
};

export const HEIGHT_CLASSES: Record<WidgetHeight, string> = {
  auto: '',
  compact: 'lg:min-h-[390px]',
  standard: 'lg:min-h-[540px]',
  tall: 'lg:min-h-[720px]',
};

/** The width of a widget the reader never resized. */
export const DEFAULT_WIDGET_WIDTH: WidgetWidth = 'half';

export type DashboardLayoutItem = {
  id: DashboardWidgetId;
  width: WidgetWidth;
  height: WidgetHeight;
};

export type DashboardLayout = readonly DashboardLayoutItem[];

export type WidgetConfigMap = Record<string, Record<string, unknown>>;

export type DashboardLayoutAction =
  | { type: 'add'; id: DashboardWidgetId }
  | { type: 'remove'; id: DashboardWidgetId }
  | { type: 'move'; from: number; to: number }
  /** Put a hidden widget at `index`, at `width`: added from a row's gap slot. */
  | { type: 'insert'; id: DashboardWidgetId; index: number; width: WidgetWidth }
  /** A move that may also narrow the widget: a drop on a row's gap slot. */
  | { type: 'moveTo'; from: number; to: number; width?: WidgetWidth }
  | { type: 'resize'; id: DashboardWidgetId; width?: WidgetWidth; height?: WidgetHeight }
  | { type: 'reset' };

const definitionOf = (id: DashboardWidgetId) => DASHBOARD_WIDGETS.find((w) => w.id === id);

const widthRank = (w: WidgetWidth) => WIDGET_WIDTHS.indexOf(w);

function isOneOf<T extends string>(choices: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value);
}

/** The width presets a widget offers: its minimum and every wider one. */
export function widthsOfferedFor(id: DashboardWidgetId): readonly WidgetWidth[] {
  const min = definitionOf(id)?.minWidth ?? DEFAULT_WIDGET_WIDTH;
  return WIDGET_WIDTHS.slice(widthRank(min));
}

/** Whether a widget can be as narrow as `width` (its minimum is no wider). */
export function fitsWidth(id: DashboardWidgetId, width: WidgetWidth): boolean {
  return widthsOfferedFor(id).includes(width);
}

/** The width presets a row's empty end can have: 2 columns is narrower than any widget. */
const GAP_WIDTHS: Partial<Record<number, WidgetWidth>> = { 4: 'third', 6: 'half', 8: 'twoThirds' };

export type RowGap = { index: number; span: 4 | 6 | 8; width: WidgetWidth };

/**
 * The empty ends of the layout's rows at `lg` and up, a third or wider, as
 * CSS row flow without `dense` places the items: an item that does not fit
 * in the rest of its row starts the next one, so the row ends short. `index`
 * is where a widget put into that space goes: before `layout[index]`, or at
 * the end. A slot of exactly the gap's span fills its row, so drawing one
 * moves no widget.
 */
export function rowGaps(layout: DashboardLayout): RowGap[] {
  const gaps: RowGap[] = [];
  let used = 0;
  const close = (index: number) => {
    const span = 12 - used;
    const width = GAP_WIDTHS[span];
    if (used > 0 && width) gaps.push({ index, span: span as RowGap['span'], width });
    used = 0;
  };
  layout.forEach((item, i) => {
    const span = WIDTH_SPANS[item.width];
    if (used + span > 12) close(i);
    used += span;
    if (used === 12) used = 0;
  });
  close(layout.length);
  return gaps;
}

/**
 * The `moveTo` for a drop of `layout[from]` on the gap before `layout[gapIndex]`
 * (or at the end), or null when the gap cannot take it: its minimum is wider,
 * or the gap is the end of its own row. A wider widget narrows to the gap; a
 * narrower one keeps its width.
 */
export function moveIntoGap(
  layout: DashboardLayout,
  from: number,
  gapIndex: number,
  gapWidth: WidgetWidth,
): Extract<DashboardLayoutAction, { type: 'moveTo' }> | null {
  const item = layout[from];
  if (!item || gapIndex === from + 1 || !fitsWidth(item.id, gapWidth)) return null;
  const width = widthRank(item.width) > widthRank(gapWidth) ? gapWidth : item.width;
  return { type: 'moveTo', from, to: gapIndex > from ? gapIndex - 1 : gapIndex, width };
}

/** A widget at its default size: the width every widget starts at, and its own height floor. */
export function defaultLayoutItem(id: DashboardWidgetId): DashboardLayoutItem {
  return { id, width: DEFAULT_WIDGET_WIDTH, height: definitionOf(id)?.defaultHeight ?? 'auto' };
}

/** The registry's default widgets in registry order, each at its default size. */
export function defaultDashboardLayout(): DashboardLayout {
  return DASHBOARD_WIDGETS.filter((w) => w.defaultEnabled).map((w) => defaultLayoutItem(w.id));
}

/**
 * The layout read from whatever is stored. A size that is absent, not a
 * string or not a known preset takes the widget's default, and a width
 * narrower than the widget is legible at is raised to its minimum.
 */
export function resolveDashboardLayout(
  dashboardWidgets: string[] | null | undefined,
  dashboardWidgetConfig: WidgetConfigMap | null | undefined,
): DashboardLayout {
  return resolveDashboardWidgets(dashboardWidgets).map((w) => {
    const slice: unknown = dashboardWidgetConfig?.[w.id];
    const stored = isRecord(slice) ? slice : {};
    const storedWidth = stored[GRID_WIDTH_KEY];
    const storedHeight = stored[GRID_HEIGHT_KEY];
    const width = isOneOf(WIDGET_WIDTHS, storedWidth) ? storedWidth : DEFAULT_WIDGET_WIDTH;
    return {
      id: w.id,
      width: widthRank(width) < widthRank(w.minWidth) ? w.minWidth : width,
      height: isOneOf(WIDGET_HEIGHTS, storedHeight) ? storedHeight : w.defaultHeight,
    };
  });
}

export function layoutsEqual(a: DashboardLayout, b: DashboardLayout): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.id === b[i].id && x.width === b[i].width && x.height === b[i].height)
  );
}

/**
 * What Done writes. Only the two size keys are changed; every other key and
 * every slice the registry does not know (the hero's included) passes through.
 * Sizes equal to the default are stored as absent keys, and a widget that
 * left the layout loses its size keys so it returns at its default size.
 * The default widgets in the default order store `[]` whatever their sizes,
 * so the reader keeps following later default-layout changes (DASH-1);
 * `resolveDashboardLayout` reads the sizes from the map with `[]` ids.
 */
export function serializeDashboardLayout(
  draft: DashboardLayout,
  configBefore: WidgetConfigMap | null | undefined,
): { dashboardWidgets: string[]; dashboardWidgetConfig: WidgetConfigMap } {
  const config: WidgetConfigMap = { ...(configBefore ?? {}) };
  const inDraft = new Map(draft.map((item) => [item.id, item]));

  for (const def of DASHBOARD_WIDGETS) {
    const before: unknown = config[def.id];
    const item = inDraft.get(def.id);
    if (!isRecord(before) && !item) continue;

    const slice: Record<string, unknown> = isRecord(before) ? { ...before } : {};
    delete slice[GRID_WIDTH_KEY];
    delete slice[GRID_HEIGHT_KEY];
    if (item && item.width !== DEFAULT_WIDGET_WIDTH) slice[GRID_WIDTH_KEY] = item.width;
    if (item && item.height !== def.defaultHeight) slice[GRID_HEIGHT_KEY] = item.height;

    if (Object.keys(slice).length === 0) delete config[def.id];
    else config[def.id] = slice;
  }

  const ids = draft.map((i) => i.id);
  const defaultIds = defaultDashboardLayout().map((i) => i.id);
  const isDefaultOrder = ids.length === defaultIds.length && ids.every((id, i) => id === defaultIds[i]);
  return { dashboardWidgets: isDefaultOrder ? [] : ids, dashboardWidgetConfig: config };
}

/** Every transition returns the same reference when nothing changes. */
export function layoutReducer(
  state: DashboardLayout,
  action: DashboardLayoutAction,
): DashboardLayout {
  switch (action.type) {
    case 'add': {
      if (!definitionOf(action.id) || state.some((i) => i.id === action.id)) return state;
      return [...state, defaultLayoutItem(action.id)];
    }
    case 'remove': {
      if (!state.some((i) => i.id === action.id)) return state;
      return state.filter((i) => i.id !== action.id);
    }
    case 'move': {
      const { from, to } = action;
      const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n < state.length;
      if (!inRange(from) || !inRange(to) || from === to) return state;
      const next = [...state];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    }
    case 'insert': {
      const { id, index, width } = action;
      if (!definitionOf(id) || state.some((i) => i.id === id)) return state;
      if (!Number.isInteger(index) || index < 0 || index > state.length || !fitsWidth(id, width)) return state;
      const next = [...state];
      next.splice(index, 0, { ...defaultLayoutItem(id), width });
      return next;
    }
    case 'moveTo': {
      const { from, to } = action;
      const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n < state.length;
      if (!inRange(from) || !inRange(to)) return state;
      const moved = state[from];
      const width = action.width ?? moved.width;
      if (!fitsWidth(moved.id, width)) return state;
      if (from === to && width === moved.width) return state;
      const next = [...state];
      next.splice(from, 1);
      next.splice(to, 0, width === moved.width ? moved : { ...moved, width });
      return next;
    }
    case 'resize': {
      const index = state.findIndex((i) => i.id === action.id);
      if (index < 0) return state;
      const current = state[index];
      const width = action.width ?? current.width;
      const height = action.height ?? current.height;
      if (!isOneOf(WIDGET_WIDTHS, width) || !isOneOf(WIDGET_HEIGHTS, height)) return state;
      if (!widthsOfferedFor(action.id).includes(width)) return state;
      if (width === current.width && height === current.height) return state;
      const next = [...state];
      next[index] = { ...current, width, height };
      return next;
    }
    case 'reset':
      return defaultDashboardLayout();
  }
}
