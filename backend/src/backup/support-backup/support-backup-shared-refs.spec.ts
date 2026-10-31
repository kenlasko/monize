import { randomUUID } from "crypto";
import { scrubDanglingRefs } from "./support-backup-integrity";

describe("shared support snapshot references", () => {
  it("clears optional private links when account scoping removed their target", () => {
    const missing = randomUUID();
    const input = {
      accounts: [{ id: randomUUID(), shared_expense_group_id: missing }],
      shared_people: [{ id: randomUUID(), payee_id: missing }],
    };
    const result = scrubDanglingRefs(input);
    expect(result.accounts[0].shared_expense_group_id).toBeNull();
    expect(result.shared_people[0].payee_id).toBeNull();
    expect(input.accounts[0].shared_expense_group_id).toBe(missing);
    expect(input.shared_people[0].payee_id).toBe(missing);
  });

  it("refuses a missing refund source instead of changing a refund into an invalid row", () => {
    const group = randomUUID();
    const refund = {
      id: randomUUID(),
      group_id: group,
      type: "REFUND",
      source_entry_id: randomUUID(),
    };
    const input = {
      shared_groups: [{ id: group }],
      shared_entries: [refund],
    };
    expect(() => scrubDanglingRefs(input)).toThrow(
      "shared_entries.source_entry_id",
    );
    expect(input.shared_entries).toEqual([refund]);
  });

  it("refuses a participant from another group even when its primary key exists", () => {
    const group = randomUUID();
    const other = randomUUID();
    const participant = randomUUID();
    const entry = randomUUID();
    expect(() =>
      scrubDanglingRefs({
        shared_groups: [{ id: group }, { id: other }],
        shared_participants: [{ id: participant, group_id: other }],
        shared_entries: [{ id: entry, group_id: group }],
        shared_allocations: [
          {
            id: randomUUID(),
            group_id: group,
            entry_id: entry,
            participant_id: participant,
          },
        ],
      }),
    ).toThrow("shared_allocations.participant_id");
  });

  it("checks a personal link's owner as well as its person id", () => {
    const group = randomUUID();
    const participant = randomUUID();
    const person = randomUUID();
    expect(() =>
      scrubDanglingRefs({
        shared_groups: [{ id: group }],
        shared_participants: [{ id: participant, group_id: group }],
        shared_people: [{ id: person, user_id: randomUUID() }],
        shared_person_links: [
          {
            id: randomUUID(),
            group_id: group,
            participant_id: participant,
            person_id: person,
            user_id: randomUUID(),
          },
        ],
      }),
    ).toThrow("shared_person_links.person_id");
  });

  it("preserves complete journal rows and their exact allocation values", () => {
    const group = randomUUID();
    const participant = randomUUID();
    const source = randomUUID();
    const input = {
      shared_groups: [{ id: group, _snapshot_participant_id: participant }],
      shared_participants: [{ id: participant, group_id: group }],
      shared_entries: [
        { id: source, group_id: group, type: "EXPENSE" },
        {
          id: randomUUID(),
          group_id: group,
          type: "REFUND",
          source_entry_id: source,
        },
      ],
      shared_allocations: [
        {
          id: randomUUID(),
          group_id: group,
          entry_id: source,
          participant_id: participant,
          original_amount: "0.0001",
          group_amount: "0.0002",
        },
      ],
    };
    const result = scrubDanglingRefs(input);
    for (const table of Object.keys(input) as (keyof typeof input)[])
      expect(result[table]).toEqual(input[table]);
  });
});
