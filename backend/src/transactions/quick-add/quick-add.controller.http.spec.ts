import { INestApplication } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { AuthGuard } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createGlobalValidationPipe } from "../../common/pipes/global-validation.pipe";
import { CrossOwnerAccessService } from "../../delegation/cross-owner-access.service";
import { DelegationService } from "../../delegation/delegation.service";
import { AccountDelegateGuard } from "../../delegation/guards/account-delegate.guard";
import { QuickAddPinsDto } from "./dto/quick-add-interpret.dto";
import { QuickAddController } from "./quick-add.controller";
import { QuickAddInterpretService } from "./quick-add-interpret.service";
import type { QuickAddInterpretation } from "./quick-add.types";

const USER = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const PATH = "/transactions/quick-add/interpret";

/** The bearer the stub `JwtService` reads as an acting delegate's. */
const DELEGATE_TOKEN = "delegate-token";

/**
 * `POST /transactions/quick-add/interpret` through the real request pipeline:
 * the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`,
 * `transform`) that `main.ts` registers, and `AccountDelegateGuard`, the global
 * guard that refuses an acting delegate on a route without `@AllowDelegate()`.
 * Calling the controller method directly skips both.
 */
describe("POST /transactions/quick-add/interpret over HTTP", () => {
  let app: INestApplication;
  const interpretation = { blockers: [] } as unknown as QuickAddInterpretation;
  const quickAdd: Pick<jest.Mocked<QuickAddInterpretService>, "interpret"> = {
    interpret: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [QuickAddController],
      providers: [{ provide: QuickAddInterpretService, useValue: quickAdd }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(
      (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
        req.user = { id: USER };
        next();
      },
    );
    const jwt = {
      verify: (token: string) =>
        token === DELEGATE_TOKEN
          ? { sub: USER, actingAsUserId: OWNER, delegationId: "grant-1" }
          : { sub: USER },
    };
    app.useGlobalGuards(
      new AccountDelegateGuard(
        new Reflector(),
        jwt as unknown as JwtService,
        {} as DelegationService,
        {} as CrossOwnerAccessService,
      ),
    );
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    quickAdd.interpret.mockReset();
    quickAdd.interpret.mockResolvedValue(interpretation);
  });

  const valid = { text: "84.37 loblaws", today: "2026-11-20" };

  it("answers 200 with the reading, for the JWT's user", async () => {
    const res = await request(app.getHttpServer())
      .post(PATH)
      .send({
        ...valid,
        contextAccountId: ACCOUNT,
        pins: { kind: "payment", amount: 12.5, accountId: ACCOUNT },
      })
      .expect(200);
    expect(res.body).toEqual(interpretation);
    expect(quickAdd.interpret).toHaveBeenCalledTimes(1);
    const [userId, dto] = quickAdd.interpret.mock.calls[0];
    expect(userId).toBe(USER);
    expect(dto).toMatchObject({ ...valid, contextAccountId: ACCOUNT });
    expect(dto.pins).toBeInstanceOf(QuickAddPinsDto);
    expect(dto.pins).toMatchObject({ kind: "payment", amount: 12.5 });
  });

  it("takes an empty line and blank optional fields", async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .send({
        text: "",
        today: valid.today,
        contextAccountId: "",
        pins: { kind: null, accountId: "", payeeName: "" },
      })
      .expect(200);
    expect(quickAdd.interpret).toHaveBeenCalledTimes(1);
  });

  it("hands the service the fields a reader cleared", async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .send({ ...valid, pins: { clear: ["payee", "category"] } })
      .expect(200);
    expect(quickAdd.interpret.mock.calls[0][1].pins?.clear).toEqual([
      "payee",
      "category",
    ]);
  });

  it("hands the service the line with angle brackets stripped", async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .send({ ...valid, text: "12 <b>shop</b>" })
      .expect(200);
    expect(quickAdd.interpret.mock.calls[0][1].text).toBe("12 bshop/b");
  });

  it.each([
    ["a line over 200 characters", { ...valid, text: "x".repeat(201) }],
    [
      "a line over 200 characters once normalized (U+FDFA is 18)",
      { ...valid, text: "\uFDFA".repeat(200) },
    ],
    [
      "a cleared field it does not know",
      { ...valid, pins: { clear: ["memo"] } },
    ],
    ["cleared fields that are no list", { ...valid, pins: { clear: "payee" } }],
    [
      "more cleared fields than there are",
      { ...valid, pins: { clear: ["payee", "category", "payee"] } },
    ],
    ["no line", { today: valid.today }],
    ["no today", { text: valid.text }],
    ["a today that is no calendar day", { ...valid, today: "2026-02-30" }],
    ["a context account that is no UUID", { ...valid, contextAccountId: "x" }],
    ["pins that are a list", { ...valid, pins: [{ kind: "payment" }] }],
    ["an unknown kind", { ...valid, pins: { kind: "refund" } }],
    ["a pinned amount of zero", { ...valid, pins: { amount: 0 } }],
    ["a pinned amount as text", { ...valid, pins: { amount: "12.50" } }],
    [
      "a pinned account that is no UUID",
      { ...valid, pins: { accountId: "x" } },
    ],
    ["an undeclared pin", { ...valid, pins: { memo: "x" } }],
    ["a user id in the body", { ...valid, userId: OWNER }],
  ])("refuses %s with 400 before the service runs", async (_label, body) => {
    await request(app.getHttpServer()).post(PATH).send(body).expect(400);
    expect(quickAdd.interpret).not.toHaveBeenCalled();
  });

  it("refuses an acting delegate with 403", async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .set("Authorization", `Bearer ${DELEGATE_TOKEN}`)
      .send(valid)
      .expect(403);
    expect(quickAdd.interpret).not.toHaveBeenCalled();
  });

  it("serves the reader acting as themselves", async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .set("Authorization", "Bearer own-token")
      .send(valid)
      .expect(200);
    expect(quickAdd.interpret).toHaveBeenCalledWith(
      USER,
      expect.objectContaining(valid),
    );
  });
});
