import type { DocsLink } from '@/lib/docs-links';

/**
 * Where the guide explains a KMyMoney import failure, by the error code the
 * backend reports. Every `kmy*` code, and the job keys a KMyMoney import shares
 * with the Money one, answer from the KMyMoney troubleshooting table; kept as a
 * map so a future error that needs its own section only adds an entry here.
 */
const KMY_ERROR_DOCS_LINKS: Record<string, DocsLink> = {
  kmyNoFile: 'importKmyTroubleshooting',
  kmyFileTooLarge: 'importKmyTroubleshooting',
  kmyXmlTooLarge: 'importKmyTroubleshooting',
  kmyTooManyRecords: 'importKmyTroubleshooting',
  kmyMappingFailed: 'importKmyTroubleshooting',
  kmyNotAKmyMoneyFile: 'importKmyTroubleshooting',
  kmyEncryptedFile: 'importKmyTroubleshooting',
  kmySqliteDatabase: 'importKmyTroubleshooting',
  kmyAnonymizedFile: 'importKmyTroubleshooting',
  kmyLegacyBinaryFile: 'importKmyTroubleshooting',
  kmyCorruptFile: 'importKmyTroubleshooting',
  kmyStagedFileMissing: 'importKmyTroubleshooting',
  kmyStagedFileInUse: 'importKmyTroubleshooting',
  kmyExistingAccountClosed: 'importKmyTroubleshooting',
  kmyExistingAccountCurrency: 'importKmyTroubleshooting',
  mnyImportFailed: 'importKmyTroubleshooting',
  mnyJobStalled: 'importKmyTroubleshooting',
  mnyJobStalledAfterCommit: 'importKmyTroubleshooting',
  mnyImportFailedAfterCommit: 'importKmyTroubleshooting',
  mnyAlreadyImported: 'importKmyTroubleshooting',
  mnyStagedFileMissing: 'importKmyTroubleshooting',
};

/** The guide section for a KMyMoney import error, or the troubleshooting table when the code is unknown. */
export function kmyErrorDocsLink(code: string | null | undefined): DocsLink {
  return (code && KMY_ERROR_DOCS_LINKS[code]) || 'importKmyTroubleshooting';
}
