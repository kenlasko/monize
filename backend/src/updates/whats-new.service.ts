import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { buildDefaultPreferences } from "../users/user-preference.factory";
import { currentRequestLocale } from "../i18n/request-locale";
import { DemoModeService } from "../common/demo-mode.service";
import { tenantTx } from "../common/db/tenant-tx";
import { ReleaseNotesService } from "./release-notes.service";
import { ReleaseNotes } from "./release-notes.parser";

export interface WhatsNewStatus {
  /** The running app version. */
  currentVersion: string;
  /**
   * Whether the digest should pop up automatically on app load: the user has
   * the feature enabled, hasn't already acknowledged this version, notes exist,
   * and this is not a demo instance.
   */
  autoShow: boolean;
  /** The parsed release notes for the current version, or null when none exist. */
  notes: ReleaseNotes | null;
}

/**
 * Per-user "What's New" digest logic, built on top of the shared
 * ReleaseNotesService. Decides whether the release-notes popup should open
 * automatically and records when a user acknowledges the current version.
 *
 * All user_preferences access goes through `tenantTx` (the RLS-compliant door
 * to the DB), never a new injected repository -- see the RLS ratchet note in
 * the root CLAUDE.md. These methods run from authenticated controllers, so the
 * request context supplies the identity `tenantTx` needs.
 */
@Injectable()
export class WhatsNewService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly releaseNotesService: ReleaseNotesService,
    private readonly demoModeService: DemoModeService,
  ) {}

  async getWhatsNew(userId: string): Promise<WhatsNewStatus> {
    const currentVersion = this.releaseNotesService.currentVersion;
    const notes = this.releaseNotesService.getForCurrentVersion();

    const prefs = await tenantTx(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );

    // Default to enabled: a row that predates this column, or no row yet, still
    // gets the popup. Only an explicit `false` disables it.
    const enabled = prefs ? prefs.showWhatsNew !== false : true;
    const alreadySeen = prefs?.lastSeenVersion === currentVersion;

    const autoShow =
      enabled && !alreadySeen && !this.demoModeService.isDemo && notes !== null;

    return { currentVersion, autoShow, notes };
  }

  /**
   * Record that the user has seen the current version's notes ("Don't show this
   * again"). Stored on user_preferences so it follows the user across devices
   * and reappears automatically when a newer version ships. Mirrors
   * UpdatesService.dismiss for the no-row fallback.
   */
  async markSeen(userId: string): Promise<{ seen: boolean; version: string }> {
    const currentVersion = this.releaseNotesService.currentVersion;

    await tenantTx(this.dataSource, async (manager) => {
      const repo = manager.getRepository(UserPreference);
      const prefs = await repo.findOne({ where: { userId } });
      if (prefs) {
        prefs.lastSeenVersion = currentVersion;
        await repo.save(prefs);
      } else {
        const created = buildDefaultPreferences(userId, currentRequestLocale());
        created.lastSeenVersion = currentVersion;
        await repo.save(created);
      }
    });

    return { seen: true, version: currentVersion };
  }

  /**
   * Clear the acknowledgement for the current version ("Show at next login"), so
   * the digest auto-shows again on the next load. The active counterpart to
   * markSeen: the two are true opposites, so this reliably brings the popup back
   * even if the user (or an earlier session) had already acknowledged it.
   *
   * A missing row, or one that carries no acknowledgement, already auto-shows by
   * default, so there is nothing to clear and no row is created.
   */
  async remindNextLogin(userId: string): Promise<{ reminded: boolean }> {
    await tenantTx(this.dataSource, async (manager) => {
      const repo = manager.getRepository(UserPreference);
      const prefs = await repo.findOne({ where: { userId } });
      if (prefs && prefs.lastSeenVersion !== null) {
        prefs.lastSeenVersion = null;
        await repo.save(prefs);
      }
    });

    return { reminded: true };
  }
}
