import { PipeTransform, Injectable, BadRequestException } from "@nestjs/common";

/**
 * Validates a security symbol parameter: max 20 chars, alphanumeric + dots/dashes.
 */
@Injectable()
export class ParseSymbolPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 20) {
      throw new BadRequestException(
        "Symbol must be between 1 and 20 characters",
      );
    }
    if (!/^[A-Za-z0-9.-]+$/.test(value)) {
      throw new BadRequestException(
        "Symbol must contain only letters, digits, dots, or dashes",
      );
    }
    return value;
  }
}
