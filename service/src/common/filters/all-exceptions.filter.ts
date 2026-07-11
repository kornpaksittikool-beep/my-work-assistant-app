import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'http';

interface ErrorResponseBody {
  success: false;
  statusCode: number;
  message: string[];
  error: string;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const statusCode: HttpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseBody = {
      success: false,
      statusCode,
      message: this.extractMessage(exception),
      error: STATUS_CODES[statusCode] ?? 'Error',
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(statusCode).json(body);
  }

  /**
   * `catch()` only reaches the non-HttpException branch with statusCode
   * forced to 500 (see above), so there's nothing further to branch on here.
   */
  private extractMessage(exception: unknown): string[] {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') return [res];
      if (typeof res === 'object' && res !== null && 'message' in res) {
        const msg = res.message;
        return Array.isArray(msg) ? msg.map(String) : [String(msg)];
      }
      return [exception.message];
    }

    return ['Internal server error'];
  }
}
