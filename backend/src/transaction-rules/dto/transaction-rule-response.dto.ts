import { ApiProperty } from "@nestjs/swagger";
import { RuleAction } from "../rule-action.types";
import { RuleConditionNode } from "../rule-condition.types";
import { RuleErrorCode, RuleErrorEntry } from "../rule-references";
import { RuleTrigger } from "../rule-trigger.types";

/** Why a stored rule cannot run: a validation code or `REFERENCE_NOT_FOUND`. */
export class TransactionRuleInvalidReasonDto implements RuleErrorEntry {
  @ApiProperty({ description: "Dotted path, e.g. condition.all[0]" })
  path: string;

  @ApiProperty({ description: "Machine-readable reason" })
  code: RuleErrorCode;
}

export class TransactionRuleResponseDto {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  triggers: RuleTrigger[];
  condition: RuleConditionNode;
  actions: RuleAction[];
  stopProcessing: boolean;
  @ApiProperty({ type: String, nullable: true, example: "2026-10-01" })
  activeFrom: string | null;
  @ApiProperty({ type: String, nullable: true, example: "2026-12-31" })
  activeTo: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;

  @ApiProperty({
    description:
      "True when the stored definition fails validation or names an id that no longer exists; the rule is kept and skipped at run time",
  })
  invalid: boolean;

  @ApiProperty({ type: [TransactionRuleInvalidReasonDto] })
  invalidReasons: TransactionRuleInvalidReasonDto[];
}
