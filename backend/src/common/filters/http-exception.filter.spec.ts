import {
  HttpException,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { GlobalExceptionFilter } from "./http-exception.filter";

describe("GlobalExceptionFilter", () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: {
    status: jest.Mock;
    json: jest.Mock;
    headersSent: boolean;
  };
  let mockHost: any;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      headersSent: false,
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => ({ url: "/test" }),
      }),
    };
  });

  it("returns structured response for HttpException", () => {
    const exception = new BadRequestException("Invalid input");

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        message: "Invalid input",
      }),
    );
  });

  it("forwards a machine-readable errorCode from an object response", () => {
    const exception = new ConflictException({
      message: "Currency is inactive",
      errorCode: "CURRENCY_INACTIVE",
      currencyCode: "CAD",
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        message: "Currency is inactive",
        errorCode: "CURRENCY_INACTIVE",
      }),
    );
  });

  it("forwards a structured errors list from an object response", () => {
    const errors = [{ path: "actions[0]", code: "REFERENCE_NOT_FOUND" }];
    const exception = new BadRequestException({
      message: "Invalid rule",
      errorCode: "INVALID_RULE",
      errors,
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid rule", errors }),
    );
  });

  it("omits errors when the object response has none", () => {
    filter.catch(new BadRequestException({ message: "Nope" }), mockHost);

    expect(mockResponse.json.mock.calls[0][0]).not.toHaveProperty("errors");
  });

  it("omits errorCode when the object response has none", () => {
    const exception = new ConflictException("Plain conflict");

    filter.catch(exception, mockHost);

    const jsonCall = mockResponse.json.mock.calls[0][0];
    expect(jsonCall).not.toHaveProperty("errorCode");
  });

  it("forwards a numeric currentCount from an object response", () => {
    filter.catch(
      new ConflictException({ message: "Changed", currentCount: 12 }),
      mockHost,
    );

    expect(mockResponse.json.mock.calls[0][0]).toMatchObject({
      statusCode: 409,
      message: "Changed",
      currentCount: 12,
    });
  });

  it("omits currentCount when it is absent or not a number", () => {
    filter.catch(
      new ConflictException({ message: "Changed", currentCount: "12" }),
      mockHost,
    );

    expect(mockResponse.json.mock.calls[0][0]).not.toHaveProperty(
      "currentCount",
    );
  });

  it("returns structured response for NotFoundException", () => {
    const exception = new NotFoundException("Resource not found");

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        message: "Resource not found",
      }),
    );
  });

  it("returns structured response for ForbiddenException", () => {
    const exception = new ForbiddenException("Access denied");

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.FORBIDDEN,
        message: "Access denied",
      }),
    );
  });

  it("returns generic 500 for non-HttpException errors", () => {
    const exception = new Error("Something broke internally");

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: "Internal server error",
      }),
    );
  });

  it("does not leak stack traces for non-HttpException errors", () => {
    const exception = new Error("secret database details");

    filter.catch(exception, mockHost);

    const jsonCall = mockResponse.json.mock.calls[0][0];
    expect(jsonCall.message).toBe("Internal server error");
    expect(jsonCall.stack).toBeUndefined();
    expect(JSON.stringify(jsonCall)).not.toContain("secret database details");
  });

  it("preserves validation error arrays from class-validator", () => {
    const exception = new BadRequestException({
      message: ["field must be a string", "field must not be empty"],
      error: "Bad Request",
      statusCode: 400,
    });

    filter.catch(exception, mockHost);

    const jsonCall = mockResponse.json.mock.calls[0][0];
    expect(jsonCall.message).toEqual([
      "field must be a string",
      "field must not be empty",
    ]);
  });

  it("skips when headers are already sent", () => {
    mockResponse.headersSent = true;
    const exception = new BadRequestException("test");

    filter.catch(exception, mockHost);

    expect(mockResponse.status).not.toHaveBeenCalled();
    expect(mockResponse.json).not.toHaveBeenCalled();
  });

  it("handles HttpException with string response", () => {
    const exception = new HttpException("Custom error", HttpStatus.CONFLICT);

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        message: "Custom error",
      }),
    );
  });

  it("returns friendly message for 429 Too Many Requests", () => {
    const exception = new HttpException(
      { statusCode: 429, message: "ThrottlerException: Too Many Requests" },
      HttpStatus.TOO_MANY_REQUESTS,
    );

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: "Too many requests. Please wait a few minutes and try again.",
      }),
    );
  });

  it("handles non-Error thrown values", () => {
    filter.catch("string error", mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: "Internal server error",
      }),
    );
  });

  describe("QueryFailedError handling", () => {
    function createQueryFailedError(pgCode: string, detail: string) {
      const driverError = Object.assign(new Error(detail), { code: pgCode });
      return new QueryFailedError("SELECT 1", [], driverError as any);
    }

    it("returns 400 for the Transfer category backstop, and 500 for any other CHECK violation", () => {
      const check = (constraint: string) =>
        new QueryFailedError(
          "INSERT",
          [],
          Object.assign(new Error("check violation"), {
            code: "23514",
            constraint,
          }) as any,
        );

      filter.catch(check("category_fits_row"), mockHost);
      expect(mockResponse.status).toHaveBeenLastCalledWith(
        HttpStatus.BAD_REQUEST,
      );
      expect(mockResponse.json).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: "A Transfer category can go only on a transfer",
        }),
      );

      filter.catch(check("chk_split_kind_exclusive"), mockHost);
      expect(mockResponse.status).toHaveBeenLastCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    });

    it("returns 409 Conflict for unique constraint violations (PG 23505)", () => {
      const exception = createQueryFailedError(
        "23505",
        'duplicate key value violates unique constraint "uq_accounts_name"',
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.CONFLICT,
          message: "A record with this value already exists",
        }),
      );
    });

    it("returns 400 Bad Request for foreign key violations (PG 23503)", () => {
      const exception = createQueryFailedError(
        "23503",
        'insert or update on table "transactions" violates foreign key constraint "fk_category"',
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.BAD_REQUEST,
          message: "Referenced record does not exist or cannot be removed",
        }),
      );
    });

    it("returns 500 for other database errors", () => {
      const exception = createQueryFailedError(
        "42P01",
        'relation "nonexistent_table" does not exist',
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: "Internal server error",
        }),
      );
    });

    it("never exposes constraint or column names in the response", () => {
      const exception = createQueryFailedError(
        "23505",
        'duplicate key value violates unique constraint "uq_accounts_name" DETAIL: Key (name)=(Checking) already exists',
      );

      filter.catch(exception, mockHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      const serialized = JSON.stringify(jsonCall);
      expect(serialized).not.toContain("uq_accounts_name");
      expect(serialized).not.toContain("constraint");
      expect(serialized).not.toContain("DETAIL");
    });

    describe("Row-Level Security mapping", () => {
      const originalMode = process.env.RLS_MODE;
      afterEach(() => {
        if (originalMode === undefined) {
          delete process.env.RLS_MODE;
        } else {
          process.env.RLS_MODE = originalMode;
        }
      });

      it("maps a WITH CHECK policy violation (42501) to 403 when enforcing", () => {
        process.env.RLS_MODE = "enforce";
        const exception = createQueryFailedError(
          "42501",
          'new row violates row-level security policy for table "accounts"',
        );

        filter.catch(exception, mockHost);

        expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
        const jsonCall = mockResponse.json.mock.calls[0][0];
        expect(jsonCall.message).toBe("Access denied");
        expect(JSON.stringify(jsonCall)).not.toContain("accounts");
      });

      it("maps the identity-GUC uuid cast error (22P02) to 403 when enforcing", () => {
        process.env.RLS_MODE = "shadow";
        const exception = createQueryFailedError(
          "22P02",
          'invalid input syntax for type uuid: "garbage"',
        );

        filter.catch(exception, mockHost);

        expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
        expect(mockResponse.json.mock.calls[0][0].message).toBe(
          "Access denied",
        );
      });

      it("leaves the RLS errors as 500 at RLS_MODE=off (behavior unchanged)", () => {
        process.env.RLS_MODE = "off";
        const exception = createQueryFailedError(
          "42501",
          'new row violates row-level security policy for table "accounts"',
        );

        filter.catch(exception, mockHost);

        expect(mockResponse.status).toHaveBeenCalledWith(
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      });

      it("does not map a plain permission-denied 42501 (no RLS text)", () => {
        process.env.RLS_MODE = "enforce";
        const exception = createQueryFailedError(
          "42501",
          'permission denied for table "accounts"',
        );

        filter.catch(exception, mockHost);

        expect(mockResponse.status).toHaveBeenCalledWith(
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      });

      it("does not map a non-uuid 22P02", () => {
        process.env.RLS_MODE = "enforce";
        const exception = createQueryFailedError(
          "22P02",
          'invalid input syntax for type integer: "abc"',
        );

        filter.catch(exception, mockHost);

        expect(mockResponse.status).toHaveBeenCalledWith(
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      });
    });
  });
});
