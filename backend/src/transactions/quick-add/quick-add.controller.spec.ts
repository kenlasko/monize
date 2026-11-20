import "reflect-metadata";
import { ForbiddenException, RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { JwtService } from "@nestjs/jwt";
import { AccountDelegateGuard } from "../../delegation/guards/account-delegate.guard";
import { DelegationService } from "../../delegation/delegation.service";
import { CrossOwnerAccessService } from "../../delegation/cross-owner-access.service";
import { ALLOW_PAT_KEY } from "../../auth/pat-access/pat-access.decorator";
import { TransactionsController } from "../transactions.controller";
import { TransactionsModule } from "../transactions.module";
import { QuickAddController } from "./quick-add.controller";
import { QuickAddInterpretService } from "./quick-add-interpret.service";
import { QuickAddInterpretDto } from "./dto/quick-add-interpret.dto";
import type { QuickAddInterpretation } from "./quick-add.types";

const ROUTE = ["transactions", "quick-add", "interpret"];

// The metadata keys @nestjs/throttler's @Throttle writes per throttler name
// (its THROTTLER_LIMIT / THROTTLER_TTL constants, not exported by the package).
const THROTTLER_LIMIT = "THROTTLER:LIMIT";
const THROTTLER_TTL = "THROTTLER:TTL";

/** Every `POST` route of a controller, as path segments. */
function postRoutes(controller: { prototype: object }): string[][] {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
  return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = (controller.prototype as Record<string, unknown>)[name];
    if (typeof handler !== "function") return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler);
    const path = Reflect.getMetadata(PATH_METADATA, handler);
    if (method !== RequestMethod.POST || path === undefined) return [];
    return [
      [base, String(path)]
        .join("/")
        .split("/")
        .filter((segment) => segment !== ""),
    ];
  });
}

/** Whether `route` would answer a request for `literal`. */
function matches(route: string[], literal: string[]): boolean {
  return (
    route.length === literal.length &&
    route.every(
      (segment, i) => segment.startsWith(":") || segment === literal[i],
    )
  );
}

describe("QuickAddController", () => {
  const interpretation = { blockers: [] } as unknown as QuickAddInterpretation;
  let service: Pick<jest.Mocked<QuickAddInterpretService>, "interpret">;
  let controller: QuickAddController;

  beforeEach(() => {
    service = { interpret: jest.fn().mockResolvedValue(interpretation) };
    controller = new QuickAddController(
      service as unknown as QuickAddInterpretService,
    );
  });

  it("reads for the JWT's user, with the body as sent", async () => {
    const dto = Object.assign(new QuickAddInterpretDto(), {
      text: "84.37 loblaws",
      today: "2026-11-20",
    });
    await expect(
      controller.interpret({ user: { id: "user-1" } }, dto),
    ).resolves.toBe(interpretation);
    expect(service.interpret).toHaveBeenCalledWith("user-1", dto);
  });

  it("is POST /transactions/quick-add/interpret, answering 200", () => {
    expect(postRoutes(QuickAddController)).toEqual([ROUTE]);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        QuickAddController.prototype.interpret,
      ),
    ).toBe(200);
  });

  it("carries its own ceiling of 120 readings a minute", () => {
    const handler = QuickAddController.prototype.interpret;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(120);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(
      60_000,
    );
  });

  it("sits behind AuthGuard('jwt') and is not open to personal access tokens", () => {
    // `AuthGuard(type)` is memoized per type: the same class TransactionsController uses.
    expect(Reflect.getMetadata(GUARDS_METADATA, QuickAddController)).toEqual([
      AuthGuard("jwt"),
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, TransactionsController),
    ).toEqual([AuthGuard("jwt")]);
    expect(
      Reflect.getMetadata(ALLOW_PAT_KEY, QuickAddController),
    ).toBeUndefined();
  });

  it("is refused to an acting delegate by AccountDelegateGuard", async () => {
    const jwt = {
      verify: jest.fn().mockReturnValue({
        sub: "d1111111-1111-4111-8111-111111111111",
        actingAsUserId: "01111111-1111-4111-8111-111111111111",
        delegationId: "g1",
      }),
    };
    const guard = new AccountDelegateGuard(
      new Reflector(),
      jwt as unknown as JwtService,
      {} as DelegationService,
      {} as CrossOwnerAccessService,
    );
    const context = {
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: "Bearer token" } }),
      }),
      getHandler: () => QuickAddController.prototype.interpret,
      getClass: () => QuickAddController,
    };
    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("is not shadowed by a TransactionsController route", () => {
    const shadowing = postRoutes(TransactionsController).filter((route) =>
      matches(route, ROUTE),
    );
    expect(shadowing).toEqual([]);
    // The check can see a shadow: `POST transactions/:id/interpret` would be one.
    expect(matches(["transactions", ":id", "interpret"], ROUTE)).toBe(true);
    expect(postRoutes(TransactionsController).length).toBeGreaterThan(10);
  });

  it("is registered before TransactionsController", () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      TransactionsModule,
    );
    expect(controllers.indexOf(QuickAddController)).toBeLessThan(
      controllers.indexOf(TransactionsController),
    );
    expect(controllers.indexOf(QuickAddController)).toBeGreaterThanOrEqual(0);
  });
});
