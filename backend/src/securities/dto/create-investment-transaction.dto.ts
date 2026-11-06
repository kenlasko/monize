import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  ValidateIf,
  IsDateString,
  Min,
  MaxLength,
} from "class-validator";
import { InvestmentAction } from "../entities/investment-transaction.entity";
import { TransactionStatus } from "../../transactions/entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { IsFxRate } from "../../common/validators/is-fx-rate.validator";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";
import { IsShareQuantity } from "../../common/validators/is-share-quantity.validator";

export class CreateInvestmentTransactionDto {
  @ApiProperty()
  @IsUUID()
  accountId: string;

  @ApiProperty({ enum: InvestmentAction })
  @IsEnum(InvestmentAction)
  action: InvestmentAction;

  @ApiProperty()
  @IsDateString()
  transactionDate: string;

  @ApiProperty({
    required: false,
    description: "Security ID for buy/sell transactions",
  })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiProperty({
    required: false,
    description: "Account where funds come from (BUY) or go to (SELL)",
  })
  @IsOptional()
  @IsUUID()
  fundingAccountId?: string;

  @ApiProperty({ required: false, description: "Number of shares" })
  @IsOptional()
  @IsShareQuantity()
  @Min(0)
  quantity?: number;

  @ApiProperty({ required: false, description: "Price per share" })
  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  price?: number;

  @ApiProperty({
    required: false,
    description:
      "Executed total in the security's currency, commission included on a buy and deducted on a sell. Supplied, it is the fact: it is stored as given and the per-share price is derived from it. Omitted, the total is derived from the price.",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @Min(0)
  totalAmount?: number;

  @ApiProperty({
    required: false,
    description: "Commission or fee",
    default: 0,
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @Min(0)
  commission?: number;

  @ApiProperty({
    required: false,
    description:
      "Accrued interest paid out with a REDEEM, recorded as a linked INTEREST transaction and included in the single cash movement. Refused on any other action.",
    default: 0,
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @Min(0)
  accruedInterest?: number;

  @ApiProperty({
    required: false,
    description:
      "Exchange rate used to convert the total amount from the security's currency into the cash account's currency. If omitted, the most recent market rate is used. Defaults to 1 when both currencies match.",
  })
  @IsOptional()
  // Strictly positive: zero is not a rate. `@Min(0)` let a request through that
  // previewed as zero cash impact and committed at 1.0 (audit P5-005).
  @IsFxRate()
  exchangeRate?: number;

  @ApiProperty({
    required: false,
    description: "Description of the transaction",
  })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  @SanitizeHtml()
  description?: string;

  @ApiProperty({
    enum: TransactionStatus,
    required: false,
    description:
      "Reconciliation status. Defaults to UNRECONCILED. A VOID transaction moves no shares and no cash.",
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    format: "uuid",
    description:
      "The bond series (bond instrument id) a share-moving transaction of a program-linked security acts on. " +
      "An acquisition without one takes the program's series on sale on the transaction date; " +
      "a removal without one leaves first-in first-out across the account's series. " +
      "Refused for a security that is not linked to a bond program.",
  })
  // One canonical spelling (lower case) before anything compares or stores it.
  @Transform(({ value }) =>
    typeof value === "string" ? value.toLowerCase() : value,
  )
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== undefined)
  @IsUUID()
  bondInstrumentId?: string | null;
}
