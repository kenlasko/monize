import {
  Controller,
  Get,
  Query,
  ValidationPipe,
  INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ReportingDetailsQueryDto } from "./dto/reporting-details-query.dto";

// Exercise Express's real query parser and Nest validation, rather than hand-built DTOs.
@Controller("details")
class DetailsController {
  @Get() read(@Query() query: ReportingDetailsQueryDto) {
    return query;
  }
}
describe("recognition details HTTP query boundary", () => {
  let app: INestApplication;
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const dates = "startDate=2026-10-01&endDate=2026-10-31&basis=accrual";
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DetailsController],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => app?.close());
  it.each([
    "sourceTransactionIds",
    "accountIds",
    "categoryIds",
    "payeeIds",
    "tagIds",
  ])("preserves one and multiple %s values", async (field) => {
    const one = await request(app.getHttpServer())
      .get(`/details?${dates}&${field}=${id}`)
      .expect(200);
    expect(one.body[field]).toEqual([id]);
    const many = await request(app.getHttpServer())
      .get(`/details?${dates}&${field}=${id}&${field}=${other}`)
      .expect(200);
    expect(many.body[field]).toEqual([id, other]);
  });
  it.each([
    "categoryIds=bad",
    "categoryIds=",
    "categoryIds[0]=bad",
    "categoryIds[]=bad",
    "limit=5001",
    "basis=cash&basis=accrual",
  ])("rejects malformed query %s", async (query) => {
    await request(app.getHttpServer())
      .get(`/details?${dates}&${query}`)
      .expect(400);
  });
  it("retains the selection bound", async () => {
    await request(app.getHttpServer())
      .get(
        `/details?${dates}&${Array(201).fill(`categoryIds=${id}`).join("&")}`,
      )
      .expect(400);
  });
});
