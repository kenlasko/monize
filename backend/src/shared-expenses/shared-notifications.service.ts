import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { SystemAlertService } from "../system-alerts/system-alert.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";

@Injectable()
export class SharedNotificationsService {
  private readonly logger = new Logger(SharedNotificationsService.name);
  constructor(
    private readonly dataSource: DataSource,
    private readonly alerts: SystemAlertService,
  ) {}

  /** Post-commit delivery; the journal is the durable source for read-time recovery. */
  async deliver(groupId: string | null = null): Promise<void> {
    try {
      const pending: {
        activity_id: string;
        recipient_id: string;
        group_id: string;
        revoked: boolean;
      }[] = await withScopedDb(this.dataSource, (manager) =>
        manager.query("SELECT * FROM shared_pending_notifications($1)", [
          groupId,
        ]),
      );
      for (const item of pending) {
        const navigation = item.revoked
          ? {
              type: NotificationType.SHARED_EXPENSE_UPDATED,
              target: "/shared-expenses",
            }
          : {
              type: NotificationType.SHARED_EXPENSE_UPDATED,
              target: `/shared-expenses/${item.group_id}`,
            };
        // The existing recipient-context seam owns all cross-user notification
        // writes. This runs after the journal transaction, never inside it.
        await this.alerts.raiseUserAlert(
          item.recipient_id,
          {
            ...navigation,
            severity: NotificationSeverity.INFO,
            title: "Shared expenses",
            message: "A shared group has an update. Open Monize to review it.",
            data: { groupId: item.group_id, accessChanged: item.revoked },
            dedupeKey: `shared:${item.activity_id}`,
          },
          {
            fanOut: "detached",
            onWritten: async (manager) => {
              await manager.query(
                `INSERT INTO shared_delivery_receipts (activity_id, user_id) VALUES ($1, $2)
              ON CONFLICT (activity_id, user_id) DO NOTHING`,
                [item.activity_id, item.recipient_id],
              );
            },
          },
        );
      }
    } catch (error) {
      this.logger.warn(
        `Shared notification delivery will retry on the next read: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
