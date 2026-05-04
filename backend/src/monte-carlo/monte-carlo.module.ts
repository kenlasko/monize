import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { MonteCarloController } from "./monte-carlo.controller";
import { MonteCarloService } from "./monte-carlo.service";
import { MonteCarloSimulationService } from "./monte-carlo-simulation.service";
import { SecuritiesModule } from "../securities/securities.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([MonteCarloScenario, InvestmentTransaction]),
    SecuritiesModule,
  ],
  controllers: [MonteCarloController],
  providers: [MonteCarloService, MonteCarloSimulationService],
  exports: [MonteCarloService, MonteCarloSimulationService],
})
export class MonteCarloModule {}
