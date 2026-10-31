/** Decimal strings preserve the journal's accepted allocations across edits. */
export type SharedRole = "OWNER" | "EDITOR" | "VIEWER";
export type SharedEntryType = "EXPENSE" | "REFUND" | "INCOME" | "REPAYMENT";
export type SharedSplitMode = "EQUAL" | "EXACT" | "PERCENT" | "WEIGHT";
export interface SharedParticipant {
  id: string;
  name: string;
  isActive: boolean;
  connected: boolean;
  role: SharedRole | null;
}
export interface SharedPosition {
  participantId: string;
  balance: string | null;
  knownBalance: string;
  paid: string | null;
  cost: string | null;
  income: string | null;
  incomeReceived: string | null;
  sent: string | null;
  received: string | null;
}
export interface SharedSuggestion {
  fromParticipantId: string;
  toParticipantId: string;
  amount: string;
}
export interface SharedGroup {
  ownershipTransfer?: {
    requestId: string;
    participantId: string;
    accepted: boolean;
  } | null;
  splitTemplate?: {
    mode: "EQUAL" | "PERCENT" | "WEIGHT";
    shares: { participantId: string; value?: string }[];
  } | null;
  muted?: boolean;
  isDetachedCopy?: boolean;
  id: string;
  name: string;
  description: string | null;
  currencyCode: string;
  decimalPlaces: number;
  revision: number;
  financialRevision: number;
  archivedAt: string | null;
  role: SharedRole;
  myParticipantId: string | null;
  participantCount: number;
  myPosition: SharedPosition | null;
  settlementReady: boolean;
}
export interface SharedAllocation {
  entryId: string;
  participantId: string;
  kind: "SHARE" | "CONTRIBUTION";
  originalAmount: string;
  groupAmount: string | null;
  instructionValue: string | null;
}
export interface SharedEntry {
  ownEffect?: SharedPersonalEffect | null;
  id: string;
  groupId: string;
  type: SharedEntryType;
  state: "POSTED" | "DRAFT" | "REVERSED";
  draftReason: "FUTURE_DATE" | "MISSING_RATE" | null;
  title: string;
  note: string | null;
  categoryLabel: string | null;
  date: string;
  originalAmount: string;
  currencyCode: string;
  groupAmount: string | null;
  fxRate: string | null;
  fxRateDate: string | null;
  fxSource: string | null;
  splitMode: SharedSplitMode;
  revision: number;
  financialRevision: number;
  sourceEntryId: string | null;
  fromParticipantId: string | null;
  toParticipantId: string | null;
  allocations: SharedAllocation[];
  canEdit: boolean;
  previewFingerprint?: string;
}
export interface SharedGroupDetail extends SharedGroup {
  unresolvedEntries?: {
    id: string;
    title: string;
    date: string;
    currencyCode: string;
  }[];
  participants: SharedParticipant[];
  entries: SharedEntry[];
  entryCount: number;
  nextOffset: number | null;
  balances: {
    positions: SharedPosition[];
    settlementReady: boolean;
    totalExpenses: string | null;
    totalIncome: string | null;
    knownExpenses: string;
    knownIncome: string;
    suggestions: SharedSuggestion[];
  };
  activity: {
    id: string;
    actorName: string;
    action: string;
    entryId: string | null;
    detail: Record<string, unknown>;
    createdAt: string;
  }[];
}
export interface SharedCommand {
  operationId: string;
  expectedRevision: number;
}
export interface SharedEntryInput extends SharedCommand {
  previewFingerprint?: string;
  type: SharedEntryType;
  title: string;
  amount: string;
  currencyCode: string;
  date: string;
  note?: string;
  categoryLabel?: string;
  splitMode: SharedSplitMode;
  shares: { participantId: string; value?: string }[];
  contributions: { participantId: string; value?: string }[];
  fxRate?: string;
  sourceEntryId?: string;
  fromParticipantId?: string;
  toParticipantId?: string;
  expectedGroupRevision?: number;
  acknowledgeOverpayment?: boolean;
}
export interface SharedPerson {
  id: string;
  name: string;
  payeeId: string | null;
  groups: {
    groupId: string;
    groupName: string;
    currencyCode: string;
    participantId: string;
    position: SharedPosition;
  }[];
}
export interface SharedPersonalEffect {
  cash: string;
  originalCash: string;
  personal: string;
  position: string;
  originalCurrency: string;
}
export interface SharedBankPaymentInput {
  sourceSplits?: { splitId: string; amount: string }[];
  contributionAmount?: string;
  bankAccountId?: string;
  bankTransactionId?: string;
  bankAmount?: string;
  sharedBankAmount?: string;
  bankRate?: string;
  privateCategoryId?: string;
  fxCategoryId?: string;
}
export interface SharedOriginalBank {
  id: string;
  isSplit: boolean;
  splits?: {
    id: string;
    amount: string;
    categoryId: string | null;
    memo: string | null;
  }[];
}
export interface SharedFinanceInput
  extends SharedCommand, SharedBankPaymentInput {
  payments?: SharedBankPaymentInput[];
  categoryId?: string;
  payeeId?: string;
  previewFingerprint?: string;
}
export interface SharedFinanceOverview {
  accessRevoked?: boolean;
  integration: {
    id: string;
    accountId: string;
    currencyCode: string;
    participantId: string;
  } | null;
  pendingCount: number;
  entries: {
    entryId: string;
    title: string;
    date: string;
    type: SharedEntryType;
    state: SharedEntry["state"];
    revision: number;
    effect: SharedPersonalEffect | null;
    needsReview: boolean;
    reviewReason?: "CHANGED" | "NOT_BOOKED" | "MISSING_RATE" | null;
    posting: {
      id: string;
      acceptedRevision: number;
      snapshot: { effect: SharedPersonalEffect; input: SharedFinanceInput };
      originalBanks?: SharedOriginalBank[];
    } | null;
  }[];
}
export interface SharedFinancePreview {
  commitFingerprint?: string;
  payments?: {
    cash: string;
    originalCash: string;
    bankCurrency: string;
    bankAccountId: string;
    sourceTransactionId: string | null;
    breakdown: NonNullable<SharedFinancePreview["breakdown"]>;
  }[];
  fingerprint: string;
  effect: SharedPersonalEffect;
  previous: SharedPersonalEffect | null;
  bankCurrency: string | null;
  settlementCurrency: string;
  sourceTransactionId: string | null;
  breakdown: {
    bankTotal: string;
    sharedPortion: string;
    agreedPortion: string;
    privateRemainder: string;
    fxDifference: string;
  } | null;
}

export interface SharedEntryFinanceInput extends SharedCommand {
  entryId?: string;
  entry: SharedEntryInput;
  finance: SharedFinanceInput;
  previewFingerprint?: string;
}

export interface SharedReviewSummary {
  ledgerBasis: "ACCEPTED_SHARED_POSTINGS";
  pendingCount: number;
  unavailableGroupCount: number;
  groups: { groupId: string; accountId: string; accountName: string; pendingCount: number; accessRevoked: boolean }[];
  reviewUrl: string;
  checkedAt: string;
}
