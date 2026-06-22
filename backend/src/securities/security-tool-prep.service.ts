import { Injectable } from "@nestjs/common";
import {
  SecuritiesService,
  CreateSecurityPreview,
  UpdateSecurityPreview,
  DeleteSecurityPreview,
} from "./securities.service";
import {
  AiActionPreviewRow,
  BatchCreateSecurityRow,
  BatchUpdateSecurityRow,
  BatchDeleteSecurityRow,
} from "../ai/actions/ai-action.types";
import { securityPreviewRow } from "../ai/actions/ai-action-builder.service";
import { BulkCreateSkip, bulkSkipReason } from "../common/bulk-create.types";

/** Create-row input for manage_securities (looked up via the quote provider). */
export interface ManageCreateSecurityRow {
  query: string;
  exchange?: string;
  securityType?: string;
  isFavourite?: boolean;
  currencyCode?: string;
}

/** Update-row input for manage_securities (identified by symbol or name). */
export interface ManageUpdateSecurityRow {
  query: string;
  securityType?: string | null;
  exchange?: string | null;
  currencyCode?: string;
  isFavourite?: boolean;
  /**
   * Manual country allocation, with weights as PERCENTAGES (0-100) -- the form
   * the model receives when a user pastes a breakdown. Converted to decimal
   * 0-1 before previewing/persisting. A sub-100 total leaves the rest as
   * "Other".
   */
  countryWeightings?: { name: string; weight: number }[];
}

/** Delete-row input for manage_securities (identified by symbol or name). */
export interface ManageDeleteSecurityRow {
  query: string;
}

export interface PrepareCreateSecuritiesResult {
  okPreviews: CreateSecurityPreview[];
  okRows: BatchCreateSecurityRow[];
  previewRows: AiActionPreviewRow[];
  okIndex: number[];
  skipped: BulkCreateSkip[];
}

export interface PrepareUpdateSecuritiesResult {
  okPreviews: UpdateSecurityPreview[];
  okRows: BatchUpdateSecurityRow[];
  previewRows: AiActionPreviewRow[];
  okIndex: number[];
  skipped: BulkCreateSkip[];
}

export interface PrepareDeleteSecuritiesResult {
  okPreviews: DeleteSecurityPreview[];
  okRows: BatchDeleteSecurityRow[];
  previewRows: AiActionPreviewRow[];
  okIndex: number[];
  skipped: BulkCreateSkip[];
}

/**
 * Shared name/symbol-resolution + preview-building for the unified
 * `manage_securities` tool. Both tool surfaces (AI Assistant tool executor and
 * MCP server) delegate here so they stay thin adapters with identical behaviour
 * (CLAUDE.md repo rule). Single-item failures throw; bulk variants are
 * best-effort, collecting per-row skips instead of aborting the batch.
 */
@Injectable()
export class SecurityToolPrepService {
  constructor(private readonly securitiesService: SecuritiesService) {}

  static createToBatchRow(
    preview: CreateSecurityPreview,
  ): BatchCreateSecurityRow {
    return {
      symbol: preview.symbol,
      name: preview.name,
      securityType: preview.securityType,
      exchange: preview.exchange,
      currencyCode: preview.currencyCode,
      isFavourite: preview.isFavourite,
      quoteProvider: preview.quoteProvider,
      msnInstrumentId: preview.msnInstrumentId,
    };
  }

  static updateToBatchRow(
    preview: UpdateSecurityPreview,
  ): BatchUpdateSecurityRow {
    return {
      securityId: preview.securityId,
      securityType: preview.securityType,
      exchange: preview.exchange,
      currencyCode: preview.currencyCode,
      isFavourite: preview.isFavourite,
      countryWeightings: preview.countryWeightings,
    };
  }

  /**
   * Convert AI-supplied country weightings (percentages 0-100) to the decimal
   * 0-1 form the service/entity store. Returns undefined when the caller did
   * not supply any (so the existing allocation is left untouched).
   */
  private static toFractionWeightings(
    rows?: { name: string; weight: number }[],
  ): { name: string; weight: number }[] | undefined {
    if (rows === undefined) return undefined;
    return rows.map((r) => ({
      name: r.name,
      weight: Number(r.weight) / 100,
    }));
  }

  async prepareCreateSecuritySingle(
    userId: string,
    row: ManageCreateSecurityRow,
  ): Promise<CreateSecurityPreview> {
    return this.securitiesService.previewCreateSecurity(userId, {
      query: row.query,
      exchange: row.exchange,
      securityType: row.securityType,
      isFavourite: row.isFavourite,
      currencyCode: row.currencyCode,
    });
  }

  async prepareUpdateSecuritySingle(
    userId: string,
    row: ManageUpdateSecurityRow,
  ): Promise<UpdateSecurityPreview> {
    return this.securitiesService.previewUpdateSecurity(userId, {
      query: row.query,
      securityType: row.securityType,
      exchange: row.exchange,
      currencyCode: row.currencyCode,
      isFavourite: row.isFavourite,
      countryWeightings: SecurityToolPrepService.toFractionWeightings(
        row.countryWeightings,
      ),
    });
  }

  async prepareDeleteSecuritySingle(
    userId: string,
    row: ManageDeleteSecurityRow,
  ): Promise<DeleteSecurityPreview> {
    return this.securitiesService.previewDeleteSecurity(userId, {
      query: row.query,
    });
  }

  async prepareCreateSecurities(
    userId: string,
    rows: ManageCreateSecurityRow[],
  ): Promise<PrepareCreateSecuritiesResult> {
    const okPreviews: CreateSecurityPreview[] = [];
    const okRows: BatchCreateSecurityRow[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const okIndex: number[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const preview = await this.prepareCreateSecuritySingle(userId, row);
        okPreviews.push(preview);
        okRows.push(SecurityToolPrepService.createToBatchRow(preview));
        okIndex.push(i);
        previewRows.push(securityPreviewRow(preview));
      } catch (err) {
        const reason = bulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ status: "error", symbol: row.query, error: reason });
      }
    }

    return { okPreviews, okRows, previewRows, okIndex, skipped };
  }

  async prepareUpdateSecurities(
    userId: string,
    rows: ManageUpdateSecurityRow[],
  ): Promise<PrepareUpdateSecuritiesResult> {
    const okPreviews: UpdateSecurityPreview[] = [];
    const okRows: BatchUpdateSecurityRow[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const okIndex: number[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const preview = await this.prepareUpdateSecuritySingle(userId, row);
        okPreviews.push(preview);
        okRows.push(SecurityToolPrepService.updateToBatchRow(preview));
        okIndex.push(i);
        previewRows.push(securityPreviewRow(preview));
      } catch (err) {
        const reason = bulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ status: "error", symbol: row.query, error: reason });
      }
    }

    return { okPreviews, okRows, previewRows, okIndex, skipped };
  }

  async prepareDeleteSecurities(
    userId: string,
    rows: ManageDeleteSecurityRow[],
  ): Promise<PrepareDeleteSecuritiesResult> {
    const okPreviews: DeleteSecurityPreview[] = [];
    const okRows: BatchDeleteSecurityRow[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const okIndex: number[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const preview = await this.prepareDeleteSecuritySingle(userId, row);
        okPreviews.push(preview);
        okRows.push({ securityId: preview.securityId });
        okIndex.push(i);
        previewRows.push({
          status: "ok",
          symbol: preview.symbol,
          securityName: preview.name,
        });
      } catch (err) {
        const reason = bulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ status: "error", symbol: row.query, error: reason });
      }
    }

    return { okPreviews, okRows, previewRows, okIndex, skipped };
  }
}
