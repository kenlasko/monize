export interface ReportingProvenance {
  readOnly: true;
  isRecognition?: boolean;
  reportId: string;
  sourceTransactionId: string;
  sourceSplitId?: string;
  scheduleId?: string | null;
  cashDate: string;
  effectiveDate: string;
  sourceAmount: string;
  nativeAmount: string;
  conversion?: {
    source: string;
    rate: number | null;
    observedOn: string | null;
  };
}
