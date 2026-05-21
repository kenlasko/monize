import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThanOrEqual } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { promises as fs, readdirSync, unlinkSync, copyFileSync } from "fs";
import { resolve } from "path";
import { AutoBackupSettings } from "./entities/auto-backup-settings.entity";
import { BackupService } from "./backup.service";
import { User } from "../users/entities/user.entity";
import {
  UpdateAutoBackupSettingsDto,
  AutoBackupFrequency,
} from "./dto/update-auto-backup-settings.dto";

const BACKUP_FILE_PREFIX = "monize-backup-";

// File extensions: .json.gz for unencrypted, .mzbe for encrypted Monize backups.
// Retention enforcement matches both so we can clean up legacy and encrypted
// files uniformly.
const DAILY_FILE_PATTERN =
  /^monize-backup-daily-(\d{4}-\d{2}-\d{2})\.(json\.gz|mzbe)$/;
const WEEKLY_FILE_PATTERN =
  /^monize-backup-weekly-(\d{4}-\d{2}-\d{2})\.(json\.gz|mzbe)$/;
const MONTHLY_FILE_PATTERN =
  /^monize-backup-monthly-(\d{2}-\d{2})\.(json\.gz|mzbe)$/;

const WEEKLY_DAYS = [7, 14, 21, 28];

const FREQUENCY_HOURS: Record<AutoBackupFrequency, number> = {
  every6hours: 6,
  every12hours: 12,
  daily: 24,
  weekly: 168,
};

interface BackupFile {
  name: string;
  date: Date;
  tier: "daily" | "weekly" | "monthly";
}

function parseDateString(ds: string): Date | null {
  const date = new Date(ds + "T00:00:00Z");
  return isNaN(date.getTime()) ? null : date;
}

function parseYearMonthString(ym: string): Date | null {
  const date = new Date(`20${ym}-01T00:00:00Z`);
  return isNaN(date.getTime()) ? null : date;
}

@Injectable()
export class AutoBackupService {
  private readonly logger = new Logger(AutoBackupService.name);

  constructor(
    @InjectRepository(AutoBackupSettings)
    private readonly settingsRepo: Repository<AutoBackupSettings>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly backupService: BackupService,
  ) {}

  async getSettings(userId: string): Promise<AutoBackupSettings> {
    const existing = await this.settingsRepo.findOne({
      where: { userId },
    });
    if (existing) return existing;

    // Return default settings (not persisted yet)
    const defaults = new AutoBackupSettings();
    defaults.userId = userId;
    defaults.enabled = false;
    defaults.folderPath = "";
    defaults.frequency = "daily";
    defaults.backupTime = "02:00";
    defaults.retentionDaily = 7;
    defaults.retentionWeekly = 4;
    defaults.retentionMonthly = 6;
    defaults.lastBackupAt = null;
    defaults.lastBackupStatus = null;
    defaults.lastBackupError = null;
    defaults.nextBackupAt = null;
    return defaults;
  }

  async updateSettings(
    userId: string,
    dto: UpdateAutoBackupSettingsDto,
  ): Promise<AutoBackupSettings> {
    let settings = await this.settingsRepo.findOne({
      where: { userId },
    });

    if (!settings) {
      settings = this.settingsRepo.create({ userId });
    }

    if (dto.folderPath !== undefined) {
      settings.folderPath = this.validateFolderPath(dto.folderPath);
    }
    if (dto.frequency !== undefined) {
      settings.frequency = dto.frequency;
    }
    if (dto.backupTime !== undefined) {
      settings.backupTime = dto.backupTime;
    }
    if (dto.timezone !== undefined) {
      settings.timezone = dto.timezone;
    }
    if (dto.retentionDaily !== undefined) {
      settings.retentionDaily = dto.retentionDaily;
    }
    if (dto.retentionWeekly !== undefined) {
      settings.retentionWeekly = dto.retentionWeekly;
    }
    if (dto.retentionMonthly !== undefined) {
      settings.retentionMonthly = dto.retentionMonthly;
    }

    if (dto.enabled !== undefined) {
      settings.enabled = dto.enabled;
      if (dto.enabled) {
        if (!settings.folderPath) {
          throw new BadRequestException(
            "A folder path must be set before enabling automatic backups",
          );
        }
        await this.assertFolderWritable(settings.folderPath);
        settings.nextBackupAt = this.calculateNextBackupAt(
          settings.frequency as AutoBackupFrequency,
          settings.backupTime,
          settings.timezone,
          new Date(),
        );
      } else {
        settings.nextBackupAt = null;
      }
    }

    return this.settingsRepo.save(settings);
  }

