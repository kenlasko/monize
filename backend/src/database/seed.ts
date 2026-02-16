import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { SeedService } from "./seed.service";
import { DemoSeedService } from "./demo-seed.service";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const isDemoMode = process.env.DEMO_MODE?.toLowerCase() === "true";

  try {
    if (isDemoMode) {
      const demoSeedService = app.get(DemoSeedService);
      await demoSeedService.seedAll();
    } else {
      const seedService = app.get(SeedService);
      await seedService.seedAll();
    }
    console.log("\n🎉 Seeding completed!");
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Seeding failed:", error);
    await app.close();
    process.exit(1);
  }
}

bootstrap();
