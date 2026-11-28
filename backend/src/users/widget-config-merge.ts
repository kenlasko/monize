import type { EntityManager } from "typeorm";
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

/**
 * Drops deleted account ids from every array in every widget slice. The map is
 * JSONB with no foreign key, so without this a widget keeps naming an account
 * that is gone and draws nothing for it. Runs in the deleting transaction.
 * An array left empty means "all accounts" to the widgets, the default.
 */
export async function stripAccountIdsFromWidgetConfig(
  m: EntityManager,
  userId: string,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  await m.query(
    `UPDATE user_preferences p
        SET dashboard_widget_config = (
          SELECT COALESCE(jsonb_object_agg(w.key,
                   CASE WHEN jsonb_typeof(w.value) = 'object' THEN (
                     SELECT COALESCE(jsonb_object_agg(k.key,
                              CASE WHEN jsonb_typeof(k.value) = 'array' THEN (
                                SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
                                  FROM jsonb_array_elements(k.value) e
                                 WHERE (e #>> '{}') <> ALL($2::text[]))
                              ELSE k.value END), '{}'::jsonb)
                       FROM jsonb_each(w.value) k)
                   ELSE w.value END), '{}'::jsonb)
            FROM jsonb_each(p.dashboard_widget_config) w)
      WHERE p.user_id = $1`,
    [userId, [...accountIds]],
  );
}
