# Shared expenses: database privilege review

Status: the requesting user authorized these eight additions to the SECURITY
DEFINER registry for local implementation on 2026-10-25. Upstream maintainer
approval is pending; these local decisions do not claim that approval.
Verification is tracked separately.

These functions execute as the schema owner because membership checks recurse
through policies and conservation checks must see all rows of one journal.
Each pins `search_path = public, pg_temp`. None accepts a caller-supplied user ID
or writes a notification, account balance, grant, invitation or ledger entry.

| Function | Elevated read | Boundary |
|---|---|---|
| `shared_group_role(uuid)` | Group and membership | Uses both scoped identity GUCs; returns a role only for that principal. A delegate identity gets no role. |
| `shared_group_writable(uuid)` | Group archive state and role | Owner/editor only. Timestamp-preserving restore permits the owner to insert the newly remapped archived copy. |
| `shared_entry_writable(uuid)` | Entry creator and group | Owner, or the creating editor, while the group is writable. |
| `shared_invitation_allows(uuid, uuid, text)` | Invitation and verified account | Transaction-local token hash, exact group/participant/role, unconsumed/unrevoked/unexpired token, active account, verified target email when present, same real/effective identity. |
| `shared_validate_entry_allocations()` | One entry and its allocations | Trigger-only; deferred conservation check on original and group-currency sums. Does not suppress any check under restore or system identity. |
| `shared_document_group(uuid, uuid)` | Entry-to-group identity | Supplies the parent key to the role predicate. Does not return content, metadata, storage keys or file bytes. |
| `check_attachment_pair_parent()` | A scan and its original | Trigger-only; checks uploader, all four parent kinds, document kind and no original-of-original chain. |
| `shared_pending_notifications(uuid)` | Group activity, eligible memberships and delivery receipts | Only a group the current principal may read, or the current principal's own backlog. Returns identifiers and access-change state. Filters affected participants, mute, membership start, 30-day window and deduplication. No bank data or notification body is returned. |

The requested guard change lists these exact names alongside the existing
reviewed functions. Runtime context allowlists and RLS exemptions are unchanged.
All shared tables have RLS policies. The existing recipient-context notification
service remains the only route to the notification writer and push dispatcher.

Required verification includes enforced-RLS multi-user integration tests,
delegate denial, outsider denial, revoked file access, invitation replay/races,
deferred allocation rejection, private-ledger isolation and restored copies next
to unchanged live groups. The registry addition alone is not evidence those
tests pass; the PR records their actual results separately.

The user foreign keys on `shared_groups` and `shared_memberships` use
`ON DELETE RESTRICT`: erasure first transfers or detaches the corresponding
state. The shared-table migration reasserts both constraints after the retained
user-FK normalization migration, which otherwise changes them to cascading
deletes during a fresh-schema replay. The two-pass schema comparison checks the
resulting constraint definitions, including deletion behavior.

## Additional guard decisions — 2026-10-26

The requesting user approved adapting the backup export guard to the specified
shared-document scope: private files remain owner-only; group and entry files
require current group access, even for their uploader. The guard retains the
restore ownership gate and the two permitted object-read sites. The lifecycle
integration case checks metadata and bytes before and after revocation, including
the explicit SQL predicate on a connection that bypasses RLS.

The requesting user also approved one `EXEMPT_INSERT_SITES` entry for
`backend/src/shared-expenses/shared-finance-write.ts`. Its bank, counterpart and
personal-cost rows are derived from the accepted preview. Applying ordinary
transaction rules after that preview could change its categories or transfer
structure. The booking integration case enables a category-replacing rule,
proves it changes an ordinary new transaction, then checks the shared posting's
accepted category, transfer legs and balances. Imported source rows have already
passed through their import rules before matching; matching does not replay them.

The requesting user approved classifying transient restore fields through
`RESTORE_CLEARED_COLUMNS`, including the ownership-request consent token.
The restore guard checks that each field belongs to a restored table, exists in
the schema, is nullable and is actually returned as NULL by
`prepareSharedRestore`, without mutating the archive. Foreign-key and principal
classification checks remain in place; the nullable consent token is not treated
as a row reference or replayed as live ownership consent.

The requesting user approved updating the two support-backup completeness guards. Column
classification now checks physical columns together with the actual export's
keys, including the snapshot participant claim. Foreign-key coverage compares
the full ordered column pairing and target from `pg_constraint`, retaining the
reverse stale-rule check and the existing schema-only exceptions. Runtime checks
reject mismatched owner/group scope and missing structural journal references;
the focused regressions preserve the original allocation values and input data.
