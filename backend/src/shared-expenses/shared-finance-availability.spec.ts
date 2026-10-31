import { INestApplication } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { SharedFinanceController } from "./shared-finance.controller";
import { SharedEntryFinanceController } from "./shared-entry-finance.controller";
import { SharedFinanceService } from "./shared-finance.service";
import { SharedEntryFinanceService } from "./shared-entry-finance.service";
import { SharedNotificationsInterceptor } from "./shared-notifications.interceptor";

const group = "11111111-1111-4111-8111-111111111111";
const entry = "22222222-2222-4222-8222-222222222222";
const base = `/shared-expenses/groups/${group}`;

describe("Group-only delivery HTTP boundary", () => {
  let app: INestApplication;
  const finance: Partial<jest.Mocked<SharedFinanceService>> = {
    enable: jest.fn(),
    preview: jest.fn(),
    book: jest.fn(),
    overview: jest.fn(),
    unlink: jest.fn(),
  };
  const combined: Partial<jest.Mocked<SharedEntryFinanceService>> = {
    preview: jest.fn(),
    save: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SharedFinanceController, SharedEntryFinanceController],
      providers: [
        { provide: SharedFinanceService, useValue: finance },
        { provide: SharedEntryFinanceService, useValue: combined },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideInterceptor(SharedNotificationsInterceptor)
      .useValue({
        intercept: (_context: unknown, next: { handle: () => unknown }) =>
          next.handle(),
      })
      .compile();
    app = module.createNestApplication();
    app.use(
      (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
        req.user = { id: "owner" };
        next();
      },
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    "/finances/enable",
    `/finances/entries/${entry}/preview`,
    `/finances/entries/${entry}/book`,
    "/entry-finances/preview",
    "/entry-finances",
  ])("refuses %s before any finance service runs", async (path) => {
    await request(app.getHttpServer())
      .post(base + path)
      .send({})
      .expect(409);
    for (const method of [
      ...Object.values(finance),
      ...Object.values(combined),
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("retains authenticated reads and explicit unlink for existing records", async () => {
    await request(app.getHttpServer()).get(`${base}/finances`).expect(200);
    expect(finance.overview).toHaveBeenCalledWith("owner", group);
    const command = { operationId: entry, expectedRevision: 2 };
    await request(app.getHttpServer())
      .post(`${base}/finances/entries/${entry}/unlink`)
      .send(command)
      .expect(201);
    expect(finance.unlink).toHaveBeenCalledWith("owner", group, entry, command);
  });
});
