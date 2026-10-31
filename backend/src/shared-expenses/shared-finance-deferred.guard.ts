import { CanActivate, ConflictException, Injectable } from "@nestjs/common";
import { tr } from "../i18n/translate";

/** Keep the first delivery group-only; legacy reads and unlink remain available. */
@Injectable()
export class SharedFinanceDeferredGuard implements CanActivate {
  canActivate(): never {
    throw new ConflictException(
      tr(
        "sharedExpenses.financeDeferred",
        "New personal-finance connections are unavailable in this version. Keep recording expenses in the group; existing personal records can still be viewed or unlinked.",
      ),
    );
  }
}
