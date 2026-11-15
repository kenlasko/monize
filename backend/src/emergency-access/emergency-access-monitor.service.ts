import { Injectable, Logger } from "@nestjs/common";
import { decryptMessage } from "./decrypt-message.util";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  DataSource,
  EntityTarget,
  IsNull,
  LessThan,
  Not,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { I18nService } from "nestjs-i18n";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { EmailService } from "../notifications/email.service";
import {
  emergencyAccessGrantTemplate,
  emergencyAccessGrantRevokedTemplate,
  emergencyAccessReminderTemplate,
} from "../notifications/email-templates";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { hashToken, tokenHashesEqual } from "../auth/crypto.util";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withSystemContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CLAIM_TOKEN_BYTES = 32;
const CLAIM_TOKEN_TTL_DAYS = 30;

/**
 * How long one replica holds the right to send this owner's notice.
 *
 * A **lease**, not a permanent claim, and that distinction is the whole of
 * FV4-005: a permanent claim taken before the send is consumed by a replica that
 * dies before sending, so the notice is owed forever and nothing knows. The
 * lease only has to outlast an SMTP round trip; when it expires, whether the
 * work is still owed is decided by the delivery record, not by the claim.
 */
const SEND_LEASE_MS = 10 * 60 * 1000;

/**
 * The owner fields a grant notice needs. Narrowed to a non-null `email` because
 * `processOne` refuses an owner without one, and the notice falls back to it for
 * a display name.
 */
interface GrantNoticeOwner {
  firstName: string | null;
  lastName: string | null;
  email: string;
}

@Injectable()
export class EmergencyAccessMonitorService {
  private readonly logger = new Logger(EmergencyAccessMonitorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly encryption: EncryptionService,
    private readonly configService: ConfigService,
    private readonly i18n: I18nService,
    private readonly jobClaims: JobClaimService,
  ) {}

