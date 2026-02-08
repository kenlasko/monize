import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { UserPreference } from './entities/user-preference.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Check if email is being changed and if it's already taken
    if (dto.email && dto.email !== user.email) {
      const existingUser = await this.usersRepository.findOne({
        where: { email: dto.email },
      });
      if (existingUser) {
        throw new ConflictException('Email already in use');
      }
      user.email = dto.email;
    }

    if (dto.firstName !== undefined) {
      user.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined) {
      user.lastName = dto.lastName;
    }

    return this.usersRepository.save(user);
  }

  async getPreferences(userId: string): Promise<UserPreference> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    // Create default preferences if they don't exist
    // Default to 'browser' for locale-dependent settings
    if (!preferences) {
      // Use direct instantiation to ensure primary key is set
      preferences = new UserPreference();
      preferences.userId = userId;
      preferences.defaultCurrency = 'USD';
      preferences.dateFormat = 'browser';
      preferences.numberFormat = 'browser';
      preferences.theme = 'system';
      preferences.timezone = 'browser';
      preferences.notificationEmail = true;
      preferences.notificationBrowser = true;
      preferences.twoFactorEnabled = false;
      preferences.gettingStartedDismissed = false;
      await this.preferencesRepository.save(preferences);
    }

    return preferences;
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<UserPreference> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      // Create with defaults first
      preferences = await this.getPreferences(userId);
    }

    // Update only provided fields
    if (dto.defaultCurrency !== undefined) {
      preferences.defaultCurrency = dto.defaultCurrency;
    }
    if (dto.dateFormat !== undefined) {
      preferences.dateFormat = dto.dateFormat;
    }
    if (dto.numberFormat !== undefined) {
      preferences.numberFormat = dto.numberFormat;
    }
    if (dto.theme !== undefined) {
      preferences.theme = dto.theme;
    }
    if (dto.timezone !== undefined) {
      preferences.timezone = dto.timezone;
    }
    if (dto.notificationEmail !== undefined) {
      preferences.notificationEmail = dto.notificationEmail;
    }
    if (dto.notificationBrowser !== undefined) {
      preferences.notificationBrowser = dto.notificationBrowser;
    }
    if (dto.gettingStartedDismissed !== undefined) {
      preferences.gettingStartedDismissed = dto.gettingStartedDismissed;
    }

    return this.preferencesRepository.save(preferences);
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (!user.passwordHash) {
      throw new BadRequestException('No password set for this account');
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    // Hash and save new password
    const saltRounds = 10;
    user.passwordHash = await bcrypt.hash(dto.newPassword, saltRounds);
    user.mustChangePassword = false;
    await this.usersRepository.save(user);
  }

  async deleteAccount(userId: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Delete preferences first (due to FK constraint)
    await this.preferencesRepository.delete({ userId });

    // Delete the user
    await this.usersRepository.remove(user);
  }
}
