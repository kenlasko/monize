import { applyDecorators, SetMetadata, UseInterceptors } from "@nestjs/common";
import { ApiQuery } from "@nestjs/swagger";
import { ReportingBasisInterceptor } from "./reporting-basis.interceptor";
export const REPORTING_FIXED_BASIS = "reportingFixedBasis";
/** Add the basis declaration without replacing an endpoint's existing response schema. */
export function ReportingEndpoint(fixed?: "cash"): MethodDecorator {
  return (target, key, descriptor) => {
    const method = descriptor.value as unknown as object;
    const responses = Reflect.getMetadata("swagger/apiResponse", method) ?? {};
    const success = responses[200] ?? {};
    applyDecorators(
      SetMetadata(REPORTING_FIXED_BASIS, fixed),
      UseInterceptors(ReportingBasisInterceptor),
      ApiQuery({
        name: "basis",
        required: false,
        enum: fixed ? [fixed] : ["cash", "accrual"],
        description: fixed
          ? "Cash-only read."
          : "Omit to use your reporting preference.",
      }),
    )(target, key, descriptor);
    Reflect.defineMetadata(
      "swagger/apiResponse",
      {
        ...responses,
        200: {
          ...success,
          headers: {
            ...success.headers,
            "X-Reporting-Basis": {
              schema: { type: "string", enum: ["cash", "accrual"] },
            },
            "X-Reporting-Currency": { schema: { type: "string" } },
          },
        },
      },
      method,
    );
  };
}
