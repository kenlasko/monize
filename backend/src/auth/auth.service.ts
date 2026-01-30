import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async findOrCreateOidcUser(profile: any) {
    const { sub, email, given_name, family_name } = profile;

    let user = await this.usersRepository.findOne({
      where: { oidcSubject: sub },
    });

    if (!user) {
      // Check if email exists with different auth provider
      const existingUser = await this.usersRepository.findOne({
        where: { email },
      });

      if (existingUser) {
        throw new UnauthorizedException(
          'Email already registered with different authentication method',
        );
      }

      // Create new user
      user = this.usersRepository.create({
        email,
        firstName: given_name,
        lastName: family_name,
        oidcSubject: sub,
        authProvider: 'oidc',
      });

      await this.usersRepository.save(user);
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
