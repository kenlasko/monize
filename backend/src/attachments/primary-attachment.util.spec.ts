import {
  attachmentOriginalSql,
  isPrimaryAttachment,
} from "./primary-attachment.util";

describe("scan pair identity", () => {
  it("exposes the visible row and keeps the original hidden", () => {
    expect(isPrimaryAttachment({ originalOfAttachmentId: null })).toBe(true);
    expect(
      isPrimaryAttachment({ originalOfAttachmentId: "enhanced-image" }),
    ).toBe(false);
  });

  it("selects the original by its enhanced row, both in a join and by a bound id", () => {
    expect(attachmentOriginalSql("a.id", "original")).toBe(
      "original.original_of_attachment_id = a.id",
    );
    expect(attachmentOriginalSql("$1")).toBe("original_of_attachment_id = $1");
  });
});
