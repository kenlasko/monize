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
 * One widget settings array that named an account: the slice and the key, the
 * place the id held, and the array the strip left, so an undo can tell whether
 * the selection is still the one the delete left.
 */
export interface WidgetConfigAccountRef {
  widgetId: string;
  key: string;
  index: number;
  after: unknown[];
}

const ACCOUNT_ID_KEY = /accountids$/i;

/**
 * An incoming `dashboardWidgetConfig` less the account ids the user cannot see
 * (own accounts, plus the joint accounts `jointIds` yields). Every client save
 * path (a widget, the layout, the hero) copies the arrays it last read, so a
 * deleted account's id would otherwise come back. Called inside the update's
 * transaction. `jointIds` runs only when an id is not the user's own.
 */
export async function dropInvisibleAccountIds(
  m: EntityManager,
  userId: string,
  sent: Record<string, unknown>,
  jointIds: () => Promise<Iterable<string>>,
): Promise<Record<string, unknown>> {
  const named = new Set<string>();
  for (const slice of Object.values(sent)) {
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) continue;
    for (const [key, value] of Object.entries(slice)) {
      if (!ACCOUNT_ID_KEY.test(key) || !Array.isArray(value)) continue;
      for (const id of value) if (typeof id === "string") named.add(id);
    }
  }
  if (named.size === 0) return sent;

  const own: { id: string }[] = await m.query(
    `SELECT id FROM accounts WHERE user_id = $1 AND id::text = ANY($2::text[])`,
    [userId, [...named]],
  );
  const visible = new Set(own.map((r) => r.id));
  if (visible.size < named.size) {
    const joint = new Set(await jointIds());
    for (const id of named) if (joint.has(id)) visible.add(id);
  }

  return Object.fromEntries(
    Object.entries(sent).map(([widgetId, slice]) => {
      if (!slice || typeof slice !== "object" || Array.isArray(slice)) {
        return [widgetId, slice];
      }
      return [
        widgetId,
        Object.fromEntries(
          Object.entries(slice).map(([key, value]) => [
            key,
            ACCOUNT_ID_KEY.test(key) && Array.isArray(value)
              ? value.filter((id) => typeof id !== "string" || visible.has(id))
              : value,
          ]),
        ),
      ];
    }),
  );
}

/**
 * Drops deleted account ids from every array in every widget slice. The map is
 * JSONB with no foreign key, so without this a widget keeps naming an account
 * that is gone and draws nothing for it. Runs in the deleting transaction and
 * writes the row only when an array names one of the ids. Returns the arrays it
 * changed, for an undo. An array left empty means "all accounts" to the
 * widgets, the default. JSON null elements are kept.
 */
export async function stripAccountIdsFromWidgetConfig(
  m: EntityManager,
  userId: string,
  accountIds: readonly string[],
): Promise<WidgetConfigAccountRef[]> {
  if (accountIds.length === 0) return [];
  const ids = new Set(accountIds);
  const rows: { widget_id: string; key: string; arr: unknown[] }[] =
    await m.query(
      `SELECT w.key AS widget_id, k.key AS key, k.value AS arr
         FROM user_preferences p
         CROSS JOIN LATERAL jsonb_each(
           CASE WHEN jsonb_typeof(p.dashboard_widget_config) = 'object'
                THEN p.dashboard_widget_config ELSE '{}'::jsonb END) w
         CROSS JOIN LATERAL jsonb_each(
           CASE WHEN jsonb_typeof(w.value) = 'object' THEN w.value ELSE '{}'::jsonb END) k
        WHERE p.user_id = $1
          AND jsonb_typeof(k.value) = 'array'
          AND k.value ?| $2::text[]`,
      [userId, [...accountIds]],
    );
  if (rows.length === 0) return [];
  await m.query(
    `UPDATE user_preferences p
        SET dashboard_widget_config = (
          SELECT COALESCE(jsonb_object_agg(w.key,
                   CASE WHEN jsonb_typeof(w.value) = 'object' THEN (
                     SELECT COALESCE(jsonb_object_agg(k.key,
                              CASE WHEN jsonb_typeof(k.value) = 'array' THEN (
                                SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
                                  FROM jsonb_array_elements(k.value) e
                                 WHERE (e #>> '{}') IS NULL
                                    OR (e #>> '{}') <> ALL($2::text[]))
                              ELSE k.value END), '{}'::jsonb)
                       FROM jsonb_each(w.value) k)
                   ELSE w.value END), '{}'::jsonb)
            FROM jsonb_each(p.dashboard_widget_config) w)
      WHERE p.user_id = $1
        AND jsonb_typeof(p.dashboard_widget_config) = 'object'`,
    [userId, [...accountIds]],
  );
  return rows.map((r) => ({
    widgetId: r.widget_id,
    key: r.key,
    index: r.arr.findIndex((e) => typeof e === "string" && ids.has(e)),
    after: r.arr.filter((e) => !(typeof e === "string" && ids.has(e))),
  }));
}

/**
 * Puts a deleted account's id back where `stripAccountIdsFromWidgetConfig`
 * took it from (an undo), at its old index, but only while the array is still
 * exactly what the delete left: a selection the user changed since is theirs.
 */
export async function restoreAccountIdInWidgetConfig(
  m: EntityManager,
  userId: string,
  accountId: string,
  refs: readonly WidgetConfigAccountRef[],
): Promise<void> {
  for (const { widgetId, key, index, after } of refs) {
    if (!Array.isArray(after) || !Number.isInteger(index) || index < 0)
      continue;
    const restored = [...after];
    restored.splice(index, 0, accountId);
    await m.query(
      `UPDATE user_preferences
          SET dashboard_widget_config = jsonb_set(
                dashboard_widget_config, ARRAY[$2::text, $3::text], $5::jsonb)
        WHERE user_id = $1
          AND jsonb_typeof(dashboard_widget_config) = 'object'
          AND jsonb_typeof(dashboard_widget_config -> $2::text) = 'object'
          AND (dashboard_widget_config #> ARRAY[$2::text, $3::text]) = $4::jsonb`,
      [userId, widgetId, key, JSON.stringify(after), JSON.stringify(restored)],
    );
  }
}
