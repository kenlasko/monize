import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { Holding } from "../securities/entities/holding.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { MonteCarloController } from "./monte-carlo.controller";
import { MonteCarloService } from "./monte-carlo.service";
import { MonteCarloSimulationService } from "./monte-carlo-simulation.service";
import { SecuritiesModule } from "../securities/securities.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([MonteCarloScenario, Holding, SecurityPrice]),
    SecuritiesModule,
  ],
  controllers: [MonteCarloController],
  providers: [MonteCarloService, MonteCarloSimulationService],
  exports: [MonteCarloService, MonteCarloSimulationService],
})
export class MonteCarloModule {}
