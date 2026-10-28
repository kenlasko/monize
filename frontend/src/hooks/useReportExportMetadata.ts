"use client";
import { useTranslations } from "next-intl";
import { useContext } from "react";
import {
  BasisContext,
  type ReportingBasis,
} from "@/components/reports/ReportingBasisContext";
import {
  exportToCsv,
  exportCsvSections,
  type CsvValue,
  type CsvSection,
} from "@/lib/csv-export";
import type { PdfExportOptions } from "@/lib/pdf-export";
/** Metadata travels with the export payload, never through mutable global state. */
export function useReportExportMetadata(fixed?: ReportingBasis) {
  const selected = useContext(BasisContext)?.basis;
  const basis = selected ? (fixed ?? selected) : undefined;
  const t = useTranslations("common.reportingBasis");
  const ts = useTranslations("settings.preferences");
  const label = basis
    ? ts(basis === "cash" ? "reportingCash" : "reportingAccrual")
    : "";
  return {
    exportCsvWithBasis: (
      filename: string,
      headers: string[],
      rows: CsvValue[][],
    ) =>
      exportToCsv(
        filename,
        basis ? [...headers, t("label")] : headers,
        basis ? rows.map((row) => [...row, label]) : rows,
      ),
    exportSectionsWithBasis: (filename: string, sections: CsvSection[]) =>
      exportCsvSections(
        filename,
        basis
          ? sections.map((section) => ({
              ...section,
              title: [section.title, t("exportCaption", { basis: label })]
                .filter(Boolean)
                .join(" · "),
            }))
          : sections,
      ),
    withPdfBasis: (options: PdfExportOptions): PdfExportOptions =>
      basis
        ? {
            ...options,
            description: [
              options.description,
              t("exportCaption", { basis: label }),
            ]
              .filter(Boolean)
              .join("\n"),
          }
        : options,
  };
}
