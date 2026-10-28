import { parseForeignKeys } from "./__fixtures__/schema-foreign-keys";
describe("schema foreign key column pairing", () => {
  it("pairs composite keys positionally rather than cross joining them", () => {
    const rows = parseForeignKeys(`CREATE TABLE child (
      parent_id UUID,
      owner_id UUID,
      CONSTRAINT fk_owner FOREIGN KEY (parent_id, owner_id) REFERENCES parent(id, user_id)
);
ALTER TABLE child ADD CONSTRAINT fk_other FOREIGN KEY (parent_id, owner_id) REFERENCES other(id, user_id);`);
    expect(rows).toEqual([
      {
        table: "child",
        column: "parent_id",
        referencedTable: "parent",
        referencedColumn: "id",
      },
      {
        table: "child",
        column: "owner_id",
        referencedTable: "parent",
        referencedColumn: "user_id",
      },
      {
        table: "child",
        column: "parent_id",
        referencedTable: "other",
        referencedColumn: "id",
      },
      {
        table: "child",
        column: "owner_id",
        referencedTable: "other",
        referencedColumn: "user_id",
      },
    ]);
  });
  it("retains single-column row and natural-key targets", () => {
    expect(
      parseForeignKeys(`CREATE TABLE child (
      id UUID,
      account_id UUID REFERENCES accounts(id),
      currency VARCHAR(3) REFERENCES currencies(code)
);`),
    ).toEqual([
      {
        table: "child",
        column: "account_id",
        referencedTable: "accounts",
        referencedColumn: "id",
      },
      {
        table: "child",
        column: "currency",
        referencedTable: "currencies",
        referencedColumn: "code",
      },
    ]);
  });
});
