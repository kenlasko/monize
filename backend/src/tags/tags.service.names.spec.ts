jest.mock("../accruals/accrual-tag-guard", () => ({
  guardAccruedTagDeletion: async () => undefined,
  guardLegacyTagRestore: async () => undefined,
}));
import { MAX_TAGS_PER_CALL, TagsService } from "./tags.service";
import { Tag } from "./entities/tag.entity";

/**
 * Find-or-create by name, for a proposal that adds a tag (email-receipts design
 * 5.5): on the caller's manager, so a rollback drops a tag it created.
 */

const USER = "user-1";

const tag = (id: string, name: string): Tag =>
  ({ id, userId: USER, name, color: null, icon: null }) as Tag;

function setup(existing: Tag[] = []) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => existing),
  };
  const m = {
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    }),
  };
  const service = new TagsService({} as never, { record: jest.fn() } as never);
  return { service, m, qb };
}

describe("TagsService.findByNames", () => {
  it("looks the names up case-insensitively among the user's own tags, once each", async () => {
    const { service, m, qb } = setup([tag("t1", "Allegro")]);

    const found = await service.findByNames(m as never, USER, [
      "ALLEGRO",
      " allegro ",
      "Gifts",
    ]);

    expect(found.map((t) => t.id)).toEqual(["t1"]);
    expect(qb.where).toHaveBeenCalledWith("tag.userId = :userId", {
      userId: USER,
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      "LOWER(tag.name) IN (:...lowered)",
      {
        lowered: ["allegro", "gifts"],
      },
    );
  });

  it("asks nothing for no names", async () => {
    const { service, m } = setup();
    expect(await service.findByNames(m as never, USER, [])).toEqual([]);
    expect(m.getRepository).not.toHaveBeenCalled();
  });
});

describe("TagsService.findOrCreateByNames", () => {
  it("inserts each name only when the user has none by that name, ignoring a conflict, then reads them back in the order asked", async () => {
    const { service, m } = setup([tag("t2", "Gifts"), tag("t1", "Allegro")]);

    const tags = await service.findOrCreateByNames(m as never, USER, [
      "Allegro",
      "Gifts",
    ]);

    expect(m.query).toHaveBeenCalledTimes(2);
    const [sql, params] = m.query.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO tags (user_id, name)");
    expect(String(sql)).toContain("WHERE NOT EXISTS");
    expect(String(sql)).toContain("LOWER(name) = LOWER($2::varchar)");
    expect(String(sql)).toContain("ON CONFLICT DO NOTHING");
    expect(params).toEqual([USER, "Allegro"]);
    expect(m.query.mock.calls[1][1]).toEqual([USER, "Gifts"]);
    expect(tags.map((t) => t.name)).toEqual(["Allegro", "Gifts"]);
  });

  it("leaves an existing tag as it is: its own spelling comes back", async () => {
    const { service, m } = setup([tag("t1", "Allegro")]);
    const tags = await service.findOrCreateByNames(m as never, USER, [
      "ALLEGRO",
    ]);
    expect(tags).toEqual([
      expect.objectContaining({ id: "t1", name: "Allegro" }),
    ]);
  });

  it("trims, skips blanks and counts a name once however it is spelled", async () => {
    const { service, m } = setup([tag("t1", "Allegro")]);
    await service.findOrCreateByNames(m as never, USER, [
      "  Allegro ",
      "allegro",
      "",
      "   ",
    ]);
    expect(m.query).toHaveBeenCalledTimes(1);
    expect(m.query.mock.calls[0][1]).toEqual([USER, "Allegro"]);
  });

  it("takes at most the per-call bound of names", async () => {
    const { service, m } = setup();
    const names = Array.from(
      { length: MAX_TAGS_PER_CALL + 10 },
      (_, i) => `tag ${i}`,
    );
    await service.findOrCreateByNames(m as never, USER, names);
    expect(m.query).toHaveBeenCalledTimes(MAX_TAGS_PER_CALL);
  });

  it("writes through the manager it is given and parameterizes the name", async () => {
    const { service, m } = setup();
    await service.findOrCreateByNames(m as never, USER, [
      "x'); DROP TABLE tags;--",
    ]);
    const [sql, params] = m.query.mock.calls[0];
    expect(String(sql)).not.toContain("DROP TABLE");
    expect(params[1]).toBe("x'); DROP TABLE tags;--");
  });
});
