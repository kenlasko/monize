import {
  HttpException,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
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
});
