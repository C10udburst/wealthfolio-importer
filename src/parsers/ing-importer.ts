import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

export class IngImporter extends BaseImporter {
  id = 'ing' as const;
  label = 'ING Bank';
  supportedExtensions = ['csv'];
  fileNamePattern = /^Lista_transakcji_nr_\d+_\d+\.csv$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.85,
        reason: 'Filename matches ING export pattern',
      };
    }
    return null;
  }

  async parse(file: File, options: ParseOptions): Promise<ImportParseResult> {
    const requiredHeaders = [
      'Data księgowania',
      'Tytuł',
      'Kwota transakcji (waluta rachunku)',
    ];

    const { rows, headerIndex, usedEncoding, headerWarning } = await parseIngFile(
      file,
      requiredHeaders,
      (value) => this.normalizeHeader(value),
    );

    if (!rows || headerIndex < 0) {
      return this.finalize([], [headerWarning ?? 'Unable to locate the required header row.']);
    }

    const headerRow = rows[headerIndex];
    const normalizedHeaders = headerRow.map((cell) => this.normalizeHeader(cell));

    const dateIndex = normalizedHeaders.indexOf(this.normalizeHeader('Data księgowania'));
    const commentIndex = normalizedHeaders.indexOf(this.normalizeHeader('Tytuł'));
    const amountIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Kwota transakcji (waluta rachunku)'),
    );
    const transactionIdIndex = normalizedHeaders.indexOf(this.normalizeHeader('Nr transakcji'));
    const currencyIndex = normalizedHeaders.findIndex(
      (header, index) => header === this.normalizeHeader('Waluta') && index > amountIndex,
    );

    if (dateIndex < 0 || commentIndex < 0 || amountIndex < 0) {
      return this.finalize([], ['ING header row is missing required columns.']);
    }

    const records: ActivityImport[] = [];
    const warnings: string[] = [];
    if (usedEncoding && usedEncoding !== 'utf-8') {
      warnings.push(`Decoded ING file using ${usedEncoding}.`);
    }

    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) {
        continue;
      }

      const dateValue = row[dateIndex];
      const amountValue = row[amountIndex];
      const commentValue = row[commentIndex];
      const currencyValue = currencyIndex >= 0 ? row[currencyIndex] : null;
      const transactionIdValue =
        transactionIdIndex >= 0 ? row[transactionIdIndex] : null;

      const amount = this.parseAmount(amountValue);
      const date = parseIngDate(dateValue);

      const rowIsEmpty = !dateValue && !amountValue && !commentValue;
      if (rowIsEmpty) {
        continue;
      }

      if (!date || amount === null) {
        warnings.push(`Skipped row ${i + 1}: missing date or amount.`);
        continue;
      }

      const currency =
        typeof currencyValue === 'string' && currencyValue.trim()
          ? currencyValue.trim().toUpperCase()
          : options.accountCurrency || 'USD';
      if (!currencyValue && !options.accountCurrency) {
        warnings.push(`Row ${i + 1}: missing currency, defaulted to USD.`);
      }

      const activityType = mapIngActivityType(
        typeof commentValue === 'string' ? commentValue : String(commentValue ?? ''),
        amount,
      );
      const cashSymbol = `$CASH-${currency}`;

      records.push({
        accountId: options.accountId,
        activityType,
        date,
        symbol: cashSymbol,
        amount,
        currency,
        isDraft: true,
        isValid: true,
        comment: buildIngComment(commentValue, transactionIdValue),
        lineNumber: i + 1,
      });
    }

    return this.finalize(records, warnings);
  }
}

const parseIngFile = async (
  file: File,
  requiredHeaders: string[],
  normalize: (value: unknown) => string,
) => {
  const buffer = await file.arrayBuffer();
  const encodings = ['utf-8', 'windows-1250', 'iso-8859-2'];
  let selectedRows: string[][] | null = null;
  let headerIndex = -1;
  let usedEncoding: string | null = null;

  for (const encoding of encodings) {
    const decoded = decodeBuffer(buffer, encoding);
    if (decoded === null) {
      continue;
    }
    const rows = parseDelimited(decoded, ';');
    const index = findHeaderIndex(rows, requiredHeaders, normalize);
    if (index >= 0) {
      selectedRows = rows;
      headerIndex = index;
      usedEncoding = encoding;
      break;
    }
  }

  const headerWarning =
    headerIndex < 0
      ? 'Unable to locate the required header row. Check encoding or file format.'
      : null;

  return {
    rows: selectedRows,
    headerIndex,
    usedEncoding,
    headerWarning,
  };
};

const decodeBuffer = (buffer: ArrayBuffer, encoding: string) => {
  try {
    const decoder = new TextDecoder(encoding);
    return decoder.decode(buffer);
  } catch {
    return null;
  }
};

const findHeaderIndex = (
  rows: string[][],
  requiredHeaders: string[],
  normalize: (value: unknown) => string,
) =>
  rows.findIndex((row) => {
    const normalizedRow = row.map((cell) => normalize(cell));
    return requiredHeaders.every((header) =>
      normalizedRow.includes(normalize(header)),
    );
  });

const parseDelimited = (text: string, delimiter: string) => {
  const rows: string[][] = [];
  let currentField = '';
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '"') {
      const nextChar = text[i + 1];
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
};

const parseIngDate = (value: unknown) => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const direct = new Date(text);
  if (!Number.isNaN(direct.valueOf())) {
    return direct;
  }

  const normalized = text.replace(/\./g, '-');
  const parts = normalized.split('-');
  if (parts.length === 3) {
    const [day, month, year] = parts.map((part) => Number(part));
    if (
      Number.isFinite(day) &&
      Number.isFinite(month) &&
      Number.isFinite(year) &&
      day > 0 &&
      month > 0
    ) {
      return new Date(year, month - 1, day);
    }
  }

  return null;
};

const sanitizeIngText = (value: unknown) => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const trimmed = text.trim();
  return trimmed.replace(/^['"]+|['"]+$/g, '').trim();
};

const buildIngComment = (commentValue: unknown, transactionIdValue: unknown) => {
  const title = sanitizeIngText(commentValue);
  const transactionId = sanitizeIngText(transactionIdValue);

  if (title && transactionId) {
    return `${title} (Nr transakcji: ${transactionId})`;
  }
  if (title) {
    return title;
  }
  if (transactionId) {
    return `Nr transakcji: ${transactionId}`;
  }

  return '';
};

const mapIngActivityType = (commentValue: string, amount: number) => {
  const normalized = commentValue.toUpperCase().replace(/\s+/g, ' ').trim();
  if (normalized.includes('PODATEK')) {
    return 'TAX';
  }
  if (normalized.includes('ODSET')) {
    return 'INTEREST';
  }
  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
};