  async validateFolder(
    folderPath: string,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const safePath = this.validateFolderPath(folderPath);
      await this.assertFolderWritable(safePath);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  async browseFolders(
    folderPath: string,
  ): Promise<{ current: string; directories: string[] }> {
    const safePath = this.validateFolderPath(folderPath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(safePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new BadRequestException(`Folder does not exist: ${safePath}`);
      }
      throw new BadRequestException(`Cannot access folder: ${safePath}`);
    }

    if (!stat.isDirectory()) {
      throw new BadRequestException(`Path is not a directory: ${safePath}`);
    }

    const entries = await fs.readdir(safePath, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    return { current: safePath, directories };
  }

  async runManualBackup(
    userId: string,
  ): Promise<{ message: string; filename: string }> {
    const settings = await this.settingsRepo.findOne({
      where: { userId },
    });
    if (!settings || !settings.folderPath) {
      throw new BadRequestException(
        "Auto-backup is not configured. Please set a folder path first.",
      );
    }

    await this.assertFolderWritable(settings.folderPath);
    const timezone = settings.timezone || "UTC";
    const filename = await this.exportToFile(
      userId,
      settings.folderPath,
      timezone,
    );
    this.copyToWeeklyIfNeeded(settings.folderPath, filename, timezone);
    this.copyToMonthlyIfNeeded(settings.folderPath, filename, timezone);
    this.enforceRetention(settings.folderPath, settings);

    settings.lastBackupAt = new Date();
    settings.lastBackupStatus = "success";
    settings.lastBackupError = null;
    if (settings.enabled) {
      settings.nextBackupAt = this.calculateNextBackupAt(
        settings.frequency as AutoBackupFrequency,
        settings.backupTime,
        settings.timezone,
        new Date(),
      );
    }
    await this.settingsRepo.save(settings);

    return { message: "Backup completed successfully", filename };
  }

  @Cron("0 * * * *")
  async handleAutoBackupCron(): Promise<void> {
    const now = new Date();
    const dueSettings = await this.settingsRepo.find({
      where: {
        enabled: true,
        nextBackupAt: LessThanOrEqual(now),
      },
    });

    if (dueSettings.length === 0) return;

    this.logger.log(`Auto-backup cron: ${dueSettings.length} backup(s) due`);

    for (const settings of dueSettings) {
      try {
        await this.assertFolderWritable(settings.folderPath);
        const timezone = settings.timezone || "UTC";
        const filename = await this.exportToFile(
          settings.userId,
          settings.folderPath,
          timezone,
        );
        this.copyToWeeklyIfNeeded(settings.folderPath, filename, timezone);
        this.copyToMonthlyIfNeeded(settings.folderPath, filename, timezone);
        this.enforceRetention(settings.folderPath, settings);

        settings.lastBackupAt = now;
        settings.lastBackupStatus = "success";
        settings.lastBackupError = null;
        settings.nextBackupAt = this.calculateNextBackupAt(
          settings.frequency as AutoBackupFrequency,
          settings.backupTime,
          settings.timezone,
          now,
        );
        await this.settingsRepo.save(settings);

        this.logger.log(
          `Auto-backup completed for user ${settings.userId}: ${filename}`,
        );
      } catch (error) {
        this.logger.error(
          `Auto-backup failed for user ${settings.userId}: ${error.message}`,
        );
        settings.lastBackupAt = now;
        settings.lastBackupStatus = "failed";
        settings.lastBackupError = String(error.message).slice(0, 1024);
        settings.nextBackupAt = this.calculateNextBackupAt(
          settings.frequency as AutoBackupFrequency,
          settings.backupTime,
          settings.timezone,
          now,
        );
        await this.settingsRepo.save(settings);
      }
    }
  }

  private async exportToFile(
    userId: string,
    folderPath: string,
    timezone: string,
  ): Promise<string> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException(`User ${userId} not found`);
    }

    const encryptionPassword =
      this.backupService.resolveStoredBackupPassword(user) ?? undefined;
    if (user.backupEncryptionEnabled && !encryptionPassword) {
      // User opted into encryption but we can't recover the password
      // (likely AI_ENCRYPTION_KEY rotated). Fail loud rather than silently
      // writing an unencrypted backup.
      throw new BadRequestException(
        "Encrypted backups are enabled but the stored password could not be decrypted. Re-enable encryption in Security settings.",
      );
    }

    const dateStr = this.getLocalDateString(new Date(), timezone);
    const ext = encryptionPassword ? "mzbe" : "json.gz";
    const filename = `${BACKUP_FILE_PREFIX}daily-${dateStr}.${ext}`;
    const filepath = this.safePath(folderPath, filename);

    const payload = await this.backupService.exportToBuffer(
      userId,
      encryptionPassword,
    );
    await fs.writeFile(filepath, payload);

    this.logger.log(
      `Backup written to ${filepath}${encryptionPassword ? " (encrypted)" : ""}`,
    );
    return filename;
  }

