import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";

const messages = {
  financeSplit:
    "Choose positive portions from this transaction's category splits. Their total must match the shared bank amount; transfer and investment splits cannot be shared.",
  ownershipConsent:
    "The selected member must accept this ownership request first. Refresh the group to check their response.",
  financePaymentSum:
    "Allocate your entire contribution across the selected bank payments in the expense currency. Each payment must be positive and each bank movement can be used once.",
  groupNotEmpty:
    "Only an empty group can be deleted. Keep its entries, documents and personal bookings by archiving it instead.",
  documentLimit:
    "This destination has reached its document limit. Choose another expense or remove an unused document first.",
  reminderRecipient:
    "Choose another connected participant in an active group to send a reminder.",
  reminderTooSoon:
    "This participant has already been reminded today. Try again after 24 hours.",
  transferBeforeErasure:
    "Transfer ownership of your collaborative groups before deleting or downgrading this account.",
  notFound:
    "This group or entry is unavailable. Check your invitation or ask the group owner for access.",
  readOnly: "You do not have permission to make this change.",
  archived: "Restore the archived group before making changes.",
  stale:
    "This item changed while you were editing. Reload it and review the latest version.",
  retryChanged:
    "This request was already used with different data. Start a new operation.",
  participant: "Choose active participants from this group.",
  participantLimit: "A group can have up to 50 participants.",
  currencyLocked:
    "The group currency is fixed after the first entry. Create a new group to use another currency.",
  currency: "Choose an available currency with up to four decimal places.",
  invite:
    "This invitation is unavailable, expired or already used. Ask the group owner for a new one.",
  inviteEmail:
    "Sign in with the invited email address and verify it before joining.",
  alreadyMember:
    "You or this participant already belong to this group. Ask the owner to check the participants.",
  owner:
    "Transfer ownership to a connected participant before leaving this group.",
  refunded:
    "This expense has refunds. Reverse its refunds before changing or reversing the expense.",
  refundSource:
    "Choose a posted expense in this group and use its original currency for the refund.",
  repayment:
    "Choose two different participants and a positive repayment amount.",
  unknownBalance:
    "Resolve the entries with missing rates before recording a repayment.",
  repaymentChanged:
    "Balances changed. Review the current settlement suggestions before saving.",
  payee: "Choose a payee from your own finances.",
  financeDisabled:
    "Enable this group's personal finance integration before booking entries.",
  financeDraft:
    "Resolve this draft before including it in your finances. You can unlink an older booking separately.",
  financeCategory:
    "Choose your own category for your share, the private remainder and any exchange difference.",
  financeBank: "Choose an available bank or cash account that you own.",
  financeMatch:
    "Choose an ordinary, unreconciled bank movement that is not already linked to another shared expense.",
  financeAmount:
    "The shared portion must fit the bank movement and have the same payment direction.",
  financeReconciled:
    "This booking contains reconciled transactions. Remove their reconciliation before reviewing or unlinking it.",
  financePreview:
    "The group or bank movement changed. Refresh the preview before accepting this booking.",
  financeRate:
    "The {from}/{to} rate for {date} is unavailable. Enter the agreed bank exchange rate under Advanced, or retry the preview to fetch it.",
  financeConnected:
    "Only your own claimed participant can be included in your finances.",
} as const;
export type SharedError = keyof typeof messages;
export function sharedError(
  key: SharedError,
  args?: Record<string, string | number>,
): never {
  const fallback = messages[key].replace(
    /\{(\w+)\}/g,
    (placeholder, name: string) => String(args?.[name] ?? placeholder),
  );
  const message = tr(`sharedExpenses.${key}`, fallback, args);
  if (key === "notFound") throw new NotFoundException(message);
  if (key === "readOnly") throw new ForbiddenException(message);
  if (
    ["stale", "retryChanged", "repaymentChanged", "alreadyMember"].includes(key)
  )
    throw new ConflictException(message);
  throw new BadRequestException(message);
}
