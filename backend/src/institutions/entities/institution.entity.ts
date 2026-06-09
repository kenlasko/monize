import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from "typeorm";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Exclude } from "class-transformer";
import { User } from "../../users/entities/user.entity";

@Entity("institutions")
@Unique(["userId", "name"])
export class Institution {
  @ApiProperty({ example: "c5f5d5f0-1234-4567-890a-123456789abc" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({ example: "user-uuid" })
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @ApiProperty({ example: "TD Canada Trust", description: "Institution name" })
  @Column({ type: "varchar", length: 255 })
  name: string;

  @ApiProperty({
    example: "https://www.td.com",
    description: "Institution website (used to resolve the brand favicon)",
  })
  @Column({ type: "text" })
  website: string;

  @ApiPropertyOptional({
    example: "CA",
    description: "ISO 3166-1 alpha-2 country code",
  })
  @Column({ type: "varchar", length: 2, nullable: true })
  country: string | null;

  // Cached favicon bytes. Never selected by default and never serialized to the
  // client -- the bytes are served only through GET /institutions/:id/logo.
  @Exclude()
  @Column({ type: "bytea", name: "logo_data", nullable: true, select: false })
  logoData: Buffer | null;

  @Exclude()
  @Column({
    type: "varchar",
    name: "logo_content_type",
    length: 100,
    nullable: true,
    select: false,
  })
  logoContentType: string | null;

  @ApiProperty({
    example: true,
    description: "Whether a cached brand logo is available",
  })
  @Column({ type: "boolean", name: "has_logo", default: false })
  hasLogo: boolean;

  @ApiPropertyOptional()
  @Column({ type: "timestamp", name: "logo_fetched_at", nullable: true })
  logoFetchedAt: Date | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
