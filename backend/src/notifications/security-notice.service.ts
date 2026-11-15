import { Injectable, Logger } from "@nestjs/common";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "./notification-dispatch.service";

/**
 * Security notices (`docs/specs/security-notifications.md`): somebody new can
 * reach the account. "First time" is the unique `(user_id, dedupe_key)` index
 * behind `NotificationService.create`: a repeat writes nothing, so it also sends
 * nothing. OAuth keys are per grant; the relay key is per credential and its
 * `relay:cred:` prefix is kept by the purge (`STATE_KEYED_DEDUPE_PREFIXES`).
 *
 * `target` is written inline in each builder: the frontend's
 * `notification-target.contract.test.ts` reads it out of the source.
 */

const CLIENT_NAME_MAX = 100;

// Control (\p{Cc}: line breaks), format (\p{Cf}: bidi overrides U+202A-202E,
// isolates U+2066-2069, marks U+200E/F, zero-width) and line/paragraph
// separator characters (\p{Zl}, \p{Zp}: U+2028/U+2029) could spoof the title,
// subject and push text.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** At most `max` code points: a UTF-16 slice can split a surrogate pair, and
 * PostgreSQL's jsonb rejects the lone half, which would drop the notice. */
function boundCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

export function oauthClientAuthorizedNotice(facts: {
  grantId: string;
  clientId: string;
  clientName: string;
}): CreateNotificationInput {
  // The name is chosen by whoever registered the client: cleaned and bounded
  // here, escaped wherever it is rendered.
  const clientName =
    boundCodePoints(
      facts.clientName.replace(UNSAFE_NAME_CHARS, " ").trim(),
      CLIENT_NAME_MAX,
    ) || boundCodePoints(facts.clientId, CLIENT_NAME_MAX);
  return {
    type: NotificationType.OAUTH_CLIENT_AUTHORIZED,
    severity: NotificationSeverity.WARNING,
    title: `New app connected: ${clientName}`,
    message:
      `The application ${clientName} was just granted access to your Monize account. ` +
      "If this wasn't you, change your password now: that revokes every connected application's access.",
    data: { clientId: facts.clientId, clientName },
    target: "/settings",
    dedupeKey: `oauth:grant:${facts.grantId}`,
  };
}

export function relayCredentialFirstUseNotice(
  credentialId: string,
): CreateNotificationInput {
  // `pat:<id>` or `oauth:<id>`: only the kind is stored, never the credential id.
  const credentialKind = credentialId.split(":")[0];
  return {
    type: NotificationType.RELAY_CREDENTIAL_FIRST_USE,
    severity: NotificationSeverity.WARNING,
    title: "A new connection answered your AI chat",
    message:
      "A connection that has not answered your Monize AI chat before just picked up a prompt. " +
      "If you did not connect this assistant, change your password.",
    data: { credentialKind },
    target: "/settings",
    dedupeKey: `relay:cred:${credentialId}`,
  };
}

@Injectable()
export class SecurityNoticeService {
  private readonly logger = new Logger(SecurityNoticeService.name);

  constructor(private readonly dispatch: NotificationDispatchService) {}

  /** A new grant was saved. Never throws: a failed notice must not break consent. */
  async oauthClientAuthorized(
    userId: string,
    facts: { grantId: string; clientId: string; clientName: string },
  ): Promise<void> {
    await this.send(userId, oauthClientAuthorizedNotice(facts));
  }

  /** A credential claimed a relay prompt. Never throws; a repeat is a no-op. */
  async relayCredentialFirstUse(
    userId: string,
    credentialId: string,
  ): Promise<void> {
    await this.send(userId, relayCredentialFirstUseNotice(credentialId));
  }

  private async send(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<void> {
    try {
      // `null` is the normal "already notified" answer.
      await this.dispatch.notify(userId, input, { fanOut: "detached" });
    } catch (error) {
      this.logger.error(
        `Security notice ${input.type} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
