import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { toolResult, toolError } from "../mcp-context";
import {
  executeCalculation,
  executeConversion,
  CONVERT_OPERATION,
} from "../../ai/query/calculate-tool";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";
import { calculateOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";
import { isoDateSchema, numberArg } from "../../common/tool-schemas";

@Injectable()
export class McpCalculateTools {
  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  register(server: McpServer) {
    server.registerTool(
      "calculate",
      {
        title: "Calculate",
        annotations: READ_ONLY,
        description:
          "Server-side arithmetic on numbers from previous tool results, and " +
          "currency conversion at the server's rate for a date. Never do the " +
          "maths or convert currencies yourself: `convert` returns the " +
          "converted amount with the rate and its date -- quote both. " +
          "`result` is unrounded; `formattedResult` is for display.",
        inputSchema: z.object({
          operation: z
            .enum([
              "percentage",
              "difference",
              "ratio",
              "sum",
              "average",
              CONVERT_OPERATION,
            ])
            .describe(
              "percentage: (values[0]/values[1])*100. difference: values[0]-values[1]. ratio: values[0]/values[1]. sum and average take every value. convert: values[0] from fromCurrency to toCurrency at the rate on date.",
            ),
          values: z
            .array(numberArg())
            .min(1)
            .max(100)
            .describe("Numbers to calculate with; convert takes [amount]"),
          fromCurrency: z
            .string()
            .max(3)
            .optional()
            .describe("convert: ISO 4217 code the amount is in"),
          toCurrency: z
            .string()
            .max(3)
            .optional()
            .describe("convert: ISO 4217 code to convert into"),
          date: isoDateSchema
            .optional()
            .describe("convert: YYYY-MM-DD of the rate; today if omitted"),
          label: z
            .string()
            .max(200)
            .optional()
            .describe("Optional label (e.g., 'savings rate')"),
        }),
        outputSchema: calculateOutput,
      },
      async (args) => {
        // Same two entry points the AI Assistant's executor uses, so both
        // surfaces refuse the same shapes and price a pair the same way.
        const result =
          args.operation === CONVERT_OPERATION
            ? await executeConversion(
                {
                  values: args.values,
                  fromCurrency: args.fromCurrency,
                  toCurrency: args.toCurrency,
                  date: args.date,
                  label: args.label,
                },
                this.exchangeRateService,
              )
            : executeCalculation({
                operation: args.operation,
                values: args.values,
                label: args.label,
              });

        if ("error" in result) {
          return toolError(result.error);
        }

        return toolResult(result);
      },
    );
  }
}
