import { randomUUID } from "crypto";
import { BackupData, backupTables } from "./backup-format";
import {
  prepareSharedRestore,
  validateSharedSnapshot,
  RESTORE_PRINCIPAL_COLUMNS,
} from "./shared-backup";
import { collectRowIdRemap } from "./backup-id-remap.util";
import {
  remapRestoreRow,
  resolveRestoreReferences,
} from "./restore-references";
import {
  personalFingerprint,
  SharedPersonalEffect,
} from "../shared-expenses/shared-projection";
import { reconcileSharedSupport } from "./support-backup/support-backup-rules.shared";

const archive = (
  tables: Record<string, Record<string, unknown>[]>,
): BackupData => tables as unknown as BackupData;

describe("shared snapshots at the restore boundary (SE-010)", () => {
  it("refuses a participant claimed from another group before staging bytes", () => {
    const group = randomUUID(),
      participant = randomUUID();
    expect(() =>
      validateSharedSnapshot(
        archive({
          shared_groups: [{ id: group, _snapshot_participant_id: participant }],
          shared_participants: [{ id: participant, group_id: randomUUID() }],
        }),
      ),
    ).toThrow("snapshot");
  });

  it("remaps the snapshot claim and every journal reference, with a fresh owner and no live grants", () => {
    const group = randomUUID(),
      participant = randomUUID(),
      entry = randomUUID(),
      user = randomUUID();
    const data = resolveRestoreReferences(
      validateSharedSnapshot(
        archive({
          shared_groups: [
            {
              id: group,
              owner_user_id: randomUUID(),
              _snapshot_participant_id: participant.toUpperCase(),
            },
          ],
          shared_participants: [{ id: participant, group_id: group }],
          shared_entries: [
            {
              id: entry,
              group_id: group,
              created_by_user_id: randomUUID(),
              rounding_seed: `seed:${entry}`,
            },
          ],
          shared_activity: [
            {
              id: randomUUID(),
              group_id: group,
              entry_id: entry,
              actor_user_id: randomUUID(),
              actor_name: "Anna",
            },
          ],
        }),
      ),
    ).data;
    const remap = new Map<string, string>();
    for (const rows of Object.values(backupTables(data)))
      collectRowIdRemap(rows ?? [], remap, randomUUID);
    const unresolved = new Map<string, string>();
    const changed = archive(
      Object.fromEntries(
        Object.entries(backupTables(data)).map(([table, rows]) => [
          table,
          (rows ?? []).map(
            (row) =>
              remapRestoreRow(row, remap, unresolved, randomUUID) as Record<
                string,
                unknown
              >,
          ),
        ]),
      ),
    );
    const result = backupTables(prepareSharedRestore(changed, user));
    expect(result.shared_groups![0]).toMatchObject({
      id: remap.get(group),
      owner_user_id: user,
      is_detached_copy: true,
      _snapshot_participant_id: remap.get(participant),
    });
    expect(result.shared_entries![0]).toMatchObject({
      id: remap.get(entry),
      group_id: remap.get(group),
      created_by_user_id: user,
      rounding_seed: `seed:${entry}`,
    });
    expect(result.shared_activity![0]).toMatchObject({
      actor_user_id: null,
      actor_name: "Anna",
    });
    expect(result.shared_memberships).toBeUndefined();
    expect(result.shared_invitations).toBeUndefined();
  });

  it("rehashes accepted personal facts after remapping and removes upload replay identities", () => {
    const effect: SharedPersonalEffect = {
      entryId: randomUUID(),
      date: "2026-01-01",
      type: "EXPENSE",
      state: "POSTED",
      cash: "-300.0000",
      originalCash: "-300.0000",
      originalCurrency: "PLN",
      personal: "-100.0000",
      position: "200.0000",
    };
    const data = archive({
      shared_postings: [
        {
          id: randomUUID(),
          input_fingerprint: "old",
          accepted_snapshot: { effect, input: {} },
        },
      ],
      transaction_attachments: [
        {
          id: randomUUID(),
          upload_request_id: randomUUID(),
          upload_fingerprint: "old",
        },
      ],
    });
    const result = backupTables(prepareSharedRestore(data, randomUUID()));
    expect(result.shared_postings![0].input_fingerprint).toBe(
      personalFingerprint(effect),
    );
    expect(result.transaction_attachments![0]).toMatchObject({
      upload_request_id: null,
      upload_fingerprint: null,
    });
    expect(data.transaction_attachments![0].upload_request_id).not.toBeNull();
  });

  it("clears a pending ownership request and its candidate in the detached copy", () => {
    const request = randomUUID(),
      candidate = randomUUID();
    const data = archive({
      shared_groups: [
        {
          id: randomUUID(),
          ownership_request_id: request,
          ownership_candidate_id: candidate,
        },
      ],
    });
    expect(
      backupTables(prepareSharedRestore(data, randomUUID())).shared_groups![0],
    ).toMatchObject({
      is_detached_copy: true,
      ownership_request_id: null,
      ownership_candidate_id: null,
    });
    expect(backupTables(data).shared_groups![0]).toMatchObject({
      ownership_request_id: request,
      ownership_candidate_id: candidate,
    });
  });

  it("has a forcing policy for each nonstandard principal, including null anonymous actors", () => {
    const user = randomUUID();
    for (const [table, columns] of Object.entries(RESTORE_PRINCIPAL_COLUMNS)) {
      const source = {
        id: randomUUID(),
        ...Object.fromEntries(
          Object.keys(columns).map((column) => [column, randomUUID()]),
        ),
      };
      const row = backupTables(
        prepareSharedRestore(archive({ [table]: [source] }), user),
      )[table]![0];
      for (const [column, policy] of Object.entries(columns))
        expect(row[column]).toBe(policy === "owner" ? user : null);
    }
  });

  it("keeps scaled support shares equal to both totals despite sub-cent rounding", () => {
    const input = {
      shared_entries: [
        {
          id: "entry",
          type: "EXPENSE",
          original_amount: "0.0002",
          group_amount: "0.0001",
          rounding_seed: "seed",
        },
      ],
      shared_allocations: ["SHARE", "CONTRIBUTION"].flatMap((kind) =>
        ["a", "b", "c"].map((participant_id) => ({
          id: `${kind}:${participant_id}`,
          entry_id: "entry",
          participant_id,
          kind,
          original_amount: "0.0001",
          group_amount: "0.0000",
        })),
      ),
    };
    const result = reconcileSharedSupport(input);
    for (const kind of ["SHARE", "CONTRIBUTION"]) {
      const shares = result.shared_allocations.filter(
        (row) => row.kind === kind,
      );
      expect(
        shares.reduce(
          (sum, row) => sum + Math.round(Number(row.original_amount) * 10000),
          0,
        ),
      ).toBe(2);
      expect(
        shares.reduce(
          (sum, row) => sum + Math.round(Number(row.group_amount) * 10000),
          0,
        ),
      ).toBe(1);
    }
    expect(
      input.shared_allocations.every((row) => row.original_amount === "0.0001"),
    ).toBe(true);
  });
});
