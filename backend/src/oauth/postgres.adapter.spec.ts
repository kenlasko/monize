import {
  OAUTH_CLIENT_IDLE_TTL_SECONDS,
  PostgresAdapter,
  OAUTH_SWEEP_BATCH,
  OAUTH_SWEEP_MAX_BATCHES,
  makeAdapterFactory,
  sweepOAuthPayloads,
} from "./postgres.adapter";

describe("PostgresAdapter", () => {
  function makeAdapter(model = "AccessToken") {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const where = jest.fn().mockReturnValue({ execute });
    const set = jest.fn().mockReturnValue({ where });
    const qbUpdate = jest.fn().mockReturnValue({ set });
    const repo = {
      upsert: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({ update: qbUpdate }),
    };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(repo),
    } as any;
    const adapter = new PostgresAdapter(model, dataSource);
    return { adapter, repo, qbUpdate, set, where };
  }

  it("upserts a payload with the right grant_id for grantable models", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");

    await adapter.upsert(
      "tok-1",
      { grantId: "grant-9", aud: "https://example/mcp" } as any,
      3600,
    );

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [entity, options] = repo.upsert.mock.calls[0];
    expect(entity.id).toBe("tok-1");
    expect(entity.model).toBe("AccessToken");
    expect(entity.grantId).toBe("grant-9");
    expect(entity.expiresAt).toBeInstanceOf(Date);
    expect(options).toEqual({ conflictPaths: ["id", "model"] });
  });

  it("does not store grant_id for non-grantable models", async () => {
    const { adapter, repo } = makeAdapter("Client");

    await adapter.upsert(
      "client-1",
      { grantId: "should-be-ignored" } as any,
      0,
    );

    const [entity] = repo.upsert.mock.calls[0];
    expect(entity.grantId).toBeNull();
  });

  it("stores no expiry for an artifact other than a client that the provider gives none", async () => {
    // The idle TTL is the Client's alone; nothing else gains an expiry here.
    const { adapter, repo } = makeAdapter("Session");

    await adapter.upsert("sess-1", {} as any, 0);

    const [entity] = repo.upsert.mock.calls[0];
    expect(entity.expiresAt).toBeNull();
  });

  describe("dynamically registered clients expire (#2177)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it("stores a client with the idle TTL although the provider passes none", async () => {
      // oidc-provider registers a client with no expiresIn at all; before
      // #2177 that stored expires_at NULL and the row lived forever.
      const { adapter, repo } = makeAdapter("Client");
      const before = Date.now();

      await adapter.upsert("client-1", {} as any, undefined as any);

      const [entity] = repo.upsert.mock.calls[0];
      expect(entity.expiresAt).toBeInstanceOf(Date);
      expect(entity.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + OAUTH_CLIENT_IDLE_TTL_SECONDS * 1000,
      );
      expect(OAUTH_CLIENT_IDLE_TTL_SECONDS * 1000).toBe(30 * DAY_MS);
    });

    it.each(["RefreshToken", "Grant"])(
      "a %s minted for a client slides that live client's expiry forward",
      async (model) => {
        const { adapter, set, where } = makeAdapter(model);
        const before = Date.now();

        await adapter.upsert(
          "artifact-1",
          { clientId: "client-1" } as any,
          3600,
        );

        const { expiresAt } = set.mock.calls[0][0];
        expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
          before + OAUTH_CLIENT_IDLE_TTL_SECONDS * 1000,
        );
        const [clause, params] = where.mock.calls[0];
        // Only the named client, only while it is still live (an expired one
        // is already gone as far as find() is concerned), and never shortened.
        expect(clause).toContain("id = :clientId");
        expect(clause).toContain("model = 'Client'");
        expect(clause).toContain("expires_at > :now");
        expect(clause).toContain("expires_at < :staleBefore");
        // At most one rewrite a day: only a client a day or more short of a
        // full TTL is slid, not one on every token.
        expect(expiresAt.getTime() - params.staleBefore.getTime()).toBe(DAY_MS);
        expect(params).toEqual({
          clientId: "client-1",
          now: expect.any(Date),
          staleBefore: expect.any(Date),
        });
      },
    );

    it("a failed slide does not fail the save it follows", async () => {
      // The token is already stored; refusing the grant over bookkeeping
      // would fail a refresh the provider has already committed to.
      const { adapter, repo, where } = makeAdapter("RefreshToken");
      where.mockReturnValue({
        execute: jest.fn().mockRejectedValue(new Error("lock timeout")),
      });

      await expect(
        adapter.upsert("rt-1", { clientId: "client-1" } as any, 3600),
      ).resolves.toBeUndefined();
      expect(repo.upsert).toHaveBeenCalledTimes(1);
    });

    it.each([
      "Interaction",
      "Session",
      "Client",
      "PushedAuthorizationRequest",
      // Always minted beside a Grant or a RefreshToken, which slide the client
      // already; sliding on these too would cost a write on every token.
      "AccessToken",
      "AuthorizationCode",
    ])("a %s does not slide the client's expiry", async (model) => {
      const { adapter, qbUpdate } = makeAdapter(model);

      await adapter.upsert("row-1", { clientId: "client-1" } as any, 600);

      expect(qbUpdate).not.toHaveBeenCalled();
    });
  });

  describe("sweepOAuthPayloads", () => {
    /**
     * A data source whose adopt batches return the given ids and whose delete
     * batches return the given counts.
     */
    function makeSweepSource(updates: string[][], deletes: number[]) {
      const updateWhere = jest.fn();
      const deleteWhere = jest.fn();
      for (const ids of updates) {
        updateWhere.mockReturnValueOnce({
          returning: () => ({
            execute: jest
              .fn()
              .mockResolvedValue({ raw: ids.map((id) => ({ id })) }),
          }),
        });
      }
      for (const n of deletes) {
        deleteWhere.mockReturnValueOnce({
          execute: jest.fn().mockResolvedValue({ affected: n }),
        });
      }
      const set = jest.fn().mockReturnValue({ where: updateWhere });
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue({
            update: () => ({ set }),
            delete: () => ({ where: deleteWhere }),
          }),
        }),
      } as any;
      return { dataSource, set, updateWhere, deleteWhere };
    }

    const ids = (prefix: string, n: number) =>
      Array.from(
        { length: n },
        (_, i) => `${prefix}${String(i).padStart(5, "0")}`,
      );

    it("gives clients without an expiry the idle TTL, then deletes expired rows", async () => {
      const { dataSource, set, updateWhere, deleteWhere } = makeSweepSource(
        [["a", "b", "c"]],
        [7],
      );
      const before = Date.now();

      await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
        adopted: 3,
        deleted: 7,
      });

      const { expiresAt } = set.mock.calls[0][0];
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + OAUTH_CLIENT_IDLE_TTL_SECONDS * 1000,
      );
      const [adoptClause, adoptParams] = updateWhere.mock.calls[0];
      expect(adoptClause).toContain("model = 'Client' AND expires_at IS NULL");
      expect(adoptClause).toContain("id > :after");
      expect(adoptClause).toContain(
        "ORDER BY id LIMIT :batch FOR UPDATE SKIP LOCKED",
      );
      expect(adoptParams).toEqual({ after: "", batch: OAUTH_SWEEP_BATCH });
      const [deleteClause, deleteParams] = deleteWhere.mock.calls[0];
      expect(deleteClause).toContain("expires_at < :now");
      expect(deleteClause).toContain("LIMIT :batch FOR UPDATE SKIP LOCKED");
      expect(deleteParams.now.getTime()).toBeGreaterThanOrEqual(before);
      expect(deleteParams.batch).toBe(OAUTH_SWEEP_BATCH);
    });

    it("adopts in key order, each batch starting after the last id it saw", async () => {
      // No index covers a NULL expiry: restarting every batch from the top
      // would rescan the rows already adopted.
      const first = ids("k", OAUTH_SWEEP_BATCH);
      const { dataSource, updateWhere } = makeSweepSource(
        [first, ["z1", "z2"]],
        [0],
      );

      await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
        adopted: OAUTH_SWEEP_BATCH + 2,
        deleted: 0,
      });
      expect(updateWhere).toHaveBeenCalledTimes(2);
      expect(updateWhere.mock.calls[1][1]).toEqual({
        after: first[first.length - 1],
        batch: OAUTH_SWEEP_BATCH,
      });
    });

    it("keeps deleting while batches come back full, and stops on a short one", async () => {
      const { dataSource, deleteWhere } = makeSweepSource(
        [[]],
        [OAUTH_SWEEP_BATCH, OAUTH_SWEEP_BATCH, 12],
      );

      await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
        adopted: 0,
        deleted: 2 * OAUTH_SWEEP_BATCH + 12,
      });
      expect(deleteWhere).toHaveBeenCalledTimes(3);
    });

    it("stops at the per-run cap and leaves the rest to the next run", async () => {
      const { dataSource, deleteWhere } = makeSweepSource(
        [[]],
        Array.from(
          { length: OAUTH_SWEEP_MAX_BATCHES + 5 },
          () => OAUTH_SWEEP_BATCH,
        ),
      );

      const { deleted } = await sweepOAuthPayloads(dataSource);

      expect(deleteWhere).toHaveBeenCalledTimes(OAUTH_SWEEP_MAX_BATCHES);
      expect(deleted).toBe(OAUTH_SWEEP_MAX_BATCHES * OAUTH_SWEEP_BATCH);
    });

    it("counts a delete with no reported count as empty", async () => {
      const { dataSource, deleteWhere } = makeSweepSource([[]], []);
      deleteWhere.mockReturnValueOnce({
        execute: jest.fn().mockResolvedValue({}),
      });

      await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
        adopted: 0,
        deleted: 0,
      });
    });
  });

  it("returns undefined for expired payloads", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");
    repo.findOne.mockResolvedValue({
      id: "tok",
      model: "AccessToken",
      payload: { foo: "bar" },
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    });

    const result = await adapter.find("tok");

    expect(result).toBeUndefined();
  });

  it("returns the payload for non-expired rows and adds consumed claim when consumed", async () => {
    const { adapter, repo } = makeAdapter("AuthorizationCode");
    const consumedAt = new Date();
    repo.findOne.mockResolvedValue({
      id: "code",
      model: "AuthorizationCode",
      payload: { foo: "bar" },
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt,
    });

    const result = await adapter.find("code");

    expect(result).toMatchObject({
      foo: "bar",
      consumed: Math.floor(consumedAt.getTime() / 1000),
    });
  });

  it("revokeByGrantId deletes by grant_id only (not scoped to model)", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");

    await adapter.revokeByGrantId("grant-9");

    expect(repo.delete).toHaveBeenCalledWith({ grantId: "grant-9" });
  });

  it("destroy scopes deletion to the (id, model) tuple", async () => {
    const { adapter, repo } = makeAdapter("Session");

    await adapter.destroy("sess-1");

    expect(repo.delete).toHaveBeenCalledWith({
      id: "sess-1",
      model: "Session",
    });
  });

  it("consume sets consumed_at without removing the row", async () => {
    const { adapter, repo } = makeAdapter("AuthorizationCode");

    await adapter.consume("code-1");

    expect(repo.update).toHaveBeenCalledWith(
      { id: "code-1", model: "AuthorizationCode" },
      expect.objectContaining({ consumedAt: expect.any(Date) }),
    );
  });

  /**
   * The two lookups that were never covered. Both matter to the RLS exemption
   * argument in `docs/row-level-security-contract.md` section 3, which rests on
   * every adapter query being keyed by an opaque provider identifier: a lookup
   * that forgot to scope by `model` would read one artifact class's row while
   * claiming to serve another.
   */
  describe("secondary lookups stay scoped to their model", () => {
    it("findByUserCode keys on (userCode, model)", async () => {
      const { adapter, repo } = makeAdapter("DeviceCode");
      repo.findOne.mockResolvedValue({
        id: "dev-1",
        model: "DeviceCode",
        payload: { foo: "bar" },
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });

      await expect(adapter.findByUserCode("WDJB-MJHT")).resolves.toMatchObject({
        foo: "bar",
      });
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { userCode: "WDJB-MJHT", model: "DeviceCode" },
      });
    });

    it("findByUid keys on (uid, model)", async () => {
      const { adapter, repo } = makeAdapter("Session");
      repo.findOne.mockResolvedValue({
        id: "sess-1",
        model: "Session",
        payload: { foo: "bar" },
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });

      await expect(adapter.findByUid("uid-1")).resolves.toMatchObject({
        foo: "bar",
      });
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { uid: "uid-1", model: "Session" },
      });
    });

    it("returns undefined rather than a payload when the row is missing", async () => {
      // "Not found" and "found but expired" are the same answer to the caller,
      // and neither may be an empty payload object -- oidc-provider treats a
      // returned object as a live artifact.
      const { adapter, repo } = makeAdapter("Session");
      repo.findOne.mockResolvedValue(null);

      await expect(adapter.findByUid("nope")).resolves.toBeUndefined();
      await expect(adapter.findByUserCode("nope")).resolves.toBeUndefined();
    });
  });

  it("makeAdapterFactory builds one adapter per model over a shared DataSource", () => {
    // The provider calls the factory once per artifact class; each instance must
    // carry its own model or `destroy`/`consume` would cross artifact classes.
    const dataSource = { getRepository: jest.fn() } as any;
    const factory = makeAdapterFactory(dataSource);

    const accessToken = factory("AccessToken");
    const session = factory("Session");

    expect(accessToken).toBeInstanceOf(PostgresAdapter);
    expect(session).toBeInstanceOf(PostgresAdapter);
    expect(accessToken).not.toBe(session);
    expect((accessToken as any).model).toBe("AccessToken");
    expect((session as any).model).toBe("Session");
    expect((accessToken as any).dataSource).toBe(dataSource);
  });
});
