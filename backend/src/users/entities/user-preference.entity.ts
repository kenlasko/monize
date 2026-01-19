import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('user_preferences')
export class UserPreference {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId: string;

  @Column({ name: 'default_currency', length: 3, default: 'USD' })
  defaultCurrency: string;

  @Column({ name: 'date_format', default: 'YYYY-MM-DD' })
  dateFormat: string;

  @Column({ name: 'number_format', default: 'en-US' })
  numberFormat: string;

  @Column({ default: 'light' })
  theme: string;

  @Column({ default: 'UTC' })
  timezone: string;

  @Column({ name: 'notification_email', default: true })
  notificationEmail: boolean;

  @Column({ name: 'notification_browser', default: true })
  notificationBrowser: boolean;

  @Column({ name: 'two_factor_enabled', default: false })
  twoFactorEnabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToOne(() => User, (user) => user.preferences)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
