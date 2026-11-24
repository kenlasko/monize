import { EntityManager } from "typeorm";
import {
  delegationRowCount,
  reinstateDelegations,
  snapshotDelegations,
} from "./restore-delegations";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const DELEGATE = "00000000-0000-4000-8000-0000000000b1";
const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";
const DELEGATION = "00000000-0000-4000-8000-0000000000d1";

const grant = (account_id: string) => ({
  delegation_id: DELEGATION,
  delegate_user_id: DELEGATE,
  account_id,
  can_read: true,
  can_create: false,
  can_edit: false,
  can_delete: false,
  is_joint: true,
  created_at: null,
});
const overlay = (account_id: string) => ({
  delegate_user_id: DELEGATE,
  account_id,
  sort_order: 3,
  created_at: null,
});

/** A manager whose every INSERT ... RETURNING answers one row (or none). */
function managerInserting(inserted: boolean) {
  const query = jest.fn(async () => (inserted ? [{ id: "x" }] : []));
  return { manager: { query } as unknown as EntityManager, query };
}

describe("restore-delegations", () => {
  it("snapshots grants, favourites and exclusions of the owner's accounts", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([grant(OLD)])
      .mockResolvedValueOnce([overlay(OLD)])
      .mockResolvedValueOnce([overlay(OLD)]);
    const snapshot = await snapshotDelegations(
      { query } as unknown as EntityManager,
      OWNER,
    );
    expect(delegationRowCount(snapshot)).toBe(3);
    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) expect(call[1]).toEqual([OWNER]);
  });

  it("writes every row back onto the account's fresh id", async () => {
    const { manager, query } = managerInserting(true);
    const outcome = await reinstateDelegations(
      manager,
      OWNER,
      {
        grants: [grant(OLD)],
        favourites: [overlay(OLD)],
        exclusions: [overlay(OLD)],
      },
      new Map([[OLD, NEW]]),
    );
    expect(outcome).toEqual({ kept: 3, notRestored: 0 });
    expect(query).toHaveBeenCalledTimes(3);
    // The grant carries the new account id, never the old one.
    expect((query.mock.calls[0] as unknown[][])[1][1]).toBe(NEW);
  });

  it("counts rows whose account is not in the file, and writes nothing for them", async () => {
    const { manager, query } = managerInserting(true);
    const outcome = await reinstateDelegations(
      manager,
      OWNER,
      {
        grants: [grant(OLD)],
        favourites: [overlay(OLD)],
        exclusions: [overlay(OLD)],
      },
      new Map(),
    );
    expect(outcome).toEqual({ kept: 0, notRestored: 3 });
    expect(query).not.toHaveBeenCalled();
  });

  it("counts a grant whose delegation is gone, and drops the favourite that depended on it", async () => {
    const { manager, query } = managerInserting(false);
    const outcome = await reinstateDelegations(
      manager,
      OWNER,
      { grants: [grant(OLD)], favourites: [overlay(OLD)], exclusions: [] },
      new Map([[OLD, NEW]]),
    );
    expect(outcome).toEqual({ kept: 0, notRestored: 2 });
    // Only the grant was attempted: no favourite on an account nobody can see.
    expect(query).toHaveBeenCalledTimes(1);
  });
});
