import "reflect-metadata";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Test, TestingModule } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { Request } from "express";
import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";
import { ALLOW_DELEGATE_KEY } from "../delegation/decorators/delegate-access.decorator";
import { BankSyncConnectionsService } from "./bank-sync-connections.service";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { BankSyncController } from "./bank-sync.controller";
import { BankSyncService } from "./bank-sync.service";
import type { BankSyncResult } from "./bank-sync.types";
import { BankSyncCallbackDto } from "./dto/bank-sync-callback.dto";
import { CreateBankSyncConnectionDto } from "./dto/create-bank-sync-connection.dto";
import { LinkBankSyncAccountDto } from "./dto/link-bank-sync-account.dto";
import { LinkDefaultsQueryDto } from "./dto/link-defaults-query.dto";
import { ListInstitutionsQueryDto } from "./dto/list-institutions-query.dto";
import { SaveBankSyncCredentialsDto } from "./dto/save-bank-sync-credentials.dto";
import { RemoveBankSyncExceptionsDto } from "./dto/remove-bank-sync-exceptions.dto";
import {
  MAX_SYNC_KEYS,
  SyncBankSyncAccountDto,
} from "./dto/sync-bank-sync-account.dto";
import { UpdateBankSyncConnectionDto } from "./dto/update-bank-sync-connection.dto";
import {
  ACCOUNT_ID,
  BANK_ACCOUNT_ID,
  CONNECTION_ID,
  USER_ID,
} from "./bank-sync-testing";

type Handler = keyof BankSyncController;

const THROTTLER_LIMIT = "THROTTLER:LIMIT";
const ROUTE_ARGS = "__routeArguments__";

