import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Response } from 'express';
import { generateCsrfToken, getCsrfCookieOptions } from '../csrf.util';

@Injectable()
export class CsrfRefreshInterceptor implements NestInterceptor {
  private readonly isProduction = process.env.NODE_ENV === 'production';

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      tap(() => {
        const request = context.switchToHttp().getRequest();
        const response = context.switchToHttp().getResponse<Response>();

        // Only refresh if user is authenticated (has auth_token cookie)
        // and currently has a CSRF token (don't set one for unauthenticated users)
        if (request.cookies?.['auth_token'] && request.cookies?.['csrf_token']) {
          // Re-set the CSRF cookie with a fresh maxAge to keep it alive
          response.cookie(
            'csrf_token',
            request.cookies['csrf_token'],
            getCsrfCookieOptions(this.isProduction),
          );
        }
      }),
    );
  }
}
