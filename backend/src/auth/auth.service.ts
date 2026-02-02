import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import * as bcrypt from 'bcryptjs';

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
      throw new UnauthorizedException('Email already registered');
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

  async findOrCreateOidcUser(userInfo: Record<string, unknown>) {
    // Standard OIDC claims
    const sub = userInfo.sub as string;
    const email = userInfo.email as string | undefined;

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
      // Check if email exists with different auth provider
      if (email) {
        const existingUser = await this.usersRepository.findOne({
          where: { email },
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
        // Create new user (no existing account found)
        const userData: DeepPartial<User> = {
          email: email ?? null,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          oidcSubject: sub,
          authProvider: 'oidc',
        };
        user = this.usersRepository.create(userData);

        await this.usersRepository.save(user);
      }
    } else {
      // Update user info if it has changed (but don't overwrite with null)
      let needsUpdate = false;

      if (email && user.email !== email) {
        user.email = email;
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

  private sanitizeUser(user: User) {
    const { passwordHash, ...sanitized } = user;
    return sanitized;
  }
}
