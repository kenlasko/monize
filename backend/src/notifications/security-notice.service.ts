import { Injectable, Logger } from "@nestjs/common";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { boundCodePoints, displayClientName } from "../oauth/client-identity";

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

/** Longest destination origin stored on a notice, in code points. */
const DESTINATION_MAX = 300;

export function oauthClientAuthorizedNotice(facts: {
  grantId: string;
  clientId: string;
  clientName: string;
  /** Where the client's authorizations go (`describeRedirectTarget`), or null. */
  destination: string | null;
}): CreateNotificationInput {
  // The name is chosen by whoever registered the client: cleaned and bounded
  // here, escaped wherever it is rendered. The destination is the one fact the
  // server can vouch for (GHSA-vmgq-326p-fprx), so the notice leads with it.
  const clientName = displayClientName(facts.clientName, facts.clientId);
  const destination = facts.destination
    ? boundCodePoints(facts.destination, DESTINATION_MAX)
    : "an unknown address";
  return {
    type: NotificationType.OAUTH_CLIENT_AUTHORIZED,
    severity: NotificationSeverity.WARNING,
    title: "New app connected to your Monize account",
    message:
      `An application calling itself ${clientName} was granted access, and its authorizations go to ${destination}. ` +
      "If this wasn't you, revoke it in Settings under Connected Apps.",
    data: facts.destination
      ? { clientId: facts.clientId, clientName, destination }
      : { clientId: facts.clientId, clientName },
    target: "/settings#connected-apps",
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
    facts: {
      grantId: string;
      clientId: string;
      clientName: string;
      destination: string | null;
    },
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
