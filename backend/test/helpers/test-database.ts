import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import * as cookieParser from "cookie-parser";

export async function createTestApp(
  modules: any[],
): Promise<{ app: INestApplication; module: TestingModule }> {
  const moduleBuilder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      TypeOrmModule.forRoot({
        type: "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        port: parseInt(process.env.DATABASE_PORT || "5432"),
        username: process.env.DATABASE_USER || "monize_test",
        password: process.env.DATABASE_PASSWORD || "test_password",
        database: process.env.DATABASE_NAME || "monize_test",
        entities: [__dirname + "/../../src/**/*.entity{.ts,.js}"],
        synchronize: true,
        dropSchema: true,
      }),
      ...modules,
    ],
  });

  const module = await moduleBuilder.compile();
  const app = module.createNestApplication();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  app.setGlobalPrefix("api/v1");
  app.use(cookieParser());

  await app.init();
  return { app, module };
}

export async function closeTestApp(app: INestApplication): Promise<void> {
  await app.close();
}