  private copyToWeeklyIfNeeded(
    folderPath: string,
    dailyFilename: string,
    timezone: string,
  ): void {
    const dayOfMonth = this.getLocalDayOfMonth(new Date(), timezone);
    if (!WEEKLY_DAYS.includes(dayOfMonth)) return;

    const ext = dailyFilename.endsWith(".mzbe") ? "mzbe" : "json.gz";
    const dateStr = this.getLocalDateString(new Date(), timezone);
    const weeklyFilename = `${BACKUP_FILE_PREFIX}weekly-${dateStr}.${ext}`;
    try {
      copyFileSync(
        this.safePath(folderPath, dailyFilename),
        this.safePath(folderPath, weeklyFilename),
      );
      this.logger.log(`Copied daily backup to weekly: ${weeklyFilename}`);
    } catch (err) {
      this.logger.warn(`Failed to copy daily to weekly: ${err.message}`);
    }
  }

  private copyToMonthlyIfNeeded(
    folderPath: string,
    dailyFilename: string,
    timezone: string,
  ): void {
    const dayOfMonth = this.getLocalDayOfMonth(new Date(), timezone);
    if (dayOfMonth !== 1) return;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "2-digit",
      month: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const ext = dailyFilename.endsWith(".mzbe") ? "mzbe" : "json.gz";
    const monthlyFilename = `${BACKUP_FILE_PREFIX}monthly-${year}-${month}.${ext}`;

    try {
      copyFileSync(
        this.safePath(folderPath, dailyFilename),
        this.safePath(folderPath, monthlyFilename),
      );
      this.logger.log(`Copied daily backup to monthly: ${monthlyFilename}`);
    } catch (err) {
      this.logger.warn(`Failed to copy daily to monthly: ${err.message}`);
    }
  }

  private enforceRetention(
    folderPath: string,
    settings: AutoBackupSettings,
  ): void {
    let entries: string[];
    try {
      entries = readdirSync(folderPath);
    } catch {
      return;
    }

    const dailyFiles: BackupFile[] = [];
    const weeklyFiles: BackupFile[] = [];
    const monthlyFiles: BackupFile[] = [];

    for (const name of entries) {
      const dailyMatch = DAILY_FILE_PATTERN.exec(name);
      if (dailyMatch) {
        const date = parseDateString(dailyMatch[1]);
        if (date) dailyFiles.push({ name, date, tier: "daily" });
        continue;
      }
      const weeklyMatch = WEEKLY_FILE_PATTERN.exec(name);
      if (weeklyMatch) {
        const date = parseDateString(weeklyMatch[1]);
        if (date) weeklyFiles.push({ name, date, tier: "weekly" });
        continue;
      }
      const monthlyMatch = MONTHLY_FILE_PATTERN.exec(name);
      if (monthlyMatch) {
        const date = parseYearMonthString(monthlyMatch[1]);
        if (date) monthlyFiles.push({ name, date, tier: "monthly" });
        continue;
      }
    }

    // Sort each tier newest first and delete beyond retention limit
    const deleteExcess = (files: BackupFile[], limit: number) => {
      const sorted = [...files].sort(
        (a, b) => b.date.getTime() - a.date.getTime(),
      );
      for (let i = limit; i < sorted.length; i++) {
        try {
          unlinkSync(this.safePath(folderPath, sorted[i].name));
          this.logger.log(`Retention: deleted old backup ${sorted[i].name}`);
        } catch (err) {
          this.logger.warn(
            `Retention: failed to delete ${sorted[i].name}: ${err.message}`,
          );
        }
      }
    };

    deleteExcess(dailyFiles, settings.retentionDaily);
    deleteExcess(weeklyFiles, settings.retentionWeekly);
    deleteExcess(monthlyFiles, settings.retentionMonthly);
  }

  private getLocalDateString(date: Date, timezone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  }

