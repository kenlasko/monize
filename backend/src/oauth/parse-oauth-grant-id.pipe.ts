import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { tr } from "../i18n/translate";

/**
 * An OAuth grant id from the path: oidc-provider mints them as URL-safe
 * nanoids (43 characters today), and the column holding them is 255 wide.
 * Not a UUID, so `ParseUUIDPipe` does not apply; a value of any other shape is
 * refused before it reaches a query.
 */
@Injectable()
export class ParseOAuthGrantIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(value)) {
      throw new BadRequestException(
        tr("errors.oauth.invalidConnectionId", "Invalid connected app id"),
      );
    }
    return value;
  }
}
