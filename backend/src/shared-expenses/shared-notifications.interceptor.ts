import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { SharedNotificationsService } from "./shared-notifications.service";

/** Failed commands never emit; successful commands have left their DB transaction. */
@Injectable()
export class SharedNotificationsInterceptor implements NestInterceptor {
  constructor(private readonly notifications: SharedNotificationsService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const groupId = context
      .switchToHttp()
      .getRequest<{ params: { groupId?: string } }>().params.groupId;
    return next.handle().pipe(
      tap(() => {
        if (groupId) void this.notifications.deliver(groupId);
      }),
    );
  }
}
