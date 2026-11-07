import type { DocsLink } from '@/lib/docs-links';

/**
 * Where the guide explains a Money import failure, by the error key the
 * backend reports (`mnyErrors.*` in `import.json`). Every key currently
 * answers from the same troubleshooting table, but kept as a map -- rather
 * than one constant -- so a future error that needs its own section only
 * adds an entry here, the one place an error code is chosen a link.
 */
const MNY_ERROR_DOCS_LINKS: Record<string, DocsLink> = {
  mnyImportFailed: 'importMnyTroubleshooting',
  mnyJobStalled: 'importMnyTroubleshooting',
  mnyJobStalledAfterCommit: 'importMnyTroubleshooting',
  mnyImportFailedAfterCommit: 'importMnyTroubleshooting',
  mnyAlreadyImported: 'importMnyTroubleshooting',
  mnyStagedFileMissing: 'importMnyTroubleshooting',
  mnyFileTruncated: 'importMnyTroubleshooting',
  mnyNotAMoneyFile: 'importMnyTroubleshooting',
  mnyUnsupportedVersion: 'importMnyTroubleshooting',
  mnyPasswordRequired: 'importMnyTroubleshooting',
  mnyPasswordIncorrect: 'importMnyTroubleshooting',
  mnyUnreadableDatabase: 'importMnyTroubleshooting',
};

/** The guide section for a Money import error, or the troubleshooting table when the code is unknown. */
export function mnyErrorDocsLink(code: string | null | undefined): DocsLink {
  return (code && MNY_ERROR_DOCS_LINKS[code]) || 'importMnyTroubleshooting';
}
