import type { Logger } from "@nestjs/common";
import { resolvePositiveInt } from "../../common/env-number.util";

/**
 * Operator-owned limits on one mailbox poll (docs/future-plans/email-receipts.md
 * section 8). Declared in a table beside the `.env.example` documentation the
 * companion spec compares it with, like `notifications/reminder-cron-limits.ts`.
 */
export const EMAIL_RECEIPT_POLL_LIMIT_SPECS = {
  maxMessages: {
    envVar: "EMAIL_RECEIPTS_MAX_MESSAGES_PER_POLL",
    default: 50,
    max: 500,
    description: "messages read from one mailbox per poll",
  },
  maxMessageBytes: {
    envVar: "EMAIL_RECEIPTS_MAX_MESSAGE_BYTES",
    default: 2_000_000,
    max: 20_000_000,
    description:
      "bytes of one message; a larger one is skipped, never downloaded",
  },
} as const;

type LimitKey = keyof typeof EMAIL_RECEIPT_POLL_LIMIT_SPECS;
export type EmailReceiptPollLimits = Readonly<Record<LimitKey, number>>;

export function resolveEmailReceiptPollLimits(
  env: Record<string, unknown>,
  logger: Pick<Logger, "warn">,
): EmailReceiptPollLimits {
  const entries = Object.entries(EMAIL_RECEIPT_POLL_LIMIT_SPECS).map(
    ([key, spec]) => {
      const resolved = resolvePositiveInt(env[spec.envVar], spec.default);
      if (resolved.invalid || resolved.value > spec.max) {
        logger.warn(
          `${spec.envVar} must be an integer from 1 to ${spec.max}; using ${spec.default} (${spec.description})`,
        );
        return [key, spec.default];
      }
      return [key, resolved.value];
    },
  );
  return Object.fromEntries(entries) as EmailReceiptPollLimits;
}
