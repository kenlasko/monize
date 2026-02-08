import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/entities/user.entity';
import { UserPreference } from '../users/entities/user-preference.entity';
import { generateReadablePassword } from './utils/password-generator';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
  ) {}

  async findAllUsers(): Promise<User[]> {
    return this.usersRepository.find({
      order: { createdAt: 'ASC' },
    });
  }

  async updateUserRole(
    adminId: string,
    targetUserId: string,
    role: string,
  ): Promise<User> {
    if (adminId === targetUserId) {
      throw new ForbiddenException('You cannot change your own role');
    }

    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    // Prevent removing the last admin
    if (targetUser.role === 'admin' && role === 'user') {
      const adminCount = await this.usersRepository.count({
        where: { role: 'admin' },
      });
      if (adminCount <= 1) {
        throw new BadRequestException(
          'Cannot remove the last admin. Promote another user first.',
        );
      }
    }

    targetUser.role = role;
    return this.usersRepository.save(targetUser);
  }

  async updateUserStatus(
    adminId: string,
    targetUserId: string,
    isActive: boolean,
  ): Promise<User> {
    if (adminId === targetUserId) {
      throw new ForbiddenException('You cannot disable your own account');
    }

    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    targetUser.isActive = isActive;
    return this.usersRepository.save(targetUser);
  }

  async deleteUser(adminId: string, targetUserId: string): Promise<void> {
    if (adminId === targetUserId) {
      throw new ForbiddenException('You cannot delete your own account');
    }

    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    // Prevent deleting the last admin
    if (targetUser.role === 'admin') {
      const adminCount = await this.usersRepository.count({
        where: { role: 'admin' },
      });
      if (adminCount <= 1) {
        throw new BadRequestException(
          'Cannot delete the last admin account.',
        );
      }
    }

    // Delete preferences first (FK constraint)
    await this.preferencesRepository.delete({ userId: targetUserId });
    await this.usersRepository.remove(targetUser);
  }

  async resetUserPassword(
    targetUserId: string,
  ): Promise<{ temporaryPassword: string }> {
    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    if (targetUser.authProvider !== 'local') {
      throw new BadRequestException(
        'Cannot reset password for accounts using external authentication',
      );
    }

    const temporaryPassword = generateReadablePassword();
    const saltRounds = 10;
    targetUser.passwordHash = await bcrypt.hash(temporaryPassword, saltRounds);
    targetUser.mustChangePassword = true;
    targetUser.resetToken = null;
    targetUser.resetTokenExpiry = null;
    await this.usersRepository.save(targetUser);

    return { temporaryPassword };
  }
}
