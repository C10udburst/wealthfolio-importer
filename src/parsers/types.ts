import type { ActivityImport } from '@wealthfolio/addon-sdk';

export type ImportSourceId = 'ing' | 'pekao' | 'xtb';

export interface ImportParseResult {
  records: ActivityImport[];
  duplicates: number;
  warnings: string[];
}

export interface ParseOptions {
  accountId: string;
  accountCurrency: string;
}

export interface ImportDetection {
  sourceId: ImportSourceId;
  confidence: number;
  reason: string;
}

export interface ImporterDefinition {
  id: ImportSourceId;
  label: string;
  supportedExtensions: string[];
  fileNamePattern?: RegExp;
}