  private getLocalDayOfMonth(date: Date, timezone: string): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      day: "numeric",
    });
    return Number(formatter.format(date));
  }

  private calculateNextBackupAt(
    frequency: AutoBackupFrequency,
    backupTime: string,
    timezone: string,
    fromDate: Date,
  ): Date {
    const [hours] = backupTime.split(":").map(Number);
    const intervalHours = FREQUENCY_HOURS[frequency] ?? 24;

    // Snap minutes to 0 -- the cron fires at minute 0 of each hour,
    // so non-zero minutes would cause the backup to run an hour late.
    const todayInTz = this.localTimeToUtc(fromDate, hours, 0, timezone);

    if (frequency === "daily" || frequency === "weekly") {
      const next = new Date(todayInTz);

      // If the target time is in the past for today, move forward by one interval
      if (next.getTime() <= fromDate.getTime()) {
        next.setTime(next.getTime() + intervalHours * 60 * 60 * 1000);
      }
      return next;
    }

    // Sub-daily frequencies (every6hours, every12hours):
    // Align to the configured time, then add interval increments
    let next = new Date(todayInTz);
    while (next.getTime() <= fromDate.getTime()) {
      next = new Date(next.getTime() + intervalHours * 60 * 60 * 1000);
    }
    return next;
  }

  /**
   * Convert a local time (hours:minutes) in the given timezone to a UTC Date
   * for the same calendar day as `referenceDate`.
   */
  private localTimeToUtc(
    referenceDate: Date,
    hours: number,
    minutes: number,
    timezone: string,
  ): Date {
    // Get the current date parts in the target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(referenceDate);
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const day = parts.find((p) => p.type === "day")!.value;

    // Build an ISO string representing the local time in the timezone,
    // then compute the UTC equivalent by finding the offset
    const localIso = `${year}-${month}-${day}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

    // Use the timezone offset at that specific moment to convert to UTC
    const offsetMs = this.getTimezoneOffsetMs(localIso, timezone);
    return new Date(new Date(localIso + "Z").getTime() - offsetMs);
  }

  /**
   * Get the UTC offset in milliseconds for a given local datetime in a timezone.
   */
  private getTimezoneOffsetMs(localIso: string, timezone: string): number {
    const utcDate = new Date(localIso + "Z");
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(utcDate);
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    const localAtUtc = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`;
    return new Date(localAtUtc).getTime() - utcDate.getTime();
  }

  /**
   * Safely join a folder path with a filename, ensuring the result
   * stays within the base folder (prevents path traversal CWE-22).
   */
  private safePath(basePath: string, filename: string): string {
    const full = resolve(basePath, filename);
    if (!full.startsWith(basePath + "/") && full !== basePath) {
      throw new BadRequestException(`Path traversal detected: ${filename}`);
    }
    return full;
  }

  /**
   * Validate a user-supplied folder path and return the normalized form.
   * All filesystem operations must use the returned value (not the original
   * input) so CodeQL/SAST tools can see the explicit sanitization boundary
   * (CWE-22: Path traversal).
   */
  private validateFolderPath(folderPath: string): string {
    if (typeof folderPath !== "string") {
      throw new BadRequestException("Folder path must be a string");
    }
    if (folderPath.length > 4096) {
      throw new BadRequestException("Folder path is too long");
    }
    if (!folderPath.startsWith("/")) {
      throw new BadRequestException("Folder path must be an absolute path");
    }
    if (folderPath.includes("..")) {
      throw new BadRequestException(
        "Folder path must not contain '..' segments",
      );
    }
    if (folderPath.includes("\0")) {
      throw new BadRequestException("Folder path must not contain null bytes");
    }
    // Trim trailing slashes without a greedy regex (avoids ReDoS on '/' runs).
    let trimmed = folderPath;
    while (trimmed.length > 1 && trimmed.endsWith("/")) {
      trimmed = trimmed.slice(0, -1);
    }
    // Ensure the resolved path matches the input (no symlink-like tricks via //)
    const normalized = resolve(trimmed);
    if (normalized !== trimmed) {
      throw new BadRequestException(
        "Folder path must be a normalized absolute path",
      );
    }
    return normalized;
  }

  private async assertFolderWritable(folderPath: string): Promise<void> {
    // Re-validate defensively: this method is also invoked with folder paths
    // read back from the database (originally user-supplied), so CWE-22
    // sanitization must run every time before we touch the filesystem.
    const safePath = this.validateFolderPath(folderPath);
    try {
      const stat = await fs.stat(safePath);
      if (!stat.isDirectory()) {
        throw new BadRequestException(`Path is not a directory: ${safePath}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new BadRequestException(
          `Folder does not exist: ${safePath}. Ensure the path is mapped as a Docker volume.`,
        );
      }
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `Cannot access folder: ${safePath} - ${error.message}`,
      );
    }

    // Test write access by creating and removing a temporary file
    const testFile = this.safePath(
      safePath,
      `.monize-write-test-${Date.now()}`,
    );
    try {
      await fs.writeFile(testFile, "");
      await fs.unlink(testFile);
    } catch {
      throw new BadRequestException(
        `Folder is not writable: ${safePath}. Check container permissions.`,
      );
    }
  }
}
