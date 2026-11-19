import type {
  KmyAmount,
  KmyPayee,
  KmyReconciliation,
  KmySplit,
  KmyTemplateSplit,
} from "../model/kmy-raw";
import type { Rational } from "../model/kmy-rational";
import type { KmyAttributes } from "./kmy-xml-tokenize";

/** The mutable shapes the collector fills while an element is open. */

// ---------------------------------------------------------------------------
// Builders

export type PayeeBuilder = {
  -readonly [K in keyof KmyPayee]: KmyPayee[K];
};

export interface InstitutionBuilder {
  ordinal: number;
  id: string;
  name: string;
  accountIds: string[];
}

export interface AccountBuilder {
  ordinal: number;
  id: string;
  parentId: string | null;
  name: string;
  type: number;
  currency: string | null;
  institutionId: string | null;
  opened: string | null;
  lastReconciled: string | null;
  number: string;
  description: string;
  subaccountIds: string[];
  reconciliations: KmyReconciliation[];
  kvp: Map<string, string>;
  hasOnlineBanking: boolean;
}

export interface SplitBuilder {
  account: string;
  payee: string | null;
  value: KmyAmount;
  shares: KmyAmount;
  price: Rational;
  action: string;
  reconcileFlag: number;
  reconcileDate: string | null;
  memo: string;
  number: string;
  bankId: string;
  costCenter: string | null;
  tags: string[];
  hasMatchedTransaction: boolean;
}

export interface TransactionBuilder {
  ordinal: number;
  id: string;
  postDate: string | null;
  memo: string;
  commodity: string | null;
  splits: KmySplit[];
  kvp: Map<string, string>;
}

export interface TemplateBuilder {
  postDate: string | null;
  memo: string;
  commodity: string | null;
  splits: KmyTemplateSplit[];
}

export interface ScheduleBuilder {
  ordinal: number;
  attributes: KmyAttributes;
  payments: string[];
  template: TemplateBuilder | null;
}

export interface SecurityBuilder {
  ordinal: number;
  attributes: KmyAttributes;
  kvp: Map<string, string>;
}
