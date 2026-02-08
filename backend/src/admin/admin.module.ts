import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { UserPreference } from '../users/entities/user-preference.entity';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserPreference])],
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
