import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

const REQUIRED_HEADERS = ['Data', 'Godzina', 'Waluta', 'Netto'];

const parsePayPalDate = (dateValue: unknown, timeValue: unknown) => {
  if (!dateValue) {
    return null;
  }
  if (dateValue instanceof Date) {
    return dateValue;
  }
  const dateText = String(dateValue ?? '').trim();
  if (!dateText) {
    return null;
  }
  const dateParts = dateText.replace(/\./g, '-').split('-');
  if (dateParts.length !== 3) {
    const direct = new Date(dateText);
    return Number.isNaN(direct.valueOf()) ? null : direct;
  }

  const [first, secondPart, third] = dateParts.map((part) => Number(part));
  if (![first, secondPart, third].every((part) => Number.isFinite(part))) {
    return null;
  }
  const [year, month, day] =
    dateParts[0].length === 4
      ? [first, secondPart, third]
      : [third, secondPart, first];

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const timeText = String(timeValue ?? '').trim();
  const timeParts = timeText ? timeText.split(':').map((part) => Number(part)) : [];
  const [hour, minute, second] = [
    timeParts[0] ?? 0,
    timeParts[1] ?? 0,
    timeParts[2] ?? 0,
  ];

  return new Date(year, month - 1, day, hour, minute, second);
};

const sanitizePayPalText = (value: unknown) => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const trimmed = text.trim();
  return trimmed.replace(/^['"]+|['"]+$/g, '').trim();
};

const parsePayPalFile = async (
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
    const rows = parseDelimited(decoded, ',');
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

export class PayPalImporter extends BaseImporter {
  id = 'paypal' as const;
  label = 'PayPal';
  supportedExtensions = ['csv'];
  fileNamePattern = /^Download.*\.CSV$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.85,
        reason: 'Filename matches PayPal export pattern',
      };
    }
    return null;
  }

  async parse(file: File, options: ParseOptions): Promise<ImportParseResult> {
    const { rows, headerIndex, usedEncoding, headerWarning } = await parsePayPalFile(
      file,
      REQUIRED_HEADERS,
      (value) => this.normalizeHeader(value),
    );

    if (!rows || headerIndex < 0) {
      return this.finalize([], [headerWarning ?? 'Unable to locate the required header row.']);
    }

    const headerRow = rows[headerIndex];
    const normalizedHeaders = headerRow.map((cell) => this.normalizeHeader(cell));

    const dateIndex = normalizedHeaders.indexOf(this.normalizeHeader('Data'));
    const timeIndex = normalizedHeaders.indexOf(this.normalizeHeader('Godzina'));
    const nameIndex = normalizedHeaders.indexOf(this.normalizeHeader('Nazwa'));
    const typeIndex = normalizedHeaders.indexOf(this.normalizeHeader('Typ'));
    const currencyIndex = normalizedHeaders.indexOf(this.normalizeHeader('Waluta'));
    const feeIndex = normalizedHeaders.indexOf(this.normalizeHeader('Opłata'));
    const netIndex = normalizedHeaders.indexOf(this.normalizeHeader('Netto'));
    const transactionIdIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Numer transakcji'),
    );
    const itemNameIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Nazwa przedmiotu'),
    );
    const subjectIndex = normalizedHeaders.indexOf(this.normalizeHeader('Temat'));
    const noteIndex = normalizedHeaders.indexOf(this.normalizeHeader('Uwaga'));
    const balanceImpactIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Wpływ na saldo'),
    );

    if (dateIndex < 0 || timeIndex < 0 || currencyIndex < 0 || netIndex < 0) {
      return this.finalize([], ['PayPal header row is missing required columns.']);
    }

    const records: ActivityImport[] = [];
    const warnings: string[] = [];
    if (usedEncoding && usedEncoding !== 'utf-8') {
      warnings.push(`Decoded PayPal file using ${usedEncoding}.`);
    }

    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) {
        continue;
      }

      const dateValue = row[dateIndex];
      const timeValue = row[timeIndex];
      const nameValue = nameIndex >= 0 ? row[nameIndex] : null;
      const typeValue = typeIndex >= 0 ? row[typeIndex] : null;
      const currencyValue = row[currencyIndex];
      const netValue = row[netIndex];
      const feeValue = feeIndex >= 0 ? row[feeIndex] : null;
      const balanceImpactValue =
        balanceImpactIndex >= 0 ? row[balanceImpactIndex] : null;

      const rowIsEmpty = !dateValue && !timeValue && !currencyValue && !netValue;
      if (rowIsEmpty) {
        continue;
      }

      const date = parsePayPalDate(dateValue, timeValue);
      const netAmount = this.parseAmount(netValue);

      if (!date || netAmount === null) {
        warnings.push(`Skipped row ${i + 1}: missing date/time or net amount.`);
        continue;
      }

      let amount = netAmount;
      const impactText = sanitizePayPalText(balanceImpactValue).toLowerCase();
      const impactPlain = impactText
        ? impactText.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        : '';
      if (impactPlain.includes('obciazenie') || impactText.includes('obciążenie')) {
        amount = -Math.abs(amount);
      } else if (impactPlain.includes('uznanie')) {
        amount = Math.abs(amount);
      }

      const currency =
        typeof currencyValue === 'string' && currencyValue.trim()
          ? currencyValue.trim().toUpperCase()
          : options.accountCurrency || 'USD';
      if (!currencyValue && !options.accountCurrency) {
        warnings.push(`Row ${i + 1}: missing currency, defaulted to USD.`);
      }

      const activityType = amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
      const cashSymbol = `$CASH-${currency}`;

      const name = sanitizePayPalText(nameValue);
      const typeText = sanitizePayPalText(typeValue);
      const itemName = sanitizePayPalText(itemNameIndex >= 0 ? row[itemNameIndex] : '');
      const subject = sanitizePayPalText(subjectIndex >= 0 ? row[subjectIndex] : '');
      const note = sanitizePayPalText(noteIndex >= 0 ? row[noteIndex] : '');
      const transactionId = sanitizePayPalText(
        transactionIdIndex >= 0 ? row[transactionIdIndex] : '',
      );
      const commentParts = [name, typeText, itemName, subject, note].filter(Boolean);
      let comment = commentParts.join(' - ');
      if (transactionId) {
        comment = comment ? `${comment} (ID: ${transactionId})` : `ID: ${transactionId}`;
      }

      const feeAmount = feeValue !== null ? this.parseAmount(feeValue) : null;
      const fee = feeAmount !== null && feeAmount !== 0 ? feeAmount : undefined;

      records.push({
        accountId: options.accountId,
        activityType,
        date,
        symbol: cashSymbol,
        amount,
        currency,
        fee,
        isDraft: true,
        isValid: true,
        comment,
        lineNumber: i + 1,
      });
    }

    return this.finalize(records, warnings);
  }
}
