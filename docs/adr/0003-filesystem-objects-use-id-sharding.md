# 0003. Filesystem objects use the shared ID-sharding scheme

Status: accepted
Date: 2026-08-04 (recorded retrospectively; the decision was made when the
flat-folder backup collision was fixed, and is already stated as a rule in the
root `CLAUDE.md`)

## Context

The server writes files in two places: attachment bytes under the local
filesystem provider, and each user's automatic backups.

Automatic backup filenames carry only a tier and a date --
`monize-backup-daily-2026-08-03.json.gz`. In a flat shared folder that gave every
user the same name for the same day. Whoever's cron ran last overwrote the rest,
and one user's retention pass deleted another user's files. Both effects are
silent: the backup reports success, and the loss is discovered only when a
restore is attempted.

A second force is filesystem behaviour rather than correctness. A single
directory holding one entry per user, or per attachment, degrades on filesystems
that scan linearly and worse over a network mount, so the layout has to keep any
one directory small regardless of how many objects exist.

## Decision

Both writers derive their path from one helper, `shardedSegments` in
`backend/src/common/shard-path.util.ts`, which returns two levels of two hex
characters taken from an id, followed by the id itself:

```typescript
shardedSegments(id) // -> [ab, cd, id]
```

**What is shared is the scheme, not the shard key and not the shape.** The two
consumers differ in both, deliberately, and conflating them has consequences:

```text
Automatic backups   -- shard key is the USER id, terminal segment is a DIRECTORY
<base>/<ab>/<cd>/<userId>/monize-backup-daily-2026-08-03.json.gz

Local attachments   -- shard key is the ATTACHMENT id, terminal segment is a FILE
<base>/<ab>/<cd>/<attachmentId>
```

Backups shard by user because the *collision* was per-user: the filename is only
unique within one user's set. Attachments shard by attachment id because that id
is already globally unique, so it is the natural key and no per-user grouping is
needed to avoid a collision.

Rules:

- One sharding scheme, one helper. Do not hand-roll a second.
- Do not write a file whose name is only unique within some scope into a folder
  shared beyond that scope. The backup case is the proof: a name that looked
  unique per user was only unique per user *per day*.
- A path built from an id must be validated with `isShardableId` and asserted to
  resolve inside its base before it reaches the filesystem, **even when the id is
  server-generated** (CWE-22).
- State which id a new sharded path is keyed on, in the code and in any document
  that describes it.

## Consequences

**Makes easy.** Directory sizes stay bounded for both writers. For backups
specifically, retention scoping is correct by construction: a user's retention
pass sweeps their own directory and cannot reach anyone else's, which is exactly
the failure that motivated the change.

**Makes hard.** Enumerating every object requires walking two levels.
`enforceRetention` also still sweeps the pre-sharding flat layout, and the local
attachment provider still falls back to a flat path on read and delete, so objects
written before this decision keep resolving without a migration pass. Both
compatibility paths are expected to remain indefinitely.

**Forbids.** A second sharding scheme; a collision-prone flat write; and an
unvalidated id reaching a path, including a server-generated one. The "even when
server-generated" clause is deliberate: an id trusted because of where it came
from stops being trustworthy the moment a caller passes something else, and the
validation is cheap.

**Does not provide: ownership from a path.** This is the distinction most likely
to be misread, so it is stated as a rule rather than left implied:

```text
A backup's owner is recoverable from its path, because the shard key is the user
id. An attachment's owner is NOT, because the shard key is the attachment id and
no user id appears in the path anywhere. Attachment ownership is
database-authoritative, through the attachment metadata row.
```

A cleanup, retention, migration or recovery tool for attachments therefore cannot
work from the filesystem alone -- it must consult PostgreSQL to learn who owns
what, and it must not read the terminal path segment as a directory or as a user
id. Authorization is never derived from path structure for either writer:
sharding is storage distribution, not tenant isolation.

**Does not provide: completeness.** Sharding fixes *which* object belongs to whom.
It says nothing about whether the bytes are whole -- a truncated write still lands
under the expected name. See `docs/external-side-effects.md` and INV-BACKUP-001,
where that remains open.

## Alternatives considered

**Shard attachments by user id too, so both layouts match.** Rejected: it would
put ownership in the path at the cost of a rename whenever an attachment changes
owner, and attachment ownership already has an authoritative home in the metadata
row. Duplicating it into the path creates two sources of truth that can disagree.

**Include the user id in the backup filename, keep one flat directory.** Rejected
on the filesystem force alone: the collision is solved, but a directory with one
entry per user per tier per retained date is exactly the shape that scans badly.

**A database-backed blob for everything, no filesystem writes.** This is what the
database attachment provider does, and it is the strongest option -- metadata and
bytes commit in one transaction. Rejected as the *only* option because deployments
want backups on a mounted volume and attachments in object storage, and a backup
living solely inside the database it backs up is not a backup.

**A single level of sharding.** Rejected as insufficient: one level of two hex
characters caps at 256 directories, so directory size still grows linearly. Two
levels give 65,536, which keeps each directory small across any plausible object
count for this application.

## Verification owed

No test asserts the distinction this ADR turns on. A source or documentation
consistency check should fail when: backup sharding stops being keyed on
`userId`; local attachment sharding stops being keyed on the storage key; a
document claims attachment ownership is derivable from a path; or an
authorization decision reads path structure. Until that exists this ADR is prose,
which ranks last per ADR 0002.
