export interface Tag {
  id: string;
  userId: string;
  name: string;
  color: string | null;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * How a tag has been used on non-void transactions (and their splits): the
 * latest transaction date (YYYY-MM-DD) and the number of links. Keyed by tag
 * id; a tag that was never used is absent.
 */
export interface TagUsage {
  lastUsed: string;
  count: number;
}

export type TagUsageMap = Record<string, TagUsage>;

/** Every place deleting a tag removes it from, counted per kind. */
export interface TagDeleteImpact {
  transactions: number;
  transactionSplits: number;
  scheduledTransactions: number;
  scheduledSplits: number;
  securities: number;
  rules: number;
  customReports: number;
}

export interface CreateTagData {
  name: string;
  color?: string;
  icon?: string;
}

export interface UpdateTagData extends Partial<CreateTagData> {}
