import { EntityManager } from "typeorm";

/**
 * A replace restore deletes the user's accounts, and `ON DELETE CASCADE` takes
 * with them the grants on those accounts and the favourites and net-worth
 * exclusions other users hold on them. Those tables are not part of a backup
 * (they describe another user's access), so the file cannot bring them back.
 *
 * Instead the restore reads them before the wipe and writes them again for every
 * account the file brings back, onto that account's fresh id (`idRemap`), and
 * only where the delegation still exists. What cannot be written is counted and
 * reported (docs/backup-restore-contract.md section 8).
 */

interface GrantRow {
  delegation_id: string;
  delegate_user_id: string;
  account_id: string;
  can_read: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  is_joint: boolean;
  created_at: Date | null;
}

interface OverlayRow {
  delegate_user_id: string;
  account_id: string;
  sort_order?: number;
  created_at: Date | null;
}

export interface DelegationSnapshot {
  grants: GrantRow[];
  favourites: OverlayRow[];
  exclusions: OverlayRow[];
}

export interface DelegationOutcome {
  kept: number;
  notRestored: number;
}

/**
 * Read every grant, favourite and exclusion on `ownerId`'s accounts. The
 * favourites and exclusions belong to the delegates, so under row-level security
 * this has to run in a system context (the caller's decision, not made here).
 */
export async function snapshotDelegations(
  manager: EntityManager,
  ownerId: string,
): Promise<DelegationSnapshot> {
  const grants = await manager.query(
    `SELECT g.delegation_id, d.delegate_user_id, g.account_id, g.can_read,
            g.can_create, g.can_edit, g.can_delete, g.is_joint, g.created_at
       FROM account_delegate_grants g
       JOIN account_delegates d ON d.id = g.delegation_id
       JOIN accounts a ON a.id = g.account_id
      WHERE a.user_id = $1`,
    [ownerId],
  );
  const favourites = await manager.query(
    `SELECT f.delegate_user_id, f.account_id, f.sort_order, f.created_at
       FROM delegate_account_favourites f
       JOIN accounts a ON a.id = f.account_id
      WHERE a.user_id = $1`,
    [ownerId],
  );
  const exclusions = await manager.query(
    `SELECT x.delegate_user_id, x.account_id, x.created_at
       FROM delegate_net_worth_exclusions x
       JOIN accounts a ON a.id = x.account_id
      WHERE a.user_id = $1`,
    [ownerId],
  );
  return { grants, favourites, exclusions };
}

export function delegationRowCount(snapshot: DelegationSnapshot): number {
  return (
    snapshot.grants.length +
    snapshot.favourites.length +
    snapshot.exclusions.length
  );
}

/**
 * Write the snapshot's rows onto the restored accounts. A grant is written when
 * its account id is in `idRemap` and its delegation still exists; a favourite or
 * exclusion only when the same delegate's grant on that account was written, so
 * no one ends up marking an account they cannot see.
 */
export async function reinstateDelegations(
  manager: EntityManager,
  ownerId: string,
  snapshot: DelegationSnapshot,
  idRemap: ReadonlyMap<string, string>,
): Promise<DelegationOutcome> {
  let kept = 0;
  const granted = new Set<string>();

  for (const g of snapshot.grants) {
    const accountId = idRemap.get(g.account_id);
    if (!accountId) continue;
    const rows = await manager.query(
      `INSERT INTO account_delegate_grants
         (delegation_id, account_id, can_read, can_create, can_edit, can_delete,
          is_joint, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
        WHERE EXISTS (SELECT 1 FROM account_delegates
                       WHERE id = $1 AND owner_user_id = $9 AND status <> 'revoked')
          AND EXISTS (SELECT 1 FROM accounts WHERE id = $2 AND user_id = $9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        g.delegation_id,
        accountId,
        g.can_read,
        g.can_create,
        g.can_edit,
        g.can_delete,
        g.is_joint,
        g.created_at,
        ownerId,
      ],
    );
    if (rows.length > 0) {
      kept += 1;
      granted.add(`${g.delegate_user_id}:${accountId}`);
    }
  }

  for (const r of snapshot.favourites) {
    const accountId = idRemap.get(r.account_id);
    if (!accountId || !granted.has(`${r.delegate_user_id}:${accountId}`)) {
      continue;
    }
    const rows = await manager.query(
      `INSERT INTO delegate_account_favourites
         (delegate_user_id, account_id, sort_order, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
      [r.delegate_user_id, accountId, r.sort_order ?? 0, r.created_at],
    );
    kept += rows.length;
  }
  for (const r of snapshot.exclusions) {
    const accountId = idRemap.get(r.account_id);
    if (!accountId || !granted.has(`${r.delegate_user_id}:${accountId}`)) {
      continue;
    }
    const rows = await manager.query(
      `INSERT INTO delegate_net_worth_exclusions
         (delegate_user_id, account_id, created_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [r.delegate_user_id, accountId, r.created_at],
    );
    kept += rows.length;
  }

  return { kept, notRestored: delegationRowCount(snapshot) - kept };
}
