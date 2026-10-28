import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ParseEnumPipe,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { defer, lastValueFrom } from "rxjs";
import {
  currentReportingRead,
  withReportingRead,
  type ReportingBasis,
} from "./reporting-basis";
const BASIS_VALUES = { cash: "cash", accrual: "accrual" };
@Injectable()
export class ReportingBasisInterceptor implements NestInterceptor {
  constructor(private readonly dataSource: DataSource) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    return defer(async () => {
      const request = context.switchToHttp().getRequest();
      if (
        Object.keys(request.query ?? {}).some((key) => key.startsWith("basis["))
      )
        throw new BadRequestException({ code: "REPORTING_BASIS_INVALID" });
      const queryBasis = request.query?.basis,
        bodyBasis = request.body?.basis;
      if (
        queryBasis !== undefined &&
        bodyBasis !== undefined &&
        queryBasis !== bodyBasis
      )
        throw new BadRequestException({ code: "REPORTING_BASIS_CONFLICT" });
      const fixed = Reflect.getMetadata(
        "reportingFixedBasis",
        context.getHandler(),
      );
      const basis = (await new ParseEnumPipe(BASIS_VALUES, {
        optional: true,
      }).transform(queryBasis ?? bodyBasis, {
        type: "query",
        data: "basis",
        metatype: String,
      })) as ReportingBasis | undefined;
      if (fixed && basis !== undefined && basis !== fixed)
        throw new BadRequestException({
          code: "REPORTING_BASIS_UNSUPPORTED",
          allowed: [fixed],
        });
      let selectedCurrency: string | undefined;
      let selectedBasis: ReportingBasis | undefined;
      const result = await withReportingRead(
        this.dataSource,
        request.user.id,
        async () => {
          selectedBasis = currentReportingRead(request.user.id)?.basis;
          selectedCurrency = undefined;
          const value = await lastValueFrom(next.handle());
          selectedCurrency = currentReportingRead(
            request.user.id,
          )?.resultCurrency;
          return value;
        },
        basis ?? fixed,
      );
      const resolved =
        result && typeof result === "object" && "basis" in result
          ? result.basis
          : selectedBasis;
      if (resolved)
        context
          .switchToHttp()
          .getResponse()
          .setHeader("X-Reporting-Basis", resolved);
      const body =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, any>)
          : undefined;
      const nativeCodes =
        body?.byCurrency && typeof body.byCurrency === "object"
          ? Object.keys(body.byCurrency)
          : [];
      const currency =
        body?.currency ??
        body?.budget?.currencyCode ??
        selectedCurrency ??
        (nativeCodes.length === 1 ? nativeCodes[0] : undefined);
      if (typeof currency === "string")
        context
          .switchToHttp()
          .getResponse()
          .setHeader("X-Reporting-Currency", currency);
      return result;
    });
  }
}
