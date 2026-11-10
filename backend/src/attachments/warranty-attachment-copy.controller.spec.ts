import { ALLOW_DELEGATE_KEY } from "../delegation/decorators/delegate-access.decorator";
import { WarrantyAttachmentCopyController } from "./warranty-attachment-copy.controller";
import { WarrantyAttachmentCopyService } from "./warranty-attachment-copy.service";

describe("WarrantyAttachmentCopyController", () => {
  it("copies as the signed-in user, never one named in the request", async () => {
    const copyToWarranty = jest.fn().mockResolvedValue({ id: "copy" });
    const controller = new WarrantyAttachmentCopyController({
      copyToWarranty,
    } as unknown as WarrantyAttachmentCopyService);
    const dto = { sourceAttachmentId: "receipt" };

    await expect(
      controller.copy({ user: { id: "user-1" } }, "warranty-1", dto),
    ).resolves.toEqual({ id: "copy" });
    expect(copyToWarranty).toHaveBeenCalledWith("user-1", "warranty-1", dto);
  });

  it("is the owner's alone: a delegate is not admitted", () => {
    expect(
      Reflect.getMetadata(
        ALLOW_DELEGATE_KEY,
        WarrantyAttachmentCopyController.prototype.copy,
      ),
    ).toBeUndefined();
  });
});
