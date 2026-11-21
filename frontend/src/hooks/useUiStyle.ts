import { createElement, type ComponentType, type ReactElement } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { isUiStyle, type UiStyle } from '@/lib/ui-styles';

/**
 * The active UI style, for a component whose STRUCTURE differs by style.
 *
 * Most of a style is CSS (`src/app/ui-styles.css`) and needs no component to
 * know about it. Reach for this only where a style rearranges a screen -- a
 * register with split Payment / Deposit columns, a hero that becomes a
 * statement figure -- and then through `renderForStyle`, never as scattered
 * `uiStyle === 'folio'` checks in markup.
 *
 * Falls back to 'standard' when no style is known, as under a test that
 * mocks `useTheme` without `uiStyle`.
 */
export function useUiStyle(): UiStyle {
  const style: unknown = useTheme().uiStyle;
  return isUiStyle(style) ? style : 'standard';
}

/**
 * One renderer per style for a component whose layout differs by style.
 * `standard` is required and is the fallback for any style without its own.
 */
export type StyleVariants<P> = { standard: ComponentType<P> } & Partial<
  Record<Exclude<UiStyle, 'standard'>, ComponentType<P>>
>;

/**
 * Render the variant for `style`.
 *
 * The pattern this exists for: the component that owns a screen computes its
 * data ONCE (its hooks, fetches and derived figures stay where they are, in
 * the standard component or a `use<Thing>Model` hook it exposes) and hands the
 * same props to whichever renderer the style picks. A variant renders; it
 * never fetches or derives a figure of its own, so a fix to the data reaches
 * every style at once and a new style is new markup only.
 *
 * `variants` must be a module-level constant so each renderer keeps its
 * identity between renders.
 */
export function renderForStyle<P extends object>(
  style: UiStyle,
  variants: StyleVariants<P>,
  props: P,
): ReactElement {
  return createElement(variants[style] ?? variants.standard, props);
}
