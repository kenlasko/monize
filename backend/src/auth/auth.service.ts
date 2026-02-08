import { Injectable, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

import { User } from '../users/entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, password, firstName, lastName } = registerDto;

    // Check if user exists
    const existingUser = await this.usersRepository.findOne({
      where: { email },
    });

    if (existingUser) {
      // SECURITY: Generic message to prevent account enumeration
      throw new UnauthorizedException('Unable to complete registration');
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = this.usersRepository.create({
      email,
      passwordHash,
      firstName,
      lastName,
      authProvider: 'local',
    });

    await this.usersRepository.save(user);

    // Generate JWT token
    const token = this.generateToken(user);

    return {
      user: this.sanitizeUser(user),
      token,
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    const user = await this.usersRepository.findOne({
      where: { email, authProvider: 'local' },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

    const token = this.generateToken(user);

    return {
      user: this.sanitizeUser(user),
      token,
    };
  }

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.usersRepository.findOne({
      where: { email, authProvider: 'local' },
    });

    if (user && user.passwordHash) {
      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
      if (isPasswordValid && user.isActive) {
        return this.sanitizeUser(user);
      }
    }
    return null;
  }

  async findOrCreateOidcUser(userInfo: Record<string, unknown>, registrationEnabled = true) {
    // Standard OIDC claims
    const sub = userInfo.sub as string;
    const email = userInfo.email as string | undefined;
    // SECURITY: Only trust email if verified by the OIDC provider
    const emailVerified = userInfo.email_verified === true;
    const trustedEmail = emailVerified ? email : undefined;

    // Handle name claims - try specific claims first, fall back to 'name'
    const fullName = userInfo.name as string | undefined;
    const firstName =
      (userInfo.given_name as string) ||
      (userInfo.preferred_username as string) ||
      fullName?.split(' ')[0] ||
      undefined;
    const lastName =
      (userInfo.family_name as string) ||
      fullName?.split(' ').slice(1).join(' ') ||
      undefined;

    if (!sub) {
      throw new UnauthorizedException('OIDC provider did not return a subject identifier');
    }

    let user = await this.usersRepository.findOne({
      where: { oidcSubject: sub },
    });

    if (!user) {
      // SECURITY: Only link to existing account if email is verified by OIDC provider
      // This prevents account takeover via OIDC providers that don't verify emails
      if (trustedEmail) {
        const existingUser = await this.usersRepository.findOne({
          where: { email: trustedEmail },
        });

        if (existingUser) {
          // Link OIDC to existing local account
          existingUser.oidcSubject = sub;
          // Keep authProvider as 'local' if they have a password, allowing both login methods
          // If they want OIDC-only, they can remove their password later
          await this.usersRepository.save(existingUser);
          user = existingUser;
        }
      }

      if (!user) {
        if (!registrationEnabled) {
          throw new ForbiddenException('New account registration is disabled.');
        }
        // Create new user (no existing account found)
        // Use trusted email if verified, otherwise store raw email but don't link accounts
        const userData: DeepPartial<User> = {
          email: trustedEmail ?? email ?? null,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          oidcSubject: sub,
          authProvider: 'oidc',
        };
        user = this.usersRepository.create(userData);

        try {
          await this.usersRepository.save(user);
        } catch (err: any) {
          // Handle duplicate email: link OIDC to the existing account
          if (err.code === '23505' && email) {
            const existingUser = await this.usersRepository.findOne({
              where: { email },
            });
            if (existingUser) {
              existingUser.oidcSubject = sub;
              await this.usersRepository.save(existingUser);
              user = existingUser;
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
    } else {
      // Update user info if it has changed (but don't overwrite with null)
      let needsUpdate = false;

      // SECURITY: Only update email if verified by OIDC provider
      if (trustedEmail && user.email !== trustedEmail) {
        user.email = trustedEmail;
        needsUpdate = true;
      }
      if (firstName && user.firstName !== firstName) {
        user.firstName = firstName;
        needsUpdate = true;
      }
      if (lastName && user.lastName !== lastName) {
        user.lastName = lastName;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await this.usersRepository.save(user);
      }
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

    return user;
  }

  async validateOidcUser(profile: any): Promise<any> {
    const user = await this.findOrCreateOidcUser(profile);
    return this.sanitizeUser(user);
  }

  generateToken(user: User): string {
    const payload = {
      sub: user.id,
      email: user.email,
      authProvider: user.authProvider,
    };
    return this.jwtService.sign(payload);
  }

  async getUserById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async generateResetToken(
    email: string,
  ): Promise<{ user: User; token: string } | null> {
    const user = await this.usersRepository.findOne({
      where: { email, authProvider: 'local' },
    });

    if (!user) return null;

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    user.resetToken = resetToken;
    user.resetTokenExpiry = resetTokenExpiry;
    await this.usersRepository.save(user);

    return { user, token: resetToken };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { resetToken: token },
    });

    if (
      !user ||
      !user.resetTokenExpiry ||
      user.resetTokenExpiry < new Date()
    ) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const saltRounds = 10;
    user.passwordHash = await bcrypt.hash(newPassword, saltRounds);
    user.resetToken = null;
    user.resetTokenExpiry = null;
    await this.usersRepository.save(user);
  }

  private sanitizeUser(user: User) {
    const { passwordHash, resetToken, resetTokenExpiry, ...sanitized } = user;
    return sanitized;
  }
}
