import type { ActivityImport } from '@wealthfolio/addon-sdk';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

export abstract class BaseImporter {
  abstract id: string;
  abstract label: string;
  abstract supportedExtensions: string[];
  abstract parse(file: File, options: ParseOptions): Promise<ImportParseResult>;
  detect?: (file: File) => Promise<ImportDetection | null>;
  fileNamePattern?: RegExp;

  protected finalize(
    records: ActivityImport[],
    warnings: string[] = [],
  ): ImportParseResult {
    const normalizedRecords = records.map((record) => this.normalizeRecord(record));
    const duplicates = this.countDuplicates(normalizedRecords);
    return {
      records: normalizedRecords,
      duplicates,
      warnings,
    };
  }

  protected countDuplicates(records: ActivityImport[]) {
    const seen = new Set<string>();
    let duplicates = 0;

    for (const record of records) {
      const key = this.getRecordKey(record);
      if (seen.has(key)) {
        duplicates += 1;
      }
      seen.add(key);
    }

    return duplicates;
  }

  protected getRecordKey(record: ActivityImport) {
    const timestamp =
      record.date instanceof Date
        ? record.date.toISOString()
        : record.date
          ? String(record.date)
          : '';
    const amount = record.amount ?? 0;
    const currency =
      typeof record.currency === 'string' ? record.currency.trim() : '';
    const comment =
      typeof record.comment === 'string'
        ? record.comment.trim().replace(/\s+/g, ' ').toLowerCase()
        : '';
    return `${timestamp}|${amount}|${currency.toUpperCase()}|${comment}`;
  }

  protected normalizeRecord(record: ActivityImport) {
    const normalizeValue = (value: number | undefined) => {
      if (value === undefined || value === null) {
        return value;
      }
      return Number.isFinite(value) ? Math.abs(value) : value;
    };

    return {
      ...record,
      amount: normalizeValue(record.amount),
      quantity: normalizeValue(record.quantity),
      unitPrice: normalizeValue(record.unitPrice),
      fee: normalizeValue(record.fee),
    };
  }

  protected normalizeHeader(value: unknown) {
    return String(value ?? '')
      .replace(/^\uFEFF/, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  protected parseAmount(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value
      .replace(/\s/g, '')
      .replace(',', '.')
      .replace(/[^0-9.\-]/g, '');
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }
}
