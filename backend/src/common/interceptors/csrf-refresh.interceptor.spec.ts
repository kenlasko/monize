import { CallHandler, ExecutionContext } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { of } from "rxjs";
import { CsrfRefreshInterceptor } from "./csrf-refresh.interceptor";

describe("CsrfRefreshInterceptor", () => {
  let interceptor: CsrfRefreshInterceptor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CsrfRefreshInterceptor],
    }).compile();

    interceptor = module.get<CsrfRefreshInterceptor>(CsrfRefreshInterceptor);
  });

  function createMockContext(overrides: {
    cookies?: Record<string, string>;
    headersSent?: boolean;
  }): {
    context: ExecutionContext;
    response: { cookie: jest.Mock; headersSent: boolean };
  } {
    const response = {
      cookie: jest.fn(),
      headersSent: overrides.headersSent ?? false,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          cookies: overrides.cookies ?? {},
        }),
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;

    return { context, response };
  }

  function createMockCallHandler(): CallHandler {
    return {
      handle: () => of("response-data"),
    };
  }

  it("refreshes CSRF cookie when user is authenticated and has csrf_token", (done) => {
    const csrfToken = "existing-csrf-token-value";
    const { context, response } = createMockContext({
      cookies: {
        auth_token: "some-jwt-token",
        csrf_token: csrfToken,
      },
    });

    interceptor.intercept(context, createMockCallHandler()).subscribe({
      next: () => {
        expect(response.cookie).toHaveBeenCalledWith(
          "csrf_token",
          csrfToken,
          expect.objectContaining({
            httpOnly: false,
            sameSite: "lax",
            path: "/",
          }),
        );
      },
      complete: () => done(),
    });
  });

  it("does not set cookie when no auth_token", (done) => {
    const { context, response } = createMockContext({
      cookies: {
        csrf_token: "some-csrf-token",
      },
    });

    interceptor.intercept(context, createMockCallHandler()).subscribe({
      next: () => {
        expect(response.cookie).not.toHaveBeenCalled();
      },
      complete: () => done(),
    });
  });

  it("does not set cookie when no csrf_token", (done) => {
    const { context, response } = createMockContext({
      cookies: {
        auth_token: "some-jwt-token",
      },
    });

    interceptor.intercept(context, createMockCallHandler()).subscribe({
      next: () => {
        expect(response.cookie).not.toHaveBeenCalled();
      },
      complete: () => done(),
    });
  });

  it("does not set cookie when no cookies at all", (done) => {
    const { context, response } = createMockContext({
      cookies: {},
    });

    interceptor.intercept(context, createMockCallHandler()).subscribe({
      next: () => {
        expect(response.cookie).not.toHaveBeenCalled();
      },
      complete: () => done(),
    });
  });

  it("skips when headersSent is true", (done) => {
    const { context, response } = createMockContext({
      cookies: {
        auth_token: "some-jwt-token",
        csrf_token: "some-csrf-token",
      },
      headersSent: true,
    });

    interceptor.intercept(context, createMockCallHandler()).subscribe({
      next: () => {
        expect(response.cookie).not.toHaveBeenCalled();
      },
      complete: () => done(),
    });
  });

  it("passes through the response data unchanged", (done) => {
    const { context } = createMockContext({
      cookies: {
        auth_token: "jwt",
        csrf_token: "csrf",
      },
    });

    interceptor.intercept(context, createMockCallHandler()).subscribe({
      next: (value) => {
        expect(value).toBe("response-data");
      },
      complete: () => done(),
    });
  });
});