describe("BankSyncController", () => {
  const credentials: jest.Mocked<
    Pick<BankSyncCredentialsService, "getStatus" | "save" | "remove" | "test">
  > = {
    getStatus: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    test: jest.fn(),
  };
  const connections: jest.Mocked<
    Pick<
      BankSyncConnectionsService,
      | "listInstitutions"
      | "list"
      | "start"
      | "reauthorize"
      | "completeCallback"
      | "updateConnection"
      | "disconnect"
      | "matchAccounts"
    >
  > = {
    listInstitutions: jest.fn(),
    list: jest.fn(),
    start: jest.fn(),
    reauthorize: jest.fn(),
    completeCallback: jest.fn(),
    updateConnection: jest.fn(),
    disconnect: jest.fn(),
    matchAccounts: jest.fn(),
  };
  const bankSync: jest.Mocked<
    Pick<
      BankSyncService,
      | "linkAccount"
      | "linkDefaults"
      | "previewAccount"
      | "syncAccount"
      | "syncConnection"
      | "removeExceptions"
    >
  > = {
    linkAccount: jest.fn(),
    linkDefaults: jest.fn(),
    previewAccount: jest.fn(),
    syncAccount: jest.fn(),
    syncConnection: jest.fn(),
    removeExceptions: jest.fn(),
  };

  let controller: BankSyncController;
  const req = (ip: string | null = "203.0.113.4") =>
    ({
      user: { id: USER_ID },
      ip: ip ?? undefined,
      socket: {},
    }) as unknown as Request & {
      user: { id: string };
    };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BankSyncController],
      providers: [
        { provide: BankSyncCredentialsService, useValue: credentials },
        { provide: BankSyncConnectionsService, useValue: connections },
        { provide: BankSyncService, useValue: bankSync },
      ],
    }).compile();
    controller = module.get(BankSyncController);
  });

  describe("routes (spec section 9)", () => {
    const routes: Array<[Handler, RequestMethod, string]> = [
      ["getStatus", RequestMethod.GET, "status"],
      ["saveCredentials", RequestMethod.PUT, "credentials"],
      ["deleteCredentials", RequestMethod.DELETE, "credentials"],
      ["testCredentials", RequestMethod.POST, "credentials/test"],
      ["listInstitutions", RequestMethod.GET, "institutions"],
      ["listConnections", RequestMethod.GET, "connections"],
      ["startConnection", RequestMethod.POST, "connections"],
      ["reauthorize", RequestMethod.POST, "connections/:id/reauthorize"],
      ["completeCallback", RequestMethod.POST, "callback"],
      ["updateConnection", RequestMethod.PATCH, "connections/:id"],
      ["disconnect", RequestMethod.DELETE, "connections/:id"],
      ["matchAccounts", RequestMethod.POST, "connections/:id/match"],
      ["linkDefaults", RequestMethod.GET, "accounts/:id/link-defaults"],
      ["linkAccount", RequestMethod.PATCH, "accounts/:id"],
      ["previewAccount", RequestMethod.POST, "accounts/:id/preview"],
      ["syncAccount", RequestMethod.POST, "accounts/:id/sync"],
      [
        "removeExceptions",
        RequestMethod.POST,
        "accounts/:id/exceptions/remove",
      ],
      ["syncConnection", RequestMethod.POST, "connections/:id/sync"],
    ];

    it.each(routes)("%s is %s /bank-sync/%s", (handler, method, path) => {
      const fn = BankSyncController.prototype[handler];
      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(path);
      expect(Reflect.getMetadata(PATH_METADATA, BankSyncController)).toBe(
        "bank-sync",
      );
    });

    it("is behind the JWT guard and owner-only (no @AllowDelegate anywhere)", () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, BankSyncController);
      expect(guards).toHaveLength(1);
      expect(guards[0]).toBe(AuthGuard("jwt"));
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, BankSyncController),
      ).toBeUndefined();
      for (const [handler] of routes) {
        expect(
          Reflect.getMetadata(
            ALLOW_DELEGATE_KEY,
            BankSyncController.prototype[handler],
          ),
        ).toBeUndefined();
      }
    });

    it("demo-restricts every write and no read", () => {
      for (const [handler, method] of routes) {
        const restricted = Reflect.getMetadata(
          DEMO_RESTRICTED_KEY,
          BankSyncController.prototype[handler],
        );
        expect({ handler, restricted: restricted === true }).toEqual({
          handler,
          restricted: method !== RequestMethod.GET,
        });
      }
    });

    it("throttles the routes that reach the provider or the bank", () => {
      const throttled: Handler[] = [
        "testCredentials",
        "listInstitutions",
        "startConnection",
        "reauthorize",
        "completeCallback",
        "matchAccounts",
        "previewAccount",
        "syncAccount",
        "syncConnection",
      ];
      for (const handler of throttled) {
        const limit = Reflect.getMetadata(
          `${THROTTLER_LIMIT}default`,
          BankSyncController.prototype[handler],
        );
        expect({ handler, limit: typeof limit }).toEqual({
          handler,
          limit: "number",
        });
      }
    });

    it("takes every :id through ParseUUIDPipe", () => {
      for (const [handler, , path] of routes) {
        if (!path.includes(":id")) continue;
        const args = Reflect.getMetadata(
          ROUTE_ARGS,
          BankSyncController,
          handler,
        ) as Record<string, { data?: string; pipes: unknown[] }>;
        const idArg = Object.values(args).find((arg) => arg.data === "id");
        expect({ handler, pipes: idArg?.pipes.length }).toEqual({
          handler,
          pipes: 1,
        });
        expect(
          (idArg!.pipes[0] as { name?: string }).name ??
            (idArg!.pipes[0] as { constructor: { name: string } }).constructor
              .name,
        ).toBe("ParseUUIDPipe");
      }
    });
  });

  describe("delegation to the services, with the user from the JWT", () => {
    it("status", async () => {
      await controller.getStatus(req());
      expect(credentials.getStatus).toHaveBeenCalledWith(USER_ID);
    });

    it("saves and deletes credentials", async () => {
      const dto = { applicationId: "app-1", privateKey: "PEM" };
      await controller.saveCredentials(req(), dto);
      expect(credentials.save).toHaveBeenCalledWith(USER_ID, dto);
      await controller.deleteCredentials(req());
      expect(credentials.remove).toHaveBeenCalledWith(USER_ID);
      await controller.testCredentials(req());
      expect(credentials.test).toHaveBeenCalledWith(USER_ID);
    });

    it("institutions, connections and the authorization flow", async () => {
      await controller.listInstitutions(req(), { country: "PL" });
      expect(connections.listInstitutions).toHaveBeenCalledWith(USER_ID, "PL");
      await controller.listConnections(req());
      expect(connections.list).toHaveBeenCalledWith(USER_ID);
      const dto = {
        institutionName: "Test Bank",
        country: "PL",
        psuType: "personal" as const,
      };
      await controller.startConnection(req(), dto);
      expect(connections.start).toHaveBeenCalledWith(USER_ID, dto);
      await controller.reauthorize(req(), CONNECTION_ID);
      expect(connections.reauthorize).toHaveBeenCalledWith(
        USER_ID,
        CONNECTION_ID,
      );
      await controller.completeCallback(req(), { state: "s", code: "c" });
      expect(connections.completeCallback).toHaveBeenCalledWith(USER_ID, {
        state: "s",
        code: "c",
      });
      await controller.updateConnection(req(), CONNECTION_ID, {
        autoSync: false,
      });
      expect(connections.updateConnection).toHaveBeenCalledWith(
        USER_ID,
        CONNECTION_ID,
        { autoSync: false, notifySuccess: undefined },
      );
      await controller.updateConnection(req(), CONNECTION_ID, {
        notifySuccess: "never",
      });
      expect(connections.updateConnection).toHaveBeenLastCalledWith(
        USER_ID,
        CONNECTION_ID,
        { autoSync: undefined, notifySuccess: "never" },
      );
      await controller.disconnect(req(), CONNECTION_ID);
      expect(connections.disconnect).toHaveBeenCalledWith(
        USER_ID,
        CONNECTION_ID,
      );
    });

    it("links a bank account", async () => {
      const dto = { accountId: ACCOUNT_ID, syncFromDate: "2026-01-01" };
      await controller.linkAccount(req(), BANK_ACCOUNT_ID, dto);
      expect(bankSync.linkAccount).toHaveBeenCalledWith(
        USER_ID,
        BANK_ACCOUNT_ID,
        dto,
      );
    });

    it("a user-present sync forwards the client address and user agent", async () => {
      const result = { bankAccountId: BANK_ACCOUNT_ID } as BankSyncResult;
      bankSync.syncAccount.mockResolvedValue(result);
      await expect(
        controller.syncAccount(req(), BANK_ACCOUNT_ID, {}, "Mozilla/5.0"),
      ).resolves.toBe(result);
      expect(bankSync.syncAccount).toHaveBeenCalledWith(
        USER_ID,
        BANK_ACCOUNT_ID,
        { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" },
        undefined,
        undefined,
      );
      await controller.syncConnection(req(), CONNECTION_ID, "Mozilla/5.0");
      expect(bankSync.syncConnection).toHaveBeenCalledWith(
        USER_ID,
        CONNECTION_ID,
        { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" },
      );
    });

    it("sends the sync as unattended when the client address is unknown", async () => {
      await controller.syncAccount(req(null), BANK_ACCOUNT_ID, {}, "UA");
      expect(bankSync.syncAccount).toHaveBeenCalledWith(
        USER_ID,
        BANK_ACCOUNT_ID,
        null,
        undefined,
        undefined,
      );
    });

    it("passes the person's selection from the preview on, and none when neither list is sent", async () => {
      const planFingerprint = "ab".repeat(32);
      await controller.syncAccount(
        req(),
        BANK_ACCOUNT_ID,
        { planFingerprint, importKeys: ["a", "b"], excludeKeys: ["c"] },
        "UA",
      );
      expect(bankSync.syncAccount.mock.calls[0][3]).toBe(planFingerprint);
      expect(bankSync.syncAccount.mock.calls[0][4]).toEqual({
        importKeys: ["a", "b"],
        excludeKeys: ["c"],
      });

      // One list alone is a selection; the other is empty, not "everything".
      await controller.syncAccount(
        req(),
        BANK_ACCOUNT_ID,
        { importKeys: [] },
        "UA",
      );
      expect(bankSync.syncAccount.mock.calls[1][4]).toEqual({
        importKeys: [],
        excludeKeys: [],
      });
      await controller.syncAccount(
        req(),
        BANK_ACCOUNT_ID,
        { excludeKeys: ["c"] },
        "UA",
      );
      expect(bankSync.syncAccount.mock.calls[2][4]).toEqual({
        importKeys: [],
        excludeKeys: ["c"],
      });

      await controller.syncAccount(
        req(),
        BANK_ACCOUNT_ID,
        { planFingerprint },
        "UA",
      );
      await controller.syncAccount(req(), BANK_ACCOUNT_ID, undefined, "UA");
      expect(bankSync.syncAccount.mock.calls[3][4]).toBeUndefined();
      expect(bankSync.syncAccount.mock.calls[4][4]).toBeUndefined();
    });

    it("takes exceptions back for the caller's own bank account", async () => {
      bankSync.removeExceptions.mockResolvedValue({ removed: 2 });
      await expect(
        controller.removeExceptions(req(), BANK_ACCOUNT_ID, {
          keys: ["a", "b"],
        }),
      ).resolves.toEqual({ removed: 2 });
      expect(bankSync.removeExceptions).toHaveBeenCalledWith(
        USER_ID,
        BANK_ACCOUNT_ID,
        ["a", "b"],
      );
    });

    it("passes the preview's fingerprint to the sync, and a body-less sync passes none", async () => {
      const planFingerprint = "ab".repeat(32);
      await controller.syncAccount(
        req(),
        BANK_ACCOUNT_ID,
        { planFingerprint },
        "UA",
      );
      expect(bankSync.syncAccount.mock.calls[0][3]).toBe(planFingerprint);

      await controller.syncAccount(req(), BANK_ACCOUNT_ID, undefined, "UA");
      await controller.syncAccount(
        req(),
        BANK_ACCOUNT_ID,
        { planFingerprint: null },
        "UA",
      );
      expect(bankSync.syncAccount.mock.calls[1][3]).toBeUndefined();
      expect(bankSync.syncAccount.mock.calls[2][3]).toBeUndefined();
    });

    it("previews and matches as a user-present read, with the user from the JWT", async () => {
      await controller.previewAccount(req(), BANK_ACCOUNT_ID, "Mozilla/5.0");
      expect(bankSync.previewAccount).toHaveBeenCalledWith(
        USER_ID,
        BANK_ACCOUNT_ID,
        { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" },
      );
      await controller.matchAccounts(req(), CONNECTION_ID, "Mozilla/5.0");
      expect(connections.matchAccounts).toHaveBeenCalledWith(
        USER_ID,
        CONNECTION_ID,
        { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" },
      );
    });

    it("answers the link defaults for the account in the query", async () => {
      await controller.linkDefaults(req(), BANK_ACCOUNT_ID, {
        accountId: ACCOUNT_ID,
      });
      expect(bankSync.linkDefaults).toHaveBeenCalledWith(
        USER_ID,
        BANK_ACCOUNT_ID,
        ACCOUNT_ID,
      );
    });
  });

  describe("request validation (whitelist + forbidNonWhitelisted)", () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const accepts = (type: new () => object, value: unknown) =>
      pipe.transform(value, { type: "body", metatype: type });
    const query = (type: new () => object, value: unknown) =>
      pipe.transform(value, { type: "query", metatype: type });

    it("refuses an unknown field on the credentials body", async () => {
      await expect(
        accepts(SaveBankSyncCredentialsDto, {
          applicationId: "app",
          extra: 1,
        }),
      ).rejects.toBeDefined();
    });

    it("trims the application id and bounds it and the key", async () => {
      const ok = (await accepts(SaveBankSyncCredentialsDto, {
        applicationId: "  app-1  ",
      })) as SaveBankSyncCredentialsDto;
      expect(ok.applicationId).toBe("app-1");
      await expect(
        accepts(SaveBankSyncCredentialsDto, { applicationId: "a".repeat(101) }),
      ).rejects.toBeDefined();
      await expect(
        accepts(SaveBankSyncCredentialsDto, { applicationId: "   " }),
      ).rejects.toBeDefined();
      await expect(
        accepts(SaveBankSyncCredentialsDto, {
          applicationId: "app",
          privateKey: "k".repeat(20_000),
        }),
      ).rejects.toBeDefined();
    });

    it("does not strip anything from a PEM", async () => {
      const pem =
        "-----BEGIN PRIVATE KEY-----\nAAA+/=\n-----END PRIVATE KEY-----";
      const dto = (await accepts(SaveBankSyncCredentialsDto, {
        applicationId: "app",
        privateKey: pem,
      })) as SaveBankSyncCredentialsDto;
      expect(dto.privateKey).toBe(pem);
    });

    it("accepts only an upper-case ISO country in the institutions query", async () => {
      const ok = (await query(ListInstitutionsQueryDto, {
        country: " pl ",
      })) as ListInstitutionsQueryDto;
      expect(ok.country).toBe("PL");
      for (const bad of ["POL", "P1", "", undefined, ["PL", "DE"], { a: 1 }]) {
        await expect(
          query(ListInstitutionsQueryDto, { country: bad }),
        ).rejects.toBeDefined();
      }
    });

    it("validates the connection body: bounded name, country, psuType", async () => {
      const good = {
        institutionName: "Test Bank",
        country: "pl",
        psuType: "business",
      };
      const dto = (await accepts(
        CreateBankSyncConnectionDto,
        good,
      )) as CreateBankSyncConnectionDto;
      expect(dto.country).toBe("PL");
      for (const bad of [
        { ...good, psuType: "corporate" },
        { ...good, country: "POL" },
        { ...good, institutionName: "" },
        { ...good, institutionName: "x".repeat(256) },
        { ...good, validity: 400 },
      ]) {
        await expect(
          accepts(CreateBankSyncConnectionDto, bad),
        ).rejects.toBeDefined();
      }
    });

    it("bounds every field of the callback", async () => {
      await expect(
        accepts(BankSyncCallbackDto, { state: "s", code: "c" }),
      ).resolves.toBeDefined();
      const sanitized = (await accepts(BankSyncCallbackDto, {
        state: "s",
        error: "<b>denied</b>",
        errorDescription: "<script>x</script>",
      })) as BankSyncCallbackDto;
      expect(sanitized.error).toBe("bdenied/b");
      expect(sanitized.errorDescription).toBe("scriptx/script");
      for (const bad of [
        { state: "" },
        { state: "s".repeat(257) },
        { state: "s", code: "c".repeat(2049) },
        { state: "s", error: "e".repeat(201) },
        { state: "s", errorDescription: "d".repeat(1001) },
        { code: "c" },
      ]) {
        await expect(accepts(BankSyncCallbackDto, bad)).rejects.toBeDefined();
      }
    });

    it("requires autoSync to be a boolean when it is sent", async () => {
      await expect(
        accepts(UpdateBankSyncConnectionDto, { autoSync: false }),
      ).resolves.toBeDefined();
      await expect(
        accepts(UpdateBankSyncConnectionDto, { autoSync: "no" }),
      ).rejects.toBeDefined();
    });

    it("accepts exactly the three success modes", async () => {
      for (const notifySuccess of ["always", "when_imported", "never"]) {
        await expect(
          accepts(UpdateBankSyncConnectionDto, { notifySuccess }),
        ).resolves.toBeDefined();
      }
      for (const notifySuccess of ["sometimes", "", 1, null]) {
        await expect(
          accepts(UpdateBankSyncConnectionDto, { notifySuccess }),
        ).rejects.toBeDefined();
      }
    });

    it("requires tagOperationType to be a boolean when it is sent, and refuses null", async () => {
      for (const tagOperationType of [true, false]) {
        await expect(
          accepts(UpdateBankSyncConnectionDto, { tagOperationType }),
        ).resolves.toBeDefined();
      }
      for (const tagOperationType of ["no", 1, null]) {
        await expect(
          accepts(UpdateBankSyncConnectionDto, { tagOperationType }),
        ).rejects.toBeDefined();
      }
    });

    it("refuses a key it does not know", async () => {
      await expect(
        accepts(UpdateBankSyncConnectionDto, { status: "active" }),
      ).rejects.toBeDefined();
    });
  });

  describe("LinkBankSyncAccountDto", () => {
    const errorsOf = async (value: object) =>
      (
        await validate(plainToInstance(LinkBankSyncAccountDto, value), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property);

    it("accepts a UUID, or null to unlink", async () => {
      expect(await errorsOf({ accountId: ACCOUNT_ID })).toEqual([]);
      expect(await errorsOf({ accountId: null })).toEqual([]);
    });

    it("refuses an absent or malformed accountId: absent is neither link nor unlink", async () => {
      expect(await errorsOf({})).toEqual(["accountId"]);
      expect(await errorsOf({ accountId: "not-a-uuid" })).toEqual([
        "accountId",
      ]);
    });

    it("accepts a real calendar date, and a blank or null one as not chosen", async () => {
      expect(
        await errorsOf({ accountId: ACCOUNT_ID, syncFromDate: "2026-02-28" }),
      ).toEqual([]);
      expect(
        await errorsOf({ accountId: ACCOUNT_ID, syncFromDate: "" }),
      ).toEqual([]);
      expect(
        await errorsOf({ accountId: ACCOUNT_ID, syncFromDate: null }),
      ).toEqual([]);
    });

    it("refuses a date that names no day", async () => {
      for (const bad of ["2026-02-30", "26-01-01", "yesterday", 20260101]) {
        expect(
          await errorsOf({ accountId: ACCOUNT_ID, syncFromDate: bad }),
        ).toEqual(["syncFromDate"]);
      }
    });
  });

  describe("SyncBankSyncAccountDto", () => {
    const errorsOf = async (value: object) =>
      (
        await validate(plainToInstance(SyncBankSyncAccountDto, value), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property);

    it("accepts no fingerprint, a null or blank one, and a SHA-256 hex digest", async () => {
      expect(await errorsOf({})).toEqual([]);
      expect(await errorsOf({ planFingerprint: null })).toEqual([]);
      expect(await errorsOf({ planFingerprint: "" })).toEqual([]);
      expect(await errorsOf({ planFingerprint: "0f".repeat(32) })).toEqual([]);
    });

    it("refuses anything else: wrong length, upper case, non-hex, a non-string, an unknown field", async () => {
      for (const bad of [
        "0f".repeat(31),
        "0f".repeat(33),
        "0F".repeat(32),
        "zz".repeat(32),
        12345,
        ["0f".repeat(32)],
      ]) {
        expect(await errorsOf({ planFingerprint: bad })).toEqual([
          "planFingerprint",
        ]);
      }
      expect(await errorsOf({ other: true })).toEqual(["other"]);
    });

    describe("the selection (spec section 7b)", () => {
      it("accepts either list, both, or none", async () => {
        expect(await errorsOf({ importKeys: ["a"] })).toEqual([]);
        expect(await errorsOf({ excludeKeys: ["a"] })).toEqual([]);
        expect(await errorsOf({ importKeys: [], excludeKeys: [] })).toEqual([]);
        expect(
          await errorsOf({
            planFingerprint: "0f".repeat(32),
            importKeys: ["ref:a", "hash:b:0"],
            excludeKeys: ["ref:c"],
          }),
        ).toEqual([]);
      });

      it("bounds each list to 5000 keys", async () => {
        const keys = (n: number) =>
          Array.from({ length: n }, (_, i) => `k${i}`);
        expect(await errorsOf({ importKeys: keys(MAX_SYNC_KEYS) })).toEqual([]);
        expect(await errorsOf({ importKeys: keys(MAX_SYNC_KEYS + 1) })).toEqual(
          ["importKeys"],
        );
        expect(
          await errorsOf({ excludeKeys: keys(MAX_SYNC_KEYS + 1) }),
        ).toEqual(["excludeKeys"]);
      });

      it("bounds each key to 255 characters and refuses an empty or a non-string key", async () => {
        expect(await errorsOf({ importKeys: ["k".repeat(255)] })).toEqual([]);
        for (const bad of [["k".repeat(256)], [""], [5], [null], "ref:a", {}]) {
          expect(await errorsOf({ importKeys: bad })).toEqual(["importKeys"]);
          expect(await errorsOf({ excludeKeys: bad })).toEqual(["excludeKeys"]);
        }
      });

      it("refuses an explicit null: it is not the same as no selection", async () => {
        expect(await errorsOf({ importKeys: null })).toEqual(["importKeys"]);
        expect(await errorsOf({ excludeKeys: null })).toEqual(["excludeKeys"]);
      });
    });
  });

  describe("RemoveBankSyncExceptionsDto", () => {
    const errorsOf = async (value: object) =>
      (
        await validate(plainToInstance(RemoveBankSyncExceptionsDto, value), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property);

    it("takes between one and 5000 keys of at most 255 characters", async () => {
      expect(await errorsOf({ keys: ["a"] })).toEqual([]);
      expect(await errorsOf({ keys: ["k".repeat(255)] })).toEqual([]);
      expect(
        await errorsOf({
          keys: Array.from({ length: MAX_SYNC_KEYS }, (_, i) => `k${i}`),
        }),
      ).toEqual([]);
      for (const bad of [
        [],
        Array.from({ length: MAX_SYNC_KEYS + 1 }, (_, i) => `k${i}`),
        ["k".repeat(256)],
        [""],
        [1],
        "a",
        null,
        undefined,
      ]) {
        expect(await errorsOf({ keys: bad })).toEqual(["keys"]);
      }
    });

    it("refuses a field it does not know", async () => {
      expect(await errorsOf({ keys: ["a"], other: 1 })).toEqual(["other"]);
    });
  });

  describe("LinkDefaultsQueryDto", () => {
    const errorsOf = async (value: object) =>
      (
        await validate(plainToInstance(LinkDefaultsQueryDto, value), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property);

    it("requires the account to be a UUID", async () => {
      expect(await errorsOf({ accountId: ACCOUNT_ID })).toEqual([]);
      expect(await errorsOf({})).toEqual(["accountId"]);
      expect(await errorsOf({ accountId: "nope" })).toEqual(["accountId"]);
      // A repeated key arrives as an array and is refused, not coerced.
      expect(await errorsOf({ accountId: [ACCOUNT_ID, ACCOUNT_ID] })).toEqual([
        "accountId",
      ]);
    });
  });
});
