import { JwtService } from "@nestjs/jwt";
import * as supertest from "supertest";
import { INestApplication } from "@nestjs/common";

export async function loginTestUser(
  app: INestApplication,
  email: string,
  password: string,
): Promise<{ cookies: string[] }> {
  const response = await supertest(app.getHttpServer())
    .post("/api/v1/auth/login")
    .send({ email, password })
    .expect(200);

  const cookies = response.headers["set-cookie"] || [];
  return { cookies: Array.isArray(cookies) ? cookies : [cookies] };
}

export function generateTestJwt(
  jwtService: JwtService,
  payload: { sub: string; email: string; role?: string },
): string {
  return jwtService.sign({
    sub: payload.sub,
    email: payload.email,
    role: payload.role || "user",
    authProvider: "local",
  });
}
