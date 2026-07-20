import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

const REQUIRED_HEADERS = [
  'Data operacji',
  'Typ transakcji',
  'Kwota',
  'Waluta',
  'Saldo po transakcji',
  'Opis transakcji',
];

export class PkoImporter extends BaseImporter {
  id = 'pko' as const;
  label = 'PKO Bank Polski';
  supportedExtensions = ['csv'];
  fileNamePattern = /^zestawienie operacji za \d{2}\.\d{2}\.\d{4} - \d{2}\.\d{2}\.\d{4}\.csv$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.9,
        reason: 'Filename matches PKO bank statement pattern',
      };
    }
    return null;
  }

  async parse(file: File, options: ParseOptions): Promise<ImportParseResult> {
    const { rows, headerIndex, usedEncoding, headerWarning } = await parsePkoFile(
      file,
      REQUIRED_HEADERS,
      (value) => this.normalizeHeader(value),
    );

    if (!rows || headerIndex < 0) {
      return this.finalize([], [headerWarning ?? 'Unable to locate the required header row.']);
    }

    const headerRow = rows[headerIndex];
    const normalizedHeaders = headerRow.map((cell) => this.normalizeHeader(cell));

    const dateIndex = normalizedHeaders.indexOf(this.normalizeHeader('Data operacji'));
    const valueDateIndex = normalizedHeaders.indexOf(this.normalizeHeader('Data waluty'));
    const typeIndex = normalizedHeaders.indexOf(this.normalizeHeader('Typ transakcji'));
    const amountIndex = normalizedHeaders.indexOf(this.normalizeHeader('Kwota'));
    const currencyIndex = normalizedHeaders.indexOf(this.normalizeHeader('Waluta'));
    const descriptionIndex = normalizedHeaders.indexOf(this.normalizeHeader('Opis transakcji'));

    if (
      dateIndex < 0 ||
      typeIndex < 0 ||
      amountIndex < 0 ||
      currencyIndex < 0 ||
      descriptionIndex < 0
    ) {
      return this.finalize([], ['PKO Bank statement header row is missing required columns.']);
    }

    const records: ActivityImport[] = [];
    const warnings: string[] = [];
    if (usedEncoding && usedEncoding !== 'utf-8') {
      warnings.push(`Decoded PKO file using ${usedEncoding}.`);
    }

    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) {
        continue;
      }

      const dateValue = row[dateIndex];
      const valueDateValue = valueDateIndex >= 0 ? row[valueDateIndex] : null;
      const typeValue = row[typeIndex];
      const amountValue = row[amountIndex];
      const currencyValue = row[currencyIndex];

      const rowIsEmpty = !dateValue && !amountValue && !currencyValue && !typeValue;
      if (rowIsEmpty) {
        continue;
      }

      const date = parsePkoDate(dateValue ?? valueDateValue);
      const amount = this.parseAmount(amountValue);
      if (!date || amount === null) {
        warnings.push(`Skipped row ${i + 1}: missing date or amount.`);
        continue;
      }

      const rawCurrency = sanitizePkoText(currencyValue);
      const currency = (rawCurrency || options.accountCurrency || 'PLN').toUpperCase();
      if (!rawCurrency && !options.accountCurrency) {
        warnings.push(`Row ${i + 1}: missing currency, defaulted to PLN.`);
      }

      const typeText = sanitizePkoText(typeValue);
      const comment = buildPkoComment(row, descriptionIndex);

      const activityType = mapPkoActivityType(typeText, comment, amount);
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
        comment,
        lineNumber: i + 1,
      });
    }

    return this.finalize(records, warnings);
  }
}

const sanitizePkoText = (value: unknown) => {
  if (value === null || value === undefined) {
    return '';
  }
  let text = String(value).trim();
  text = text.replace(/^['"]+|['"]+$/g, '').trim();
  // Replace U+FFFD (replacement char)
  text = text.replace(/\uFFFD/g, 'ł');
  // Fix casing for Ł in uppercase words
  text = text.replace(/WłASNY/g, 'WŁASNY');
  text = text.replace(/\s+/g, ' ');
  return text;
};

const parsePkoDate = (value: unknown) => {
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

  const buildValidatedDate = (year: number, month: number, day: number) => {
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
      return null;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    const parsed = new Date(year, month - 1, day);
    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day
    ) {
      return null;
    }

    return parsed;
  };

  const dayMonthYearMatch = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (dayMonthYearMatch) {
    const [, dayText, monthText, yearText] = dayMonthYearMatch;
    return buildValidatedDate(Number(yearText), Number(monthText), Number(dayText));
  }

  const isoDateMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoDateMatch) {
    const [, yearText, monthText, dayText] = isoDateMatch;
    return buildValidatedDate(Number(yearText), Number(monthText), Number(dayText));
  }

  const direct = new Date(text);
  if (!Number.isNaN(direct.valueOf())) {
    return direct;
  }

  return null;
};

const mapPkoActivityType = (type: string, comment: string, amount: number) => {
  const combined = `${type} ${comment}`.toLowerCase();

  if (combined.includes('odsetk')) {
    return 'INTEREST';
  }
  if (combined.includes('podatek')) {
    return 'TAX';
  }
  if (
    combined.includes('prowiz') ||
    combined.includes('opłat') ||
    combined.includes('oplat') ||
    combined.includes('fee')
  ) {
    return 'FEE';
  }

  if (
    combined.includes('karta') ||
    combined.includes('płatno') ||
    combined.includes('platno') ||
    combined.includes('blik') ||
    combined.includes('wypłat') ||
    combined.includes('wyplat')
  ) {
    return 'WITHDRAWAL';
  }

  if (combined.includes('wpłat') || combined.includes('wplat')) {
    return 'DEPOSIT';
  }

  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
};

const buildPkoComment = (row: string[], startIndex: number) => {
  const parts: string[] = [];
  for (let i = startIndex; i < row.length; i += 1) {
    const value = sanitizePkoText(row[i]);
    if (value) {
      parts.push(value);
    }
  }
  return parts.join(', ');
};

const parsePkoFile = async (
  file: File,
  requiredHeaders: string[],
  normalize: (value: unknown) => string,
) => {
  const buffer = await file.arrayBuffer();
  const encodings = ['utf-8', 'windows-1250', 'iso-8859-2'];
  const delimiters = [',', ';'];
  let selectedRows: string[][] | null = null;
  let headerIndex = -1;
  let usedEncoding: string | null = null;

  for (const encoding of encodings) {
    const decoded = decodeBuffer(buffer, encoding);
    if (decoded === null) {
      continue;
    }
    for (const delimiter of delimiters) {
      const rows = parseDelimited(decoded, delimiter);
      const index = findHeaderIndex(rows, requiredHeaders, normalize);
      if (index >= 0) {
        selectedRows = rows;
        headerIndex = index;
        usedEncoding = encoding;
        break;
      }
    }
    if (headerIndex >= 0) {
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
    return requiredHeaders.every((header) => normalizedRow.includes(normalize(header)));
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
