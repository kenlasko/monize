import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Response } from "express";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env.NODE_ENV === "production";

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      return;
    }

    let status: number;
    let message: string | string[];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === "string") {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === "object" &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp.message as string | string[]) || exception.message;
      } else {
        message = exception.message;
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = "Internal server error";

      this.logger.error(
        "Unhandled exception",
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(this.isProduction ? {} : { timestamp: new Date().toISOString() }),
    });
  }
}
