jest.mock("../accruals/accrual-taxonomy-operation", () => ({
  beginTaxonomyOperation: async () => undefined,
  recordTaxonomyOperation: async () => undefined,
}));
import { NotFoundException } from "@nestjs/common";
import { PayeeToolPrepService } from "./payee-tool-prep.service";

describe("PayeeToolPrepService", () => {
  let prep: PayeeToolPrepService;
  let payees: Record<string, jest.Mock>;
  const USER = "u1";

  beforeEach(() => {
    payees = {
      previewCreatePayee: jest.fn(),
      previewUpdatePayee: jest.fn(),
      previewDeletePayee: jest.fn(),
    };
    prep = new PayeeToolPrepService(payees as any);
  });

  describe("create", () => {
    it("collects ok previews and rows, skipping failures by index", async () => {
      payees.previewCreatePayee
        .mockResolvedValueOnce({
          name: "A",
          defaultCategoryId: "c1",
          defaultCategoryName: "Cat",
        })
        .mockRejectedValueOnce(new NotFoundException("Unknown category: X"));

      const result = await prep.prepareCreatePayees(USER, [
        { name: "A", categoryName: "Cat" },
        { name: "B", categoryName: "X" },
      ]);

      expect(result.okPreviews).toHaveLength(1);
      expect(result.okRows).toEqual([{ name: "A", defaultCategoryId: "c1" }]);
      expect(result.okIndex).toEqual([0]);
      expect(result.skipped).toEqual([
        { index: 1, reason: "Unknown category: X" },
      ]);
      expect(result.previewRows).toHaveLength(2);
      expect(result.previewRows[0]).toMatchObject({ status: "ok", name: "A" });
      expect(result.previewRows[1]).toMatchObject({
        status: "error",
        name: "B",
      });
    });

    it("prepareCreatePayeeSingle delegates to the service", async () => {
      payees.previewCreatePayee.mockResolvedValue({
        name: "A",
        defaultCategoryId: null,
        defaultCategoryName: null,
      });
      const preview = await prep.prepareCreatePayeeSingle(USER, { name: "A" });
      expect(preview.name).toBe("A");
      expect(payees.previewCreatePayee).toHaveBeenCalledWith(
        USER,
        { name: "A", categoryName: undefined },
        {},
      );
    });
  });

  describe("update", () => {
    it("maps ok previews to batch rows", async () => {
      payees.previewUpdatePayee.mockResolvedValue({
        payeeId: "p1",
        name: "New",
        defaultCategoryId: "c2",
        defaultCategoryName: "Cat2",
      });

      const result = await prep.prepareUpdatePayees(USER, [
        { name: "Old", newName: "New" },
      ]);

      expect(result.okRows).toEqual([
        { payeeId: "p1", name: "New", defaultCategoryId: "c2" },
      ]);
      expect(result.previewRows[0]).toMatchObject({
        status: "ok",
        name: "New",
        categoryName: "Cat2",
      });
    });

    it("flags update rows that fail to resolve", async () => {
      payees.previewUpdatePayee.mockRejectedValue(
        new NotFoundException('Payee "Gone" not found'),
      );

      const result = await prep.prepareUpdatePayees(USER, [{ name: "Gone" }]);

      expect(result.okRows).toEqual([]);
      expect(result.skipped).toEqual([
        { index: 0, reason: 'Payee "Gone" not found' },
      ]);
      expect(result.previewRows[0]).toMatchObject({
        status: "error",
        name: "Gone",
      });
    });
  });

  describe("delete", () => {
    it("maps ok previews to id-only rows and skips failures", async () => {
      payees.previewDeletePayee
        .mockResolvedValueOnce({ payeeId: "p1", name: "Keep" })
        .mockRejectedValueOnce(new NotFoundException('Payee "Gone" not found'));

      const result = await prep.prepareDeletePayees(USER, [
        { name: "Keep" },
        { name: "Gone" },
      ]);

      expect(result.okRows).toEqual([{ payeeId: "p1" }]);
      expect(result.skipped).toEqual([
        { index: 1, reason: 'Payee "Gone" not found' },
      ]);
      expect(result.previewRows[0]).toMatchObject({
        status: "ok",
        name: "Keep",
      });
    });
  });

  describe("error rows with a missing name fall back to null", () => {
    it("create/update/delete error rows null the name when none was given", async () => {
      payees.previewCreatePayee.mockRejectedValue(new Error("boom"));
      payees.previewUpdatePayee.mockRejectedValue(new Error("boom"));
      payees.previewDeletePayee.mockRejectedValue(new Error("boom"));

      const c = await prep.prepareCreatePayees(USER, [{} as never]);
      const u = await prep.prepareUpdatePayees(USER, [{} as never]);
      const d = await prep.prepareDeletePayees(USER, [{} as never]);

      expect(c.previewRows[0]).toMatchObject({ status: "error", name: null });
      expect(u.previewRows[0]).toMatchObject({ status: "error", name: null });
      expect(d.previewRows[0]).toMatchObject({ status: "error", name: null });
    });
  });
  describe("contact fields", () => {
    it("passes a create row's contact fields to the preview", async () => {
      payees.previewCreatePayee.mockResolvedValue({
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        address: "1 Main St",
        email: "hi@acme.com",
        phone: "555",
      });

      await prep.prepareCreatePayeeSingle(USER, {
        name: "Acme",
        address: "1 Main St",
        email: "hi@acme.com",
        phone: "555",
      });

      expect(payees.previewCreatePayee).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          address: "1 Main St",
          email: "hi@acme.com",
          phone: "555",
        }),
        {},
      );
    });

    it("passes an update row's contact fields, including the empty string that clears one", async () => {
      payees.previewUpdatePayee.mockResolvedValue({
        payeeId: "p1",
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        address: null,
      });

      await prep.prepareUpdatePayeeSingle(USER, {
        name: "Acme",
        address: "",
        phone: "555",
      });

      expect(payees.previewUpdatePayee).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ address: "", phone: "555" }),
      );
    });

    it("carries the contact fields onto the signed batch rows", () => {
      // The batch row is what a confirmed action writes: a field resolved at
      // preview time but dropped here would be shown on the card and then not
      // saved.
      expect(
        PayeeToolPrepService.createToBatchRow({
          name: "Acme",
          defaultCategoryId: null,
          defaultCategoryName: null,
          address: "1 Main St",
          email: "hi@acme.com",
          phone: "555",
        }),
      ).toEqual(
        expect.objectContaining({
          address: "1 Main St",
          email: "hi@acme.com",
          phone: "555",
        }),
      );

      expect(
        PayeeToolPrepService.updateToBatchRow({
          payeeId: "p1",
          name: "Acme",
          defaultCategoryId: null,
          defaultCategoryName: null,
          address: null,
        }),
      ).toEqual(expect.objectContaining({ address: null }));
    });
  });

  describe("website", () => {
    it("passes a create row's website to the preview", async () => {
      payees.previewCreatePayee.mockResolvedValue({
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        website: "https://acme.com",
      });

      await prep.prepareCreatePayeeSingle(USER, {
        name: "Acme",
        website: "acme.com",
      });

      expect(payees.previewCreatePayee).toHaveBeenCalledWith(
        USER,
        { name: "Acme", categoryName: undefined, website: "acme.com" },
        {},
      );
    });

    it("passes an update row's website to the preview", async () => {
      payees.previewUpdatePayee.mockResolvedValue({
        payeeId: "p1",
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        website: "https://acme.com",
      });

      await prep.prepareUpdatePayeeSingle(USER, {
        name: "Acme",
        website: "acme.com",
      });

      expect(payees.previewUpdatePayee).toHaveBeenCalledWith(USER, {
        name: "Acme",
        newName: undefined,
        categoryName: undefined,
        website: "acme.com",
      });
    });

    it("carries the normalised website onto the signed batch rows", () => {
      // The row is what the confirmed action writes, so a website resolved at
      // preview time has to survive into it or approving the card would save
      // the payee without one.
      expect(
        PayeeToolPrepService.createToBatchRow({
          name: "Acme",
          defaultCategoryId: null,
          defaultCategoryName: null,
          website: "https://acme.com",
        }),
      ).toEqual({
        name: "Acme",
        defaultCategoryId: null,
        website: "https://acme.com",
      });

      expect(
        PayeeToolPrepService.updateToBatchRow({
          payeeId: "p1",
          name: "Acme",
          defaultCategoryId: null,
          defaultCategoryName: null,
          website: null,
        }),
      ).toEqual({
        payeeId: "p1",
        name: "Acme",
        defaultCategoryId: null,
        website: null,
      });
    });
  });
});
