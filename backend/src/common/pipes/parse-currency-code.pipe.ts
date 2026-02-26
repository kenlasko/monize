import { PipeTransform, Injectable, BadRequestException } from "@nestjs/common";

/**
 * Validates a currency code parameter: exactly 3 uppercase letters (ISO 4217).
 */
@Injectable()
export class ParseCurrencyCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== "string") {
      throw new BadRequestException("Currency code must be a string");
    }
    const upper = value.toUpperCase();
    if (!/^[A-Z]{3}$/.test(upper)) {
      throw new BadRequestException(
        "Currency code must be exactly 3 letters (e.g., USD, CAD)",
      );
    }
    return upper;
  }
}
