import { ApiResponse } from "@nestjs/swagger";
import {
  Controller,
  Get,
  Post,
  Body,
  INestApplication,
  ServiceUnavailableException,
  Logger,
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import request from "supertest";
import { ReportingEndpoint } from "./reporting-endpoint";
import { ReportingBasisInterceptor } from "./reporting-basis.interceptor";
import { currentReportingRead } from "./reporting-basis";
import { ExecuteReportDto } from "../reports/dto/execute-report.dto";
import { httpErrorBody } from "../common/filters/http-error-body";
import { safeToolError } from "../mcp/mcp-context";
import { reportingFailure } from "./reporting-errors";
import { exportReport } from "./reporting-export";
import { validateToolInput } from "../ai/query/tool-input-schemas";

jest.mock("../common/db/scoped-db", () => ({
  withScopedDb: async (source: any, fn: any) => fn(source.manager),
}));
@Controller("reporting-contract")
class ContractController {
  @Get()
  @ReportingEndpoint()
  @ApiResponse({
    status: 200,
    description: "Existing success schema",
    schema: { type: "object", properties: { basis: { type: "string" } } },
  })
  read() {
    return {
      basis: currentReportingRead("owner")?.basis,
      currency: currentReportingRead("owner")?.currency,
    };
  }
  @Get("cash") @ReportingEndpoint("cash") cash() {
    return {
      basis: currentReportingRead("owner")?.basis,
      currency: currentReportingRead("owner")?.currency,
    };
  }
  @Post() @ReportingEndpoint() execute(@Body() _options: ExecuteReportDto) {
    return {
      basis: currentReportingRead("owner")?.basis,
      currency: currentReportingRead("owner")?.currency,
    };
  }
  @Get("missing") @ReportingEndpoint() missing() {
    throw new ServiceUnavailableException({
      code: "REPORTING_FX_INCOMPLETE",
      fxComplete: false,
      missingRatePairs: [{ from: "USD", to: "EUR", date: "2026-06-30" }],
      repair: "currency_rate_history",
      fetchAttempted: false,
      stack: "private stack",
    });
  }
}
@Catch()
class ContractFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const body = httpErrorBody(error, new Logger("Contract"));
    response.status(body.statusCode).json(body);
  }
}
describe("Reporting HTTP, agent-schema and safe export contracts", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ContractController],
      providers: [
        ReportingBasisInterceptor,
        {
          provide: DataSource,
          useValue: {
            manager: {
              query: async () => [{ present: false }],
              getRepository: () => ({
                findOne: async () => ({
                  reportingBasis: "accrual",
                  accrualEnabled: true,
                  defaultCurrency: "EUR",
                }),
              }),
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = { id: "owner" };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new ContractFilter());
    await app.init();
  });
  afterAll(async () => app?.close());
  it("preserves the existing success schema when adding basis documentation", () => {
    const response = Reflect.getMetadata(
      "swagger/apiResponse",
      ContractController.prototype.read,
    )[200];
    expect(response.description).toBe("Existing success schema");
    expect(response.schema.properties.basis.type).toBe("string");
    expect(response.headers["X-Reporting-Basis"]).toBeDefined();
  });
  it("resolves omitted preference and reports explicit overrides in body and headers", async () => {
    const preferred = await request(app.getHttpServer())
      .get("/reporting-contract")
      .expect(200);
    expect(preferred.body.basis).toBe("accrual");
    expect(preferred.headers["x-reporting-basis"]).toBe("accrual");
    expect(preferred.headers["x-reporting-currency"]).toBe("EUR");
    const cash = await request(app.getHttpServer())
      .get("/reporting-contract?basis=cash")
      .expect(200);
    expect(cash.body.basis).toBe("cash");
    expect(cash.headers["x-reporting-basis"]).toBe("cash");
  });
  it.each(["basis=bad", "basis=cash&basis=accrual", "basis[]=cash"])(
    "refuses malformed/repeated basis %s",
    async (query) => {
      await request(app.getHttpServer())
        .get(`/reporting-contract?${query}`)
        .expect(400);
    },
  );
  it("accepts body basis and refuses conflicting query/body values", async () => {
    const cash = await request(app.getHttpServer())
      .post("/reporting-contract")
      .send({ basis: "cash" })
      .expect(201);
    expect(cash.body.basis).toBe("cash");
    await request(app.getHttpServer())
      .post("/reporting-contract?basis=accrual")
      .send({ basis: "cash" })
      .expect(400);
  });
  it("declares a cash-only endpoint honestly and refuses an incompatible override", async () => {
    const cash = await request(app.getHttpServer())
      .get("/reporting-contract/cash")
      .expect(200);
    expect(cash.headers["x-reporting-basis"]).toBe("cash");
    await request(app.getHttpServer())
      .get("/reporting-contract/cash?basis=accrual")
      .expect(400);
  });
  it("preserves approved dated repair metadata through the HTTP filter and MCP error boundary", async () => {
    const response = await request(app.getHttpServer())
      .get("/reporting-contract/missing")
      .expect(503);
    expect(response.body.reporting).toMatchObject({
      code: "REPORTING_FX_INCOMPLETE",
      repair: "currency_rate_history",
      missingRatePairs: [{ from: "USD", to: "EUR", date: "2026-06-30" }],
    });
    expect(JSON.stringify(response.body)).not.toContain("private stack");
    const error = new ServiceUnavailableException({
      code: "REPORTING_FX_INCOMPLETE",
      fxComplete: false,
      missingRatePairs: ["USD->EUR"],
      stack: "private stack",
    });
    expect(safeToolError(error)).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "REPORTING_FX_INCOMPLETE",
          repair: "currency_rate_history",
        },
      },
    });
    expect(
      reportingFailure(new ServiceUnavailableException("private stack")),
    ).toBeNull();
    expect(
      JSON.stringify(safeToolError(new Error("private stack"))),
    ).not.toContain("private stack");
  });
  it("accepts only supported agent basis choices while preserving cash-only register semantics", () => {
    for (const name of [
      "generate_report",
      "compare_periods",
      "get_budget_status",
    ]) {
      const input =
        name === "generate_report" ? { type: "spending_by_category" } : {};
      expect(validateToolInput(name, { ...input, basis: "cash" }).success).toBe(
        true,
      );
      expect(
        validateToolInput(name, { ...input, basis: "accrual" }).success,
      ).toBe(true);
      expect(
        validateToolInput(name, { ...input, basis: ["cash"] }).success,
      ).toBe(false);
    }
    expect(
      validateToolInput("list_transactions", { basis: "accrual" }).success,
    ).toBe(false);
  });
  it("escapes CSV formulas without turning numeric amounts into text or omitting basis", () => {
    const report = exportReport({
      basis: "accrual",
      currency: "USD",
      fxComplete: true,
      reportId: "test",
      name: "test",
      viewType: "TABLE",
      groupBy: "NONE",
      timeframe: {
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        label: "June",
      },
      data: [{ label: "=SUM(A1:A2)", value: -1.2345 }],
      summary: {
        total: -1.2345,
        knownTotal: -1.2345,
        count: 1,
        average: -1.2345,
      },
      missingCurrencies: [],
      excludedCount: 0,
    });
    expect(report.csv).toContain("accrual,USD,true,'=SUM(A1:A2),-1.2345");
  });
});
