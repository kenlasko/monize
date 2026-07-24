import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  TourProgressEntry,
  TourProgressMap,
  UserPreference,
} from "../users/entities/user-preference.entity";
import { buildDefaultPreferences } from "../users/user-preference.factory";
import { currentRequestLocale } from "../i18n/request-locale";
import { tenantTx } from "../common/db/tenant-tx";
import { ReleaseNotesService } from "./release-notes.service";

/** Cap on stored tour entries; oldest are pruned past this. */
const MAX_TOUR_ENTRIES = 200;

/**
 * Per-user guided-tour progress. Stored in the `tour_progress` jsonb column on
 * user_preferences and written exclusively through the RLS-compliant `tenantTx`
 * door (no injected repository / QueryRunner -- see the RLS ratchet note in the
 * root CLAUDE.md). These methods run from authenticated controllers, so the
 * request context already supplies the identity `tenantTx` needs.
 *
 * Saves are fire-and-forget from potentially several browser tabs at once, so
 * `saveProgress` merges a single entry into the map **atomically in SQL**
 * (`tour_progress || $1::jsonb`) rather than reading the whole map into JS and
 * writing it back -- a read-modify-write would let one tab clobber another tab's
 * concurrent completion.
 */
@Injectable()
export class ToursService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly releaseNotesService: ReleaseNotesService,
  ) {}

  /** Return the user's full tour-progress map (empty when no row/column yet). */
  async getProgress(userId: string): Promise<TourProgressMap> {
    const prefs = await tenantTx(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return prefs?.tourProgress ?? {};
  }

  /**
   * Record a single tour as completed or dismissed. The version is stamped only
   * on `release-*` ids so a future release can re-offer them. Merges atomically;
   * materializes a preferences row when none exists yet (mirrors
   * WhatsNewService.markSeen). A best-effort second pass caps the map size.
   */
  async saveProgress(
    userId: string,
    tourId: string,
    status: "completed" | "dismissed",
  ): Promise<{ saved: boolean }> {
    const entry: TourProgressEntry = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (tourId.startsWith("release-")) {
      entry.version = this.releaseNotesService.currentVersion;
    }
    const patch: TourProgressMap = { [tourId]: entry };

    await tenantTx(this.dataSource, async (manager) => {
      const repo = manager.getRepository(UserPreference);

      // Atomic single-entry merge; RETURNING lets us detect the missing-row case
      // without a separate read.
      const updated: unknown[] = await manager.query(
        `UPDATE user_preferences
            SET tour_progress = tour_progress || $1::jsonb
          WHERE user_id = $2
        RETURNING user_id`,
        [JSON.stringify(patch), userId],
      );

      if (updated.length === 0) {
        const created = buildDefaultPreferences(userId, currentRequestLocale());
        created.tourProgress = patch;
        await repo.save(created);
        return;
      }

      // Best-effort cap: prune the oldest entries when the map grows unbounded.
      // Rare enough (200+ tours completed) that a read-modify-write here is fine.
      const prefs = await repo.findOne({ where: { userId } });
      const map = prefs?.tourProgress ?? {};
      const keys = Object.keys(map);
      if (prefs && keys.length > MAX_TOUR_ENTRIES) {
        const kept = keys
          .sort((a, b) => (map[a].updatedAt < map[b].updatedAt ? -1 : 1))
          .slice(keys.length - MAX_TOUR_ENTRIES);
        const pruned: TourProgressMap = {};
        for (const key of kept) {
          pruned[key] = map[key];
        }
        prefs.tourProgress = pruned;
        await repo.save(prefs);
      }
    });

    return { saved: true };
  }

  /** Clear all tour progress ("Reset tour progress" in Settings). */
  async resetProgress(userId: string): Promise<{ reset: boolean }> {
    await tenantTx(this.dataSource, async (manager) => {
      await manager.query(
        `UPDATE user_preferences SET tour_progress = '{}'::jsonb WHERE user_id = $1`,
        [userId],
      );
    });
    return { reset: true };
  }
}
