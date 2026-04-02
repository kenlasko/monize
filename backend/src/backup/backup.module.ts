import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";
import { AutoBackupService } from "./auto-backup.service";
import { User } from "../users/entities/user.entity";
import { AutoBackupSettings } from "./entities/auto-backup-settings.entity";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [TypeOrmModule.forFeature([User, AutoBackupSettings]), AuthModule],
  controllers: [BackupController],
  providers: [BackupService, AutoBackupService],
})
export class BackupModule {}
