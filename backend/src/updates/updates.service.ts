import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";

// Version comes from the backend package.json at build/run time. Using require
// keeps the read synchronous and avoids ESM import-assertion issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/kenlasko/monize/releases/latest";
const FETCH_TIMEOUT_MS = 10_000;

interface GithubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
}

interface LatestReleaseCache {
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  error: string | null;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  dismissed: boolean;
  disabled: boolean;
  error: string | null;
}

/**
 * Parse a version string like "1.8.40" or "v1.8.40" into [major, minor, patch].
 * Returns null if the string does not match that shape.
 */
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Returns true if `latest` is strictly newer than `current`. Both must parse
 * into major.minor.patch; otherwise returns false (treat as "no update").
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

@Injectable()
export class UpdatesService implements OnModuleInit {
  private readonly logger = new Logger(UpdatesService.name);
  private readonly currentVersion: string = backendPkg.version;
  private readonly enabled: boolean;

  private cache: LatestReleaseCache = {
    latestVersion: null,
    releaseUrl: null,
    releaseName: null,
    publishedAt: null,
    checkedAt: null,
    error: null,
  };

  constructor(
    @InjectRepository(UserPreference)
    private readonly preferencesRepository: Repository<UserPreference>,
    private readonly configService: ConfigService,
  ) {
    // Default enabled; disable with UPDATE_CHECK_ENABLED=false.
    const flag = this.configService.get<string>("UPDATE_CHECK_ENABLED");
    this.enabled = flag === undefined ? true : flag !== "false";
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        "Upstream update check disabled via UPDATE_CHECK_ENABLED",
      );
      return;
    }
    // Non-blocking startup refresh so the cache is populated as early as possible.
    void this.refreshLatestRelease();
  }

  @Cron(CronExpression.EVERY_12_HOURS)
  async scheduledRefresh(): Promise<void> {
    if (!this.enabled) return;
    await this.refreshLatestRelease();
  }

  /**
   * Fetch the latest release from GitHub and update the in-memory cache.
   * Network / rate-limit failures are logged and surfaced via `cache.error`
   * rather than thrown — the endpoint stays available.
   */
  async refreshLatestRelease(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Monize-UpdateCheck",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `GitHub releases API returned status ${response.status}; skipping update`,
        );
        this.cache = {
          ...this.cache,
          checkedAt: new Date().toISOString(),
          error: `github_status_${response.status}`,
        };
        return;
      }

      const release = (await response.json()) as GithubRelease;
      if (release.draft || release.prerelease) {
        this.logger.debug(
          `Latest GitHub release ${release.tag_name} is draft/prerelease; ignoring`,
        );
        this.cache = {
          ...this.cache,
          checkedAt: new Date().toISOString(),
          error: null,
        };
        return;
      }

      this.cache = {
        latestVersion: release.tag_name.replace(/^v/, ""),
        releaseUrl: release.html_url,
        releaseName: release.name || release.tag_name,
        publishedAt: release.published_at,
        checkedAt: new Date().toISOString(),
        error: null,
      };
      this.logger.log(
        `Latest upstream release: ${this.cache.latestVersion} (current: ${this.currentVersion})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to refresh latest release from GitHub: ${message}`,
      );
      this.cache = {
        ...this.cache,
        checkedAt: new Date().toISOString(),
        error: "unreachable",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStatus(userId: string): Promise<UpdateStatus> {
    if (!this.enabled) {
      return {
        currentVersion: this.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        releaseName: null,
        publishedAt: null,
        checkedAt: null,
        dismissed: false,
        disabled: true,
        error: null,
      };
    }

    const {
      latestVersion,
      releaseUrl,
      releaseName,
      publishedAt,
      checkedAt,
      error,
    } = this.cache;

    const updateAvailable =
      !!latestVersion && isNewerVersion(this.currentVersion, latestVersion);

    let dismissed = false;
    if (updateAvailable && latestVersion) {
      const prefs = await this.preferencesRepository.findOne({
        where: { userId },
      });
      dismissed = prefs?.dismissedUpdateVersion === latestVersion;
    }

    return {
      currentVersion: this.currentVersion,
      latestVersion,
      updateAvailable,
      releaseUrl,
      releaseName,
      publishedAt,
      checkedAt,
      dismissed,
      disabled: false,
      error,
    };
  }

  /**
   * Record that the user has dismissed the banner for the current latest
   * version. Stored on user_preferences so it survives across devices and
   * re-appears automatically when a newer upstream release is detected.
   */
  async dismiss(
    userId: string,
  ): Promise<{ dismissed: boolean; version: string | null }> {
    const latestVersion = this.cache.latestVersion;
    if (!latestVersion) {
      return { dismissed: false, version: null };
    }

    const prefs = await this.preferencesRepository.findOne({
      where: { userId },
    });
    if (prefs) {
      prefs.dismissedUpdateVersion = latestVersion;
      await this.preferencesRepository.save(prefs);
    } else {
      const created = new UserPreference();
      created.userId = userId;
      created.dismissedUpdateVersion = latestVersion;
      await this.preferencesRepository.save(created);
    }
    return { dismissed: true, version: latestVersion };
  }
}