  /**
   * Move this owner from ungranted to granted, atomically, and return the grant
   * cycle the winner is now in. `null` for every caller that lost.
   *
   * `granted_at IS NULL` and `enabled = true` are predicates of the UPDATE, so
   * PostgreSQL re-evaluates them after the row lock: exactly one replica gets a
   * row back, and an owner who disabled the feature between the sweep's read and
   * here is not granted at all.
   *
   * `grant_generation` is advanced in the same statement, and that placement is
   * the whole of RRV4-004. Per-contact delivery state has to be scoped to one
   * cycle, and the alternative -- clearing each contact's marker in every path
   * that re-arms monitoring (the owner returning, a disable/re-enable, a manual
   * reset, a corrected address) -- is five call sites in three files whose
   * failure mode is silent. Here there is one, it is the transition that *defines*
   * a new cycle, and no re-arm path has to remember anything: it clears
   * `granted_at`, and the next grant's generation is simply past whatever the
   * contacts were notified at.
   */
  private async claimGrant(ownerUserId: string): Promise<number | null> {
    const updated = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE emergency_access_settings
            SET granted_at = CURRENT_TIMESTAMP,
                grant_generation = grant_generation + 1
          WHERE owner_user_id = $1
            AND granted_at IS NULL
            AND enabled = true
          RETURNING grant_generation`,
        [ownerUserId],
      ),
    );
    const rows = returnedRows<{ grant_generation: number }>(updated);
    return rows.length > 0 ? Number(rows[0].grant_generation) : null;
  }

  /**
   * The owner's current grant cycle, read fresh **and re-validated**.
   *
   * The resume path (step 1b) must not advance it -- it is finishing the cycle
   * `claimGrant` already opened -- and cannot take it from the sweep's snapshot
   * either, because that row was read before this owner's grant was claimed,
   * possibly by another replica.
   *
   * The `enabled` / `granted_at` predicates are the same re-validation
   * `claimGrant` performs, for the same reason: `settings` is a snapshot from the
   * top of a sweep that makes an SMTP round trip per contact, so by the time the
   * resume runs the owner may have disabled the feature (which voids every link),
   * returned (which another replica's revocation sweep acts on), or had the account
   * claimed outright -- and all three clear one of these two columns. Reading only
   * the generation meant the resume then delivered fresh, working links into an
   * account whose owner had just revoked them. `null` means stand down.
   */
  private async currentGrantGeneration(
    ownerUserId: string,
  ): Promise<number | null> {
    const row = await this.scoped(EmergencyAccessSettings, (repo) =>
      repo.findOne({
        where: { ownerUserId, enabled: true, grantedAt: Not(IsNull()) },
        select: ["ownerUserId", "grantGeneration"],
      }),
    );
    return row ? Number(row.grantGeneration) : null;
  }

  /**
   * Hand a claimed grant back when no contact could be reached.
   *
   * Conditional on the grant still being the one this attempt claimed: an
   * unqualified `SET granted_at = NULL` from a slow, all-failed delivery loop would
   * also erase a `granted_at` written since -- the claim controller stamps one when
   * a contact completes the takeover -- destroying the record of the claim rather
   * than releasing the attempt's own.
   */
  private async releaseGrant(ownerUserId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE emergency_access_settings
            SET granted_at = NULL
          WHERE owner_user_id = $1
            AND granted_at IS NOT NULL
            AND enabled = true`,
        [ownerUserId],
      ),
    ).catch((error: unknown) =>
      this.logger.error(
        `Failed to release emergency-access grant claim for user ${ownerUserId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async runDailyCheck(): Promise<void> {
    // Revocation runs FIRST, before any delivery dependency is consulted.
    // Voiding an outstanding link needs only the database, and an owner who has
    // returned is exposed for every day it waits: an already-issued 30-day link
    // stayed claimable on an install whose SMTP or encryption key had gone away,
    // because the whole sweep -- revocation included -- sat behind those gates
    // (stack review REMAINING-001). The owner notice inside `revokeAfterReturn`
    // is best-effort and survives a missing SMTP config; the revocation writes do
    // not depend on it.
    await withSystemContext(() => this.revokeReturnedOwners());

    if (!this.emailService.getStatus().configured) {
      this.logger.debug(
        "SMTP not configured, skipping emergency access delivery checks",
      );
      return;
    }
    // A gate, not a per-contact failure. Grant delivery encrypts each contact's
    // claim token, so without a key `credentialFor` throws for every contact,
    // every day, delivering nothing (audit V4R3-002). An install can hold an
    // `enabled = true` row that predates this dependency -- `upsertSettings` now
    // refuses to *arm* the feature without the key, but says nothing about rows
    // already armed. Skipping the whole sweep once with a warning replaces a daily
    // storm of per-contact stack traces with one honest line; the settings view's
    // `credentialEncryptionConfigured` flag is what surfaces the degraded state to
    // the owner. The feature is inert here, not silently firing and failing.
    if (!this.encryption.isConfigured()) {
      this.logger.warn(
        "ENCRYPTION_KEY not configured; emergency access cannot issue grant " +
          "links, so the daily check is skipped. Any enabled owner is inert until " +
          "the key is set. Owners can still disable the feature in Settings.",
      );
      return;
    }

    // RLS (task C4): cross-user sweep over every owner with emergency access
    // enabled; processOne reads/writes owner-keyed rows (users, the emergency-
    // access tables) for many users, so the whole sweep runs under a system
    // context. Inert at RLS_MODE=off -- only seeds AsyncLocalStorage.
    return withSystemContext(() => this.runDailyCheckWithinContext());
  }

  /**
   * Void outstanding links for every granted owner who is active again.
   *
   * Deliberately independent of the delivery sweep and of its SMTP/encryption
   * gates: revocation is pure database work plus a best-effort notice, so it must
   * keep happening on a degraded install where nothing can be *delivered*
   * (stack review REMAINING-001). `processOne` keeps its own returned-owner check
   * as a second line of defence for owners who return mid-sweep.
   */
  private async revokeReturnedOwners(): Promise<void> {
    const granted = await this.scoped(EmergencyAccessSettings, (repo) =>
      repo.find({ where: { enabled: true, grantedAt: Not(IsNull()) } }),
    );
    if (granted.length === 0) return;

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    for (const settings of granted) {
      // Belt-and-braces, and worth being honest about what it is not: `settings` is
      // the snapshot the `find` above produced under `grantedAt: Not(IsNull())` and
      // nothing re-reads it, so this cannot detect a grant cleared since -- a
      // comment here used to claim exactly that. What actually decides against the
      // committed row, and stops two replicas both emailing the owner, is the
      // conditional UPDATE inside `revokeAfterReturn`.
      if (settings.grantedAt === null) continue;
      try {
        const owner = await this.scoped(User, (repo) =>
          repo.findOne({ where: { id: settings.ownerUserId } }),
        );
        // No email requirement here, unlike the delivery sweep: a revocation is
        // owed to the account, not to an inbox.
        if (!owner || !owner.isActive) continue;
        const lastSeen = owner.lastActivityAt ?? owner.lastLogin;
        if (!lastSeen) continue;
        const daysSinceLogin = Math.floor(
          (Date.now() - lastSeen.getTime()) / MS_PER_DAY,
        );
        if (daysSinceLogin < settings.grantAfterDays) {
          await this.revokeAfterReturn(settings, owner, appUrl);
        }
      } catch (error) {
        this.logger.error(
          `Emergency access revocation failed for user ${settings.ownerUserId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
  }

  private async runDailyCheckWithinContext(): Promise<void> {
    const enabled = await this.scoped(EmergencyAccessSettings, (repo) =>
      repo.find({ where: { enabled: true } }),
    );
    if (enabled.length === 0) {
      this.logger.debug("No users with emergency access enabled");
      return;
    }

    this.logger.log(
      `Running emergency access check for ${enabled.length} user(s)`,
    );

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );

    let grants = 0;
    let reminders = 0;
    let skipped = 0;

    for (const settings of enabled) {
      try {
        const handled = await this.processOne(settings, appUrl);
        if (handled === "granted") grants += 1;
        else if (handled === "reminded") reminders += 1;
        else skipped += 1;
      } catch (error) {
        this.logger.error(
          `Emergency access processing failed for user ${settings.ownerUserId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    this.logger.log(
      `Emergency access check complete: ${grants} granted, ${reminders} reminded, ${skipped} skipped`,
    );
  }

  /**
   * The owner's contacts that have not yet been sent a link **for this grant
   * cycle**.
   *
   * The delivery record is what makes a resumed grant safe: a contact who already
   * received this cycle's link is never in the list, so a retry cannot re-issue
   * their token and kill the link in their inbox. Scoping it to `generation` is
   * what makes a *second* grant possible at all -- the predicate used to be
   * `claim_notified_at IS NULL`, which no path reset, so a contact was permanently
   * classified as notified and the safeguard fired at most once per row
   * (audit RRV4-004).
   *
   * The single place both halves of the pair are read, as `markContactNotified` is
   * the single place they are written.
   *
   * **Forward-only, exactly as the write is** (`LessThan`, not `Not`). The two
   * spellings of one predicate drifted, and the direction is what they disagreed
   * about: a contact whose generation is *greater* than this sweep's -- a resume
   * that ran long while a newer cycle was claimed and delivered -- read as "owed a
   * link" here while `markContactNotified` refused to acknowledge it. `credentialFor`
   * would then find a hash with no ciphertext (the newer cycle cleared it on
   * delivery), mint a replacement, and kill the link that newer cycle had just put
   * in the recipient's inbox -- the P4-014 dead-link outcome the generation exists
   * to end. A contact served by a newer cycle is not owed anything by an older one.
   */
  private contactsAwaitingNotice(
    ownerUserId: string,
    generation: number,
  ): Promise<EmergencyAccessContact[]> {
    return this.scoped(EmergencyAccessContact, (repo) =>
      repo.find({
        where: [
          { ownerUserId, notifiedGrantGeneration: IsNull() },
          { ownerUserId, notifiedGrantGeneration: LessThan(generation) },
        ],
        order: { createdAt: "ASC" },
      }),
    );
  }

  /** Does this owner have anyone to notify at all? Asked before a cycle opens. */
  private countContacts(ownerUserId: string): Promise<number> {
    return this.scoped(EmergencyAccessContact, (repo) =>
      repo.count({ where: { ownerUserId } }),
    );
  }

  /**
   * Issue a claim token to each contact still owed one and send their link.
   *
   * Returns how many were actually delivered. Each contact's
   * `claim_notified_at` is stamped only after its own `sendMail` resolved, so a
   * process killed part-way through leaves the rest owed and recoverable, and a
   * recipient who did get a link is never sent a second token.
   */
  private async notifyGrantContacts(
    settings: EmergencyAccessSettings,
    owner: GrantNoticeOwner,
    contacts: EmergencyAccessContact[],
    appUrl: string,
    now: number,
    generation: number,
  ): Promise<number> {
    const decryptedMessage = settings.messageCiphertext
      ? decryptMessage(this.encryption, this.logger, settings.messageCiphertext)
      : null;
    const ownerFullName =
      [owner.firstName, owner.lastName].filter(Boolean).join(" ") ||
      owner.email;

    let delivered = 0;
    for (const contact of contacts) {
      try {
        // Both halves together: the email states when the link stops working, so
        // it has to be rendered from the expiration the *database* will enforce,
        // not from a fresh `now + 30 days` the reused credential never received
        // (audit RRV4-005).
        const credential = await this.credentialFor(contact, new Date(now));
        // `null` means the row moved under this sweep -- revoked, claimed, or
        // delivered by another replica -- and nothing was written. Skip before the
        // send: the contact is not owed this cycle's link any more.
        if (!credential) continue;
        const { token: rawToken, expiresAt } = credential;

        const claimUrl = `${appUrl}/emergency-access/claim?token=${rawToken}`;
        // The contact may or may not be a Monize user; localize to their own
        // account language when they have one, otherwise fall back to default.
        const contactUser = await this.scoped(User, (repo) =>
          repo.findOne({
            where: { email: contact.email },
          }),
        );
        const lang = await withScopedDb(this.dataSource, (manager) =>
          resolveUserEmailLocale(
            manager.getRepository(UserPreference),
            contactUser?.id ?? null,
          ),
        );
        const t = emailTranslator(this.i18n, lang);
        const html = emergencyAccessGrantTemplate(
          {
            contactFirstName: contact.firstName,
            ownerFullName,
            message: decryptedMessage,
            claimUrl,
            expiresAt,
          },
          t,
        );
        await this.emailService.sendMail(
          contact.email,
          t(
            "emails.emergencyAccessGrant.subject",
            `You have been granted emergency access to ${ownerFullName}'s Monize account`,
            { owner: ownerFullName },
          ),
          html,
        );
        // The delivery record, written after the send and never before it, and it
        // clears the credential in the same statement: once delivery is
        // acknowledged there is nothing left to re-send, so the token must not
        // outlive it.
        await this.markContactNotified(contact.id, new Date(now), generation);
        delivered += 1;
      } catch (error) {
        this.logger.error(
          `Failed to issue emergency access grant for contact ${contact.id}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
    return delivered;
  }

  /**
   * Has this owner's reminder for `dayKey` already gone out?
   *
   * Read under the lease, from `last_reminder_sent_at` -- the record written
   * after a successful send. This, not the claim, is what enforces "at most one
   * per local day": a claim taken before the send says only that somebody
   * intended to send, and an intention does not survive the process holding it.
   */
  private async reminderAlreadySent(
    ownerUserId: string,
    dayKey: string,
  ): Promise<boolean> {
    const row = await this.scoped(EmergencyAccessSettings, (repo) =>
      repo.findOne({
        where: { ownerUserId },
        select: ["ownerUserId", "lastReminderSentAt"],
      }),
    );
    const sentAt = row?.lastReminderSentAt;
    return sentAt != null && todayKeyFrom(new Date(sentAt)) === dayKey;
  }

  /**
   * Hand the reminder lease back, addressed by the token this attempt holds.
   *
   * Not by `(type, owner, dayKey)` alone: that names the work rather than the
   * holder, so a stalled attempt could delete a lease another replica had already
   * retaken and leave the replica actually sending with no exclusion
   * (audit DR-RRV4-01).
   */
  private async releaseReminderLease(
    ownerUserId: string,
    dayKey: string,
    leaseToken: string,
  ): Promise<void> {
    await this.jobClaims
      .releaseLease(
        JobClaimType.EmergencyAccessReminder,
        ownerUserId,
        dayKey,
        leaseToken,
      )
      .catch(() => undefined);
  }

  /**
   * Hand the grant-notice lease back, addressed by the token this attempt holds,
   * for the reason {@link releaseReminderLease} gives. A failure here is not
   * worth failing the sweep over: the lease expires on its own.
   */
  private async releaseGrantNoticeLease(
    ownerUserId: string,
    dayKey: string,
    leaseToken: string,
  ): Promise<void> {
    await this.jobClaims
      .releaseLease(
        JobClaimType.EmergencyAccessGrantNotify,
        ownerUserId,
        dayKey,
        leaseToken,
      )
      .catch(() => undefined);
  }

  /**
   * The delivery record for one contact and one grant cycle.
   *
   * The generation is what removes the contact from `contactsAwaitingNotice`; the
   * timestamp is for operators. They are set in one statement so the pair cannot
   * disagree, and the credential is cleared with them -- once delivery is
   * acknowledged there is nothing left to re-send, so the token must not outlive
   * it.
   *
   * **Forward-only.** The generation only ever advances, so this is a
   * compare-and-set: a delayed acknowledgement from an older cycle -- a step-1b
   * resume that ran long while the owner re-armed and a newer cycle was already
   * delivered -- must not lower `notified_grant_generation` and re-open a contact
   * the newer cycle has served (audit DR-V4R3-01). The predicate makes the write a
   * no-op in that case; the send it followed is wasted, not harmful.
   */
  private async markContactNotified(
    contactId: string,
    at: Date,
    generation: number,
  ): Promise<void> {
    await this.scoped(EmergencyAccessContact, (repo) =>
      repo
        .createQueryBuilder()
        .update(EmergencyAccessContact)
        .set({
          claimNotifiedAt: at,
          notifiedGrantGeneration: generation,
          claimTokenCiphertext: null,
        })
        .where("id = :id", { id: contactId })
        .andWhere(
          "(notified_grant_generation IS NULL OR notified_grant_generation < :generation)",
          { generation },
        )
        .execute(),
    );
  }

  /**
   * The claim token to put in this contact's email: the one already issued if the
   * notice is still owed, a fresh one otherwise.
   *
   * This is what makes a retry safe. SMTP acceptance and the delivery record
   * cannot commit together, so a process killed between them leaves a contact who
   * may well be holding a working link while the row still says the notice is
   * owed. Minting a new token then overwrites the hash and kills the delivered
   * link -- and if this send fails too, the only link in their inbox no longer
   * works, during a recovery, indistinguishable from one the owner revoked
   * (audit RV4-004). So the credential is issued once and reused until delivery is
   * acknowledged, at which point `markContactNotified` clears it.
   *
   * A stored credential that cannot be decrypted -- the key was rotated, or the row
   * predates the column -- is the one case where the token does rotate. That is
   * logged, because re-issuing invalidates whatever was delivered before, and the
   * decision to prefer a link that works over one nobody can confirm should be
   * visible rather than inferred from an empty column.
   *
   * Reuse is also **expiration-aware**, and the returned expiration is the stored
   * one. Reusing a token while the caller rendered the email from a fresh
   * `now + 30 days` produced a delivery the system recorded as successful and the
   * claim endpoint refuses: a credential minted on day 0 and re-sent on day 31 is
   * already dead, and one re-sent on day 10 was described as valid for 21 days
   * longer than it is (audit RRV4-005). An expired stored token is worth nothing to
   * anyone, so rotating it destroys no working link -- which is exactly why this is
   * the one rotation that needs no warning.
   */
  private async credentialFor(
    contact: EmergencyAccessContact,
    now: Date,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const storedExpiresAt = contact.claimTokenExpiresAt;
    const storedIsLive =
      storedExpiresAt != null && storedExpiresAt.getTime() > now.getTime();
    if (
      contact.claimTokenCiphertext &&
      contact.claimTokenHash &&
      storedIsLive
    ) {
      try {
        const stored = this.encryption.decrypt(contact.claimTokenCiphertext);
        if (tokenHashesEqual(hashToken(stored), contact.claimTokenHash)) {
          // Re-send the same URL, with the expiration the database will enforce.
          // Nothing on the row changes, so a link already delivered keeps working
          // whatever happens to this attempt.
          return { token: stored, expiresAt: storedExpiresAt };
        }
        this.logger.error(
          `Stored emergency-access credential for contact ${contact.id} does not ` +
            `match its hash; issuing a new link, which invalidates any already delivered`,
        );
      } catch (error) {
        this.logger.error(
          `Could not read the stored emergency-access credential for contact ` +
            `${contact.id}; issuing a new link, which invalidates any already ` +
            `delivered: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (contact.claimTokenCiphertext && contact.claimTokenHash) {
      // Undelivered and already expired. Nobody is holding a link this replaces,
      // so a fresh credential is the only thing that can be delivered at all.
      this.logger.warn(
        `Emergency-access credential for contact ${contact.id} expired before it ` +
          `could be delivered${
            storedExpiresAt ? ` (${storedExpiresAt.toISOString()})` : ""
          }; issuing a new link`,
      );
    } else if (contact.claimTokenHash) {
      // A token was issued by a version that did not keep it, so it cannot be
      // re-sent. Replacing it is deliberate: a delivered link beats one nobody can
      // confirm, and asserting delivery instead would disarm the safeguard
      // permanently (audit RV4-003).
      this.logger.warn(
        `Emergency-access contact ${contact.id} has a token this version cannot ` +
          `re-send; issuing a new link, which invalidates any already delivered`,
      );
    }

    const rawToken = crypto.randomBytes(CLAIM_TOKEN_BYTES).toString("hex");
    const expiresAt = new Date(
      now.getTime() + CLAIM_TOKEN_TTL_DAYS * MS_PER_DAY,
    );
    // A targeted, conditional UPDATE -- not a save of the entity the sweep read,
    // for the reason `revokeAfterReturn` gives two methods down and one more this
    // one has to itself. `contact` is a snapshot, and the loop above it does a full
    // SMTP round trip per iteration, so by the time contact N is reached the row may
    // have been voided by an owner return, by a disable, or by the claim controller
    // handing the account to a sibling contact. `repo.save` would assert
    // `claim_token_used_at = NULL, claim_voided_reason = NULL` over whatever the row
    // now says and mint a working link into an account somebody else has already
    // taken over. So the state this decision was made from is a predicate: hash,
    // credential and void reason must all still be what was read. Zero rows means
    // another writer moved the row and this contact is skipped -- not an error, and
    // deliberately before the send rather than after it.
    //
    // `claim_token_used_at` is left out of the comparison on purpose: PostgreSQL
    // stores microseconds and the driver hands JavaScript milliseconds, so a
    // round-tripped timestamp never compares equal to itself. The three columns
    // below are exact-valued, and every void path writes at least one of them.
    const claimed = await this.scoped(EmergencyAccessContact, (repo) =>
      repo
        .createQueryBuilder()
        .update(EmergencyAccessContact)
        .set({
          claimTokenHash: hashToken(rawToken),
          claimTokenExpiresAt: expiresAt,
          claimTokenUsedAt: null,
          claimVoidedReason: null,
          // The credential and its hash commit together, before the send: a hash
          // with no recoverable token is exactly the state that forces a rotation
          // later.
          claimTokenCiphertext: this.encryption.encrypt(rawToken),
        })
        .where("id = :id", { id: contact.id })
        .andWhere("claim_token_hash IS NOT DISTINCT FROM :seenHash", {
          seenHash: contact.claimTokenHash,
        })
        .andWhere(
          "claim_token_ciphertext IS NOT DISTINCT FROM :seenCiphertext",
          { seenCiphertext: contact.claimTokenCiphertext },
        )
        .andWhere("claim_voided_reason IS NOT DISTINCT FROM :seenVoided", {
          seenVoided: contact.claimVoidedReason,
        })
        .execute(),
    );
    if (!claimed.affected) {
      this.logger.warn(
        `Emergency-access contact ${contact.id} changed while this sweep was ` +
          `delivering (revoked, claimed, or notified by another replica); no link ` +
          `was issued`,
      );
      return null;
    }
    return { token: rawToken, expiresAt };
  }

  private async processOne(
    settings: EmergencyAccessSettings,
    appUrl: string,
  ): Promise<"granted" | "reminded" | "skipped"> {
    const owner = await this.scoped(User, (repo) =>
      repo.findOne({
        where: { id: settings.ownerUserId },
      }),
    );
    if (!owner || !owner.isActive || !owner.email) return "skipped";
    // Captured here rather than read again where it is used: TypeScript discards
    // a narrowing of `owner.email` at the first `await` below, because the
    // property is declared nullable and a call could have changed it.
    const noticeOwner: GrantNoticeOwner = {
      firstName: owner.firstName,
      lastName: owner.lastName,
      email: owner.email,
    };
    // Prefer last_activity_at (touched by every authenticated request); fall
    // back to last_login for users who have not done anything since the
    // backfill migration.
    const lastSeen = owner.lastActivityAt ?? owner.lastLogin;
    if (!lastSeen) return "skipped";

    const now = Date.now();
    const daysSinceLogin = Math.floor((now - lastSeen.getTime()) / MS_PER_DAY);

    // Step 0: the owner is active again after a grant fired. Revoke the
    // outstanding (unclaimed) magic links, re-arm monitoring, and tell the
    // owner. Without this, a contact could take over a fully-active account
    // for the entire 30-day link lifetime after the owner returned.
    if (
      settings.grantedAt !== null &&
      daysSinceLogin < settings.grantAfterDays
    ) {
      await this.revokeAfterReturn(settings, owner, appUrl);
      return "skipped";
    }

    // Step 1: grant cascade (only if not already granted)
    if (
      settings.grantedAt === null &&
      daysSinceLogin >= settings.grantAfterDays
    ) {
      // Only "has this owner anyone to notify", not "who is owed a link": the
      // grant cycle this is about to open is one nobody has been notified for by
      // definition, and its number is not known until the claim below wins.
      if ((await this.countContacts(settings.ownerUserId)) === 0) {
        return "skipped";
      }

      // The delivery lease, taken BEFORE the grant claim below and held until the
      // sends are done. It is the same lease step 1b takes, keyed the same way, and
      // that sharing is the point.
      //
      // `claimGrant` decides which replica opens the cycle; it says nothing about
      // who may *send* for it once it is open. A replica whose sweep read this
      // owner's settings after the winner's claim committed saw `granted_at` set,
      // went to step 1b, found the same contacts still pending -- the winner had
      // not reached `markContactNotified` for them yet -- and took the lease
      // uncontested, because the winner never held it. `credentialFor` then
      // re-sent the stored credential, and a contact received the same
      // emergency-access link twice in the same minute. Holding the lease here
      // makes the two paths one critical section: whichever replica holds it is
      // the only one delivering this owner's grant today.
      //
      // Released when this attempt is finished, whatever it delivered, so a later
      // step-1b pass can resume a partial delivery without waiting out the lease;
      // the contacts already served are excluded by `contactsAwaitingNotice`'s
      // generation predicate, not by the lease. A replica killed while holding it
      // costs the lease window, not the notice.
      const leaseKey = todayKeyFrom(new Date(now));
      const lease = await this.jobClaims.claimLease(
        JobClaimType.EmergencyAccessGrantNotify,
        settings.ownerUserId,
        leaseKey,
        SEND_LEASE_MS,
      );
      if (!lease) return "skipped";

      try {
        // Claim the ungranted -> granted transition atomically, BEFORE generating a
        // single token.
        //
        // Every replica fires this cron and `grantedAt` was written only after the
        // emails went out, so two replicas could both see `grantedAt === null`,
        // both generate a fresh random token for the same contact, and both send.
        // Whichever token hash was stored last is the only valid one, so the other
        // delivered link is dead -- and the recipient of a dead emergency-access
        // link during a high-stakes recovery has no way to tell it from a revoked
        // one (audit P4-014). The loser now stands down before writing anything.
        const generation = await this.claimGrant(settings.ownerUserId);
        if (generation === null) {
          return "skipped";
        }

        const pending = await this.contactsAwaitingNotice(
          settings.ownerUserId,
          generation,
        );
        const delivered = await this.notifyGrantContacts(
          settings,
          noticeOwner,
          pending,
          appUrl,
          now,
          generation,
        );

        // Only keep the grant if at least one contact actually received a link.
        // Otherwise hand it back so the next run retries -- a transient SMTP
        // failure must not permanently disable the safeguard. That behaviour
        // predates the claim and has to survive it, which is what the release
        // below is for.
        //
        // A *partial* delivery keeps the grant and leaves the rest owed: the
        // contacts whose `notified_grant_generation` is still behind this cycle are
        // picked up by step 1b below, without re-issuing a token for anyone who
        // already holds a working link.
        if (delivered === 0) {
          this.logger.error(
            `Emergency access grant for user ${settings.ownerUserId} delivered no contact emails; releasing the grant claim for retry`,
          );
          await this.releaseGrant(settings.ownerUserId);
          return "skipped";
        }

        return "granted";
      } finally {
        // Last, after any `releaseGrant` above: handing the lease back first would
        // open a window in which step 1b could resume a cycle this attempt is
        // about to hand back.
        await this.releaseGrantNoticeLease(
          settings.ownerUserId,
          leaseKey,
          lease,
        );
      }
    }

    // Step 1b: a grant that was claimed but never delivered.
    //
    // `granted_at` used to be the claim *and* the grant state, so a replica
    // killed between the conditional transition and the emails left an account
    // permanently marked granted with no contact holding a link -- the safeguard
    // silently disarmed at the moment it was supposed to fire, and step 1's
    // `granted_at IS NULL` predicate meant nothing would ever look again
    // (audit FV4-004).
    //
    // The recovery is derived rather than scheduled: a contact of a granted owner
    // not yet notified for the *current* grant cycle is a link still owed, whatever
    // caused it -- a crash, an SMTP failure that only some recipients hit, or a
    // contact the owner added after the grant fired. Nothing has to remember to
    // enqueue a retry, which is the property that makes it hold (docs/cron-jobs.md).
    if (
      settings.grantedAt !== null &&
      daysSinceLogin >= settings.grantAfterDays
    ) {
      // Read fresh, and never advanced here: this is finishing the cycle step 1
      // opened, and the sweep's snapshot predates the claim that opened it.
      const generation = await this.currentGrantGeneration(
        settings.ownerUserId,
      );
      if (generation === null) return "skipped";
      const pending = await this.contactsAwaitingNotice(
        settings.ownerUserId,
        generation,
      );
      if (pending.length === 0) return "skipped";

      // A lease, so two replicas do not both resume the same grant, and a replica
      // killed while resuming does not block tomorrow's attempt. The same lease
      // step 1 holds while it delivers, so a resume cannot start under a first
      // delivery that is still sending.
      const lease = await this.jobClaims.claimLease(
        JobClaimType.EmergencyAccessGrantNotify,
        settings.ownerUserId,
        todayKeyFrom(new Date(now)),
        SEND_LEASE_MS,
      );
      if (!lease) return "skipped";

      this.logger.warn(
        `Emergency access grant for user ${settings.ownerUserId} has ${pending.length} contact(s) still owed a link; resuming delivery`,
      );
      const delivered = await this.notifyGrantContacts(
        settings,
        noticeOwner,
        pending,
        appUrl,
        now,
        generation,
      );
      return delivered > 0 ? "granted" : "skipped";
    }

    // Step 2: reminder cascade (only if not already granted, at most once per day)
    if (
      settings.grantedAt === null &&
      daysSinceLogin >= settings.reminderAfterDays
    ) {
      // Two separate jobs, and they must not be confused for one:
      //
      // - The **lease** stops two replicas sending at the same moment. It was a
      //   permanent `claimOnce`, which also made it the delivery record -- so a
      //   replica killed between the claim and the send consumed the day and sent
      //   nothing, and only a *handled* SMTP error released it. A lease expires,
      //   so a dead replica costs the retry window rather than the notice
      //   (audit FV4-005).
      // - The **delivery record** is `last_reminder_sent_at`, moved only after a
      //   send succeeds. Re-read here, under the lease, because that is what
      //   makes "at most once per local day" true across a process death: a claim
      //   answers "may I send now", not "has this been sent".
      const reminderKey = todayKeyFrom(new Date(now));
      const reminderLease = await this.jobClaims.claimLease(
        JobClaimType.EmergencyAccessReminder,
        settings.ownerUserId,
        reminderKey,
        SEND_LEASE_MS,
      );
      if (!reminderLease) {
        return "skipped";
      }
      if (await this.reminderAlreadySent(settings.ownerUserId, reminderKey)) {
        await this.releaseReminderLease(
          settings.ownerUserId,
          reminderKey,
          reminderLease,
        );
        return "skipped";
      }

      const contacts = await this.scoped(EmergencyAccessContact, (repo) =>
        repo.find({
          where: {
            ownerUserId: settings.ownerUserId,
            claimTokenUsedAt: IsNull(),
          },
        }),
      );
      const daysUntilGrant = Math.max(
        0,
        settings.grantAfterDays - daysSinceLogin,
      );
      const reminderLang = await withScopedDb(this.dataSource, (manager) =>
        resolveUserEmailLocale(
          manager.getRepository(UserPreference),
          settings.ownerUserId,
        ),
      );
      const reminderT = emailTranslator(this.i18n, reminderLang);
      const html = emergencyAccessReminderTemplate(
        {
          ownerFirstName: owner.firstName || "",
          daysSinceLogin,
          daysUntilGrant,
          contacts: contacts.map((c) => ({
            firstName: c.firstName,
            email: c.email,
          })),
          appUrl,
        },
        reminderT,
      );
      try {
        await this.emailService.sendMail(
          owner.email,
          daysSinceLogin === 1
            ? reminderT(
                "emails.emergencyAccessReminder.subjectOne",
                "Monize: your account has been inactive for 1 day",
              )
            : reminderT(
                "emails.emergencyAccessReminder.subjectMany",
                `Monize: your account has been inactive for ${daysSinceLogin} days`,
                { daysSinceLogin },
              ),
          html,
        );
      } catch (error) {
        // Hand the lease back so the next run can retry immediately rather than
        // waiting it out. Nothing was delivered, so the delivery record below is
        // deliberately not written -- that is what keeps the notice owed.
        await this.releaseReminderLease(
          settings.ownerUserId,
          reminderKey,
          reminderLease,
        );
        throw error;
      }

      // The delivery record. Targeted UPDATE, not a save of the entity read at
      // the top of the sweep: that snapshot would write back every other column
      // too, so an owner disabling the feature mid-sweep would find it silently
      // re-enabled.
      await this.scoped(EmergencyAccessSettings, (repo) =>
        repo
          .createQueryBuilder()
          .update(EmergencyAccessSettings)
          .set({ lastReminderSentAt: new Date(now) })
          .where("owner_user_id = :id", { id: settings.ownerUserId })
          .execute(),
      );
      await this.releaseReminderLease(
        settings.ownerUserId,
        reminderKey,
        reminderLease,
      );
      return "reminded";
    }

    return "skipped";
  }

  /**
   * The owner signed back in after a grant had fired. Void every outstanding
   * (unclaimed) magic link, clear the grant marker so monitoring re-arms, and
   * notify the owner that access had been granted in their absence.
   *
   * "Re-arms" is a claim about the *next* grant, so it has to hold for the
   * per-contact delivery state too, not only for `granted_at`. It does, and
   * without this method saying anything about it: the next grant advances
   * `grant_generation`, which is what makes every contact owed a link again
   * (audit RRV4-004). This method's own contract is therefore only "void what is
   * outstanding and clear the owner-level markers".
   */
  private async revokeAfterReturn(
    settings: EmergencyAccessSettings,
    owner: User,
    appUrl: string,
  ): Promise<void> {
    const result = await this.scoped(EmergencyAccessContact, (repo) =>
      repo
        .createQueryBuilder()
        .update(EmergencyAccessContact)
        .set({
          claimTokenHash: null,
          claimTokenExpiresAt: null,
          claimTokenUsedAt: () => "CURRENT_TIMESTAMP",
          claimVoidedReason: "owner_returned",
          // The credential goes with the hash that made it usable. It is already
          // worthless without one, but it is still a recoverable secret under the
          // application key, and nothing will ever want it again (DR-RRV4-03).
          claimTokenCiphertext: null,
        })
        .where("owner_user_id = :userId", { userId: settings.ownerUserId })
        .andWhere("claim_token_hash IS NOT NULL")
        .andWhere("claim_token_used_at IS NULL")
        .execute(),
    );

    // Targeted UPDATE for the same reason as above: re-saving the sweep's
    // snapshot would revert any other setting the owner changed meanwhile.
    //
    // And *conditional*, which is what decides who sends the notice below. Unlike
    // the grant and the reminder, this sweep takes no `JobClaimService` lease -- it
    // runs ahead of both delivery gates so a degraded install can still kill a
    // delivered link, and a lease is a delivery concern. The voiding above is
    // idempotent, so every replica running the 9am cron converged on the same rows;
    // the email is not, and the owner received one copy per replica. `granted_at IS
    // NOT NULL` makes exactly one caller the winner, which is the same
    // compare-and-set shape `claimGrant` and the claim endpoint use, at no extra
    // cost and with no new claim type.
    const claimedRevocation = await this.scoped(
      EmergencyAccessSettings,
      (repo) =>
        repo
          .createQueryBuilder()
          .update(EmergencyAccessSettings)
          .set({ grantedAt: null, lastReminderSentAt: null })
          .where("owner_user_id = :id", { id: settings.ownerUserId })
          .andWhere("granted_at IS NOT NULL")
          .execute(),
    );
    if (!claimedRevocation.affected) return;

    this.logger.warn(
      `Owner ${settings.ownerUserId} active again after a grant; voided ${
        result.affected ?? 0
      } outstanding emergency-access link(s) and re-armed monitoring`,
    );

    if (!owner.email) return;
    try {
      const revokedLang = await withScopedDb(this.dataSource, (manager) =>
        resolveUserEmailLocale(
          manager.getRepository(UserPreference),
          settings.ownerUserId,
        ),
      );
      const revokedT = emailTranslator(this.i18n, revokedLang);
      const html = emergencyAccessGrantRevokedTemplate(
        {
          ownerFirstName: owner.firstName || "",
          appUrl,
        },
        revokedT,
      );
      await this.emailService.sendMail(
        owner.email,
        revokedT(
          "emails.emergencyAccessGrantRevoked.subject",
          "Monize: emergency access was granted while you were away",
        ),
        html,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send emergency-access revocation notice to owner ${settings.ownerUserId}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }
}

/** `YYYY-MM-DD` in server-local time -- the reminder claim's daily key. */
function todayKeyFrom(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
