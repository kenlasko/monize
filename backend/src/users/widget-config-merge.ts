import type { UserPreference } from "./entities/user-preference.entity";

type WidgetConfigMap = UserPreference["dashboardWidgetConfig"];

/**
 * A `dashboardWidgetConfig` save merged into the stored map by widget id.
 *
 * Each slice in `sent` replaces the stored slice of the same id whole; a
 * `null` slice removes it; an id not sent keeps its stored slice. The map is
 * written by more than one screen (a widget's own settings, the dashboard's
 * edit mode, the hero settings), each owning different slices, so a save that
 * carried the whole map from an older snapshot would undo another screen's
 * write. Inside a slice there is no merge: a widget clears a setting by
 * leaving its key out.
 */
export function mergeWidgetConfig(
  stored: WidgetConfigMap | null | undefined,
  sent: Record<string, unknown>,
): WidgetConfigMap {
  const merged = Object.entries({ ...(stored ?? {}), ...sent }).filter(
    ([, slice]) => slice !== null,
  );
  return Object.fromEntries(merged) as WidgetConfigMap;
}
