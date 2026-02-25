import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import * as express from "express";
import * as cookieParser from "cookie-parser";
import * as pg from "pg";
import { AppModule } from "./app.module";

// Configure pg to return DATE types as strings instead of Date objects
// This prevents timezone-related date shifting issues
// OID 1082 = DATE type in PostgreSQL
pg.types.setTypeParser(1082, (val: string) => val);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Trust first proxy (Docker/nginx) so req.ip reflects the real client IP
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // Increase body size limit for large QIF file imports
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: true }));

  // Cookie parser for OIDC state/nonce and auth tokens
  app.use(cookieParser());

  // Security middleware
  app.use(
    helmet({
      frameguard: { action: "deny" },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Enable CORS
  const allowedOrigins = [
    process.env.PUBLIC_APP_URL,
    process.env.CORS_ORIGIN,
    ...(process.env.NODE_ENV !== "production"
      ? [
          "http://localhost:3001",
          "http://localhost:3000",
          "http://127.0.0.1:3001",
          "http://127.0.0.1:3000",
        ]
      : []),
  ].filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "X-CSRF-Token",
      "Mcp-Session-Id",
    ],
    exposedHeaders: ["Mcp-Session-Id"],
  });

  // Global validation pipe
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

  // API prefix
  app.setGlobalPrefix("api/v1");

  // Swagger documentation (disabled in production)
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("Monize API")
      .setDescription("API for managing your personal finances via Monize")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document);
  }

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`🚀 Application is running on: http://localhost:${port}`);
  if (process.env.NODE_ENV !== "production") {
    console.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
  }
}

bootstrap();
