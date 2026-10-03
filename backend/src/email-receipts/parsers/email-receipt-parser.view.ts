import type {
  EmailReceiptParser,
  EmailReceiptParserSource,
  EmailReceiptParserStatus,
} from "../entities/email-receipt-parser.entity";
import {
  validateReceiptParserDefinition,
  type ReceiptParserValidationError,
} from "../parsing/receipt-parser.validation";

/**
 * A parser as a client sees it. `definitionValid` and `definitionErrors` are
 * computed on every read: a definition restored from a support backup can be the
 * column default `{}`, which is reported as invalid, never a crash.
 */
export interface EmailReceiptParserView {
  id: string;
  name: string;
  payeeId: string | null;
  fromDomains: string[];
  subjectContains: string[];
  definition: Record<string, unknown>;
  definitionValid: boolean;
  definitionErrors: ReceiptParserValidationError[];
  status: EmailReceiptParserStatus;
  source: EmailReceiptParserSource;
  approvedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** The view of a stored row, field by field so a new column is not shown by accident. */
export function toParserView(row: EmailReceiptParser): EmailReceiptParserView {
  const validation = validateReceiptParserDefinition(row.definition);
  return {
    id: row.id,
    name: row.name,
    payeeId: row.payeeId,
    fromDomains: row.fromDomains,
    subjectContains: row.subjectContains,
    definition: row.definition,
    definitionValid: validation.ok,
    definitionErrors: validation.ok ? [] : validation.errors,
    status: row.status,
    source: row.source,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
