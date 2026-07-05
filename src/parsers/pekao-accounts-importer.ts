import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

const REQUIRED_HEADERS = [
  'Data księgowania',
  'Tytułem',
  'Kwota operacji',
  'Waluta',
  'Typ operacji',
];

export class PekaoAccountsImporter extends BaseImporter {
  id = 'pekao-accounts' as const;
  label = 'Pekao Accounts';
  supportedExtensions = ['csv'];
  fileNamePattern = /^Lista_operacji_\d{8}_\d{6}\.csv$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.9,
        reason: 'Filename matches Pekao accounts export pattern',
      };
    }
    return null;
  }

  async parse(file: File, options: ParseOptions): Promise<ImportParseResult> {
    const { rows, headerIndex, usedEncoding, headerWarning } = await parsePekaoAccountsFile(
      file,
      REQUIRED_HEADERS,
      (value) => this.normalizeHeader(value),
    );

    if (!rows || headerIndex < 0) {
      return this.finalize([], [headerWarning ?? 'Unable to locate the required header row.']);
    }

    const headerRow = rows[headerIndex];
    const normalizedHeaders = headerRow.map((cell) => this.normalizeHeader(cell));

    const bookingDateIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Data księgowania'),
    );
    const valueDateIndex = normalizedHeaders.indexOf(this.normalizeHeader('Data waluty'));
    const counterpartyIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Nadawca / Odbiorca'),
    );
    const sourceAccountIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Rachunek źródłowy'),
    );
    const targetAccountIndex = normalizedHeaders.indexOf(
      this.normalizeHeader('Rachunek docelowy'),
    );
    const titleIndex = normalizedHeaders.indexOf(this.normalizeHeader('Tytułem'));
    const amountIndex = normalizedHeaders.indexOf(this.normalizeHeader('Kwota operacji'));
    const currencyIndex = normalizedHeaders.indexOf(this.normalizeHeader('Waluta'));
    const referenceIndex = normalizedHeaders.indexOf(this.normalizeHeader('Numer referencyjny'));
    const operationTypeIndex = normalizedHeaders.indexOf(this.normalizeHeader('Typ operacji'));

    if (bookingDateIndex < 0 || titleIndex < 0 || amountIndex < 0 || currencyIndex < 0) {
      return this.finalize([], ['Pekao Accounts header row is missing required columns.']);
    }

    const records: ActivityImport[] = [];
    const warnings: string[] = [];
    if (usedEncoding && usedEncoding !== 'utf-8') {
      warnings.push(`Decoded Pekao accounts file using ${usedEncoding}.`);
    }

    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) {
        continue;
      }

      const bookingDateValue = row[bookingDateIndex];
      const valueDateValue = valueDateIndex >= 0 ? row[valueDateIndex] : null;
      const amountValue = row[amountIndex];
      const currencyValue = row[currencyIndex];
      const titleValue = row[titleIndex];
      const counterpartyValue = counterpartyIndex >= 0 ? row[counterpartyIndex] : null;
      const referenceValue = referenceIndex >= 0 ? row[referenceIndex] : null;
      const operationTypeValue = operationTypeIndex >= 0 ? row[operationTypeIndex] : null;
      const sourceAccountValue = sourceAccountIndex >= 0 ? row[sourceAccountIndex] : null;
      const targetAccountValue = targetAccountIndex >= 0 ? row[targetAccountIndex] : null;

      const rowIsEmpty =
        !bookingDateValue && !amountValue && !currencyValue && !titleValue && !counterpartyValue;
      if (rowIsEmpty) {
        continue;
      }

      const date = parsePekaoAccountsDate(bookingDateValue ?? valueDateValue);
      const amount = this.parseAmount(amountValue);
      if (!date || amount === null) {
        warnings.push(`Skipped row ${i + 1}: missing date or amount.`);
        continue;
      }

      const rawCurrency = sanitizePekaoAccountsText(currencyValue);
      const currency = (rawCurrency || options.accountCurrency || 'PLN').toUpperCase();
      if (!rawCurrency && !options.accountCurrency) {
        warnings.push(`Row ${i + 1}: missing currency, defaulted to PLN.`);
      }

      const operationType = sanitizePekaoAccountsText(operationTypeValue);
      const title = sanitizePekaoAccountsText(titleValue);
      const counterparty = sanitizePekaoAccountsText(counterpartyValue);
      const reference = sanitizePekaoAccountsText(referenceValue);
      const sourceAccount = sanitizePekaoAccountsText(sourceAccountValue);
      const targetAccount = sanitizePekaoAccountsText(targetAccountValue);

      const activityType = mapPekaoAccountsActivityType(operationType, title, amount);
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
        comment: buildPekaoAccountsComment({
          title,
          operationType,
          counterparty,
          reference,
          sourceAccount,
          targetAccount,
        }),
        lineNumber: i + 1,
      });
    }

    return this.finalize(records, warnings);
  }
}

const sanitizePekaoAccountsText = (value: unknown) => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.trim().replace(/^['"]+|['"]+$/g, '').trim();
};

const parsePekaoAccountsDate = (value: unknown) => {
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

const mapPekaoAccountsActivityType = (operationType: string, title: string, amount: number) => {
  const combined = `${operationType} ${title}`.toLowerCase();

  if (combined.includes('odsetk')) {
    return 'INTEREST';
  }
  if (combined.includes('podatek')) {
    return 'TAX';
  }
  if (
    combined.includes('prowiz') ||
    combined.includes('opłata') ||
    combined.includes('oplata') ||
    combined.includes('fee')
  ) {
    return 'FEE';
  }

  if (combined.includes('przelew') || combined.includes('transfer')) {
    return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
  }

  if (
    combined.includes('karta') ||
    combined.includes('płatno') ||
    combined.includes('platno') ||
    combined.includes('blik') ||
    combined.includes('wypłata') ||
    combined.includes('wyplata')
  ) {
    return 'WITHDRAWAL';
  }

  if (combined.includes('wpłata') || combined.includes('wplata')) {
    return 'DEPOSIT';
  }

  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
};

const buildPekaoAccountsComment = (data: {
  title: string;
  operationType: string;
  counterparty: string;
  reference: string;
  sourceAccount: string;
  targetAccount: string;
}) => {
  const parts = [data.title, data.operationType].filter(Boolean);
  let comment = parts.join(' - ').trim();

  if (data.counterparty && !comment.toLowerCase().includes(data.counterparty.toLowerCase())) {
    comment = comment ? `${comment} (${data.counterparty})` : data.counterparty;
  }

  const accountBits = [data.sourceAccount, data.targetAccount].filter(Boolean);
  if (accountBits.length > 0) {
    comment = comment ? `${comment} [${accountBits.join(' → ')}]` : accountBits.join(' → ');
  }

  if (data.reference) {
    comment = comment ? `${comment} (Ref: ${data.reference})` : `Ref: ${data.reference}`;
  }

  return comment;
};

const parsePekaoAccountsFile = async (
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
