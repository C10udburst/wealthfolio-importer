import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

export class PekaoImporter extends BaseImporter {
  id = 'pekao' as const;
  label = 'Pekao Bank';
  supportedExtensions = ['mhtml'];
  fileNamePattern = /^Pekao24\.mhtml$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.85,
        reason: 'Filename matches Pekao export pattern',
      };
    }
    return null;
  }

  async parse(file: File, options: ParseOptions): Promise<ImportParseResult> {
    const warnings: string[] = [];
    const mhtml = await file.text();
    const frame = findPekaoInvestmentsFrame(mhtml);

    if (!frame) {
      return this.finalize([], [
        'Unable to locate the Pekao investments frame in the MHTML file.',
      ]);
    }

    const doc = new DOMParser().parseFromString(frame.html, 'text/html');

    const { records, warnings: parseWarnings } = parsePekaoBondsCashOperations(
      doc,
      options,
      (value) => this.parseAmount(value),
    );

    warnings.push(...parseWarnings);

    return this.finalize(records, warnings);
  }
}

const DATE_PATTERN = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
const BOND_TITLE_PATTERN =
  /DSP\.K:\s*\d+\s+(\d+)\s*[- ]\s*([A-Z]{3}\d{4})/i;

const parsePekaoBondsCashOperations = (
  doc: Document,
  options: ParseOptions,
  parseAmount: (value: unknown) => number | null,
) => {
  const warnings: string[] = [];
  const records: ActivityImport[] = [];
  const table =
    doc.querySelector('pekao-bonds-history-cash-operations-table table') ??
    findPekaoCashOperationsTable(doc);

  if (!table) {
    return {
      records,
      warnings: [
        'Unable to locate Pekao bonds cash operations table in the MHTML file.',
      ],
    };
  }

  const rows = Array.from(table.querySelectorAll('tbody tr'));
  let currentDate: Date | null = null;

  rows.forEach((row, index) => {
    const dateLabel = row.querySelector('.date-value')?.textContent;
    if (dateLabel) {
      const parsedDate = parsePekaoDate(dateLabel);
      if (parsedDate) {
        currentDate = parsedDate;
      } else {
        warnings.push(
          `Row ${index + 1}: unable to parse date "${sanitizePekaoText(dateLabel)}".`,
        );
      }
      return;
    }

    const title = extractCellText(row, 'td.cdk-column-title');
    const type = extractCellText(row, 'td.cdk-column-type');
    const amountCell = row.querySelector('td.cdk-column-accountBalance');
    const amountText = sanitizePekaoText(amountCell?.textContent ?? '');

    if (!title && !type && !amountText) {
      return;
    }

    if (title.toLowerCase().startsWith('saldo')) {
      return;
    }

    if (!currentDate) {
      warnings.push(`Row ${index + 1}: missing date group for transaction.`);
      return;
    }

    const amount = parseAmount(amountText);
    if (amount === null) {
      warnings.push(`Row ${index + 1}: missing amount value.`);
      return;
    }

    const detectedCurrency = extractCurrency(amountCell);
    const currency =
      detectedCurrency ||
      (options.accountCurrency ? options.accountCurrency.toUpperCase() : 'PLN');

    if (!detectedCurrency && !options.accountCurrency) {
      warnings.push(`Row ${index + 1}: missing currency, defaulted to PLN.`);
    }

    const bondMatch = parseBondTitle(title);
    if (bondMatch) {
      const purchaseDay = currentDate.getDate();
      const dayToken = String(purchaseDay).padStart(2, '0');
      const symbol = `${bondMatch.seriesId}.${dayToken}`;
      const quantity =
        bondMatch.quantity !== null ? bondMatch.quantity : undefined;
      const unitPrice =
        bondMatch.quantity && bondMatch.quantity !== 0
          ? amount / bondMatch.quantity
          : undefined;

      if (!bondMatch.quantity) {
        warnings.push(
          `Row ${index + 1}: missing bond quantity in "${title}".`,
        );
      }

      records.push({
        accountId: options.accountId,
        activityType: amount < 0 ? 'BUY' : 'SELL',
        date: currentDate,
        symbol,
        amount,
        currency,
        quantity,
        unitPrice,
        isDraft: true,
        isValid: true,
        comment: buildPekaoComment(title, type),
        lineNumber: index + 1,
      });
      return;
    }

    const cashSymbol = `$CASH-${currency}`;
    records.push({
      accountId: options.accountId,
      activityType: mapPekaoCashActivity(type, amount),
      date: currentDate,
      symbol: cashSymbol,
      amount,
      currency,
      isDraft: true,
      isValid: true,
      comment: buildPekaoComment(title, type),
      lineNumber: index + 1,
    });
  });

  return { records, warnings };
};

const parsePekaoDate = (value: string) => {
  const match = value.match(DATE_PATTERN);
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year)
  ) {
    return null;
  }
  return new Date(year, month - 1, day);
};

const sanitizePekaoText = (value: unknown) => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/\s+/g, ' ').trim();
};

const extractCellText = (row: Element, selector: string) =>
  sanitizePekaoText(row.querySelector(selector)?.textContent ?? '');

const parseBondTitle = (title: string) => {
  const normalized = sanitizePekaoText(title);
  const match = normalized.match(BOND_TITLE_PATTERN);
  if (!match) {
    return null;
  }
  const quantity = Number(match[1]);
  return {
    quantity: Number.isFinite(quantity) ? quantity : null,
    seriesId: match[2].toUpperCase(),
  };
};

const extractCurrency = (cell: Element | null) => {
  if (!cell) {
    return null;
  }
  const suffix = sanitizePekaoText(
    cell.querySelector('.cell-label-suffix')?.textContent ?? '',
  );
  const fallback = sanitizePekaoText(cell.textContent ?? '');
  const match =
    suffix.match(/\b[A-Z]{3}\b/) ?? fallback.match(/\b[A-Z]{3}\b/);
  return match ? match[0].toUpperCase() : null;
};

const buildPekaoComment = (title: string, type: string) => {
  if (title && type && !title.toLowerCase().includes(type.toLowerCase())) {
    return `${title} (${type})`;
  }
  return title || type;
};

const mapPekaoCashActivity = (type: string, amount: number) => {
  const normalized = type.toLowerCase();
  if (normalized.includes('odsetk')) {
    return 'INTEREST';
  }
  if (normalized.includes('podatek')) {
    return 'TAX';
  }
  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
};

const findPekaoCashOperationsTable = (doc: Document) => {
  const tables = Array.from(doc.querySelectorAll('table'));
  return (
    tables.find((table) => {
      const headers = Array.from(table.querySelectorAll('th')).map((cell) =>
        sanitizePekaoText(cell.textContent ?? '').toLowerCase(),
      );
      return (
        headers.includes('nazwa operacji') &&
        headers.includes('kwota') &&
        headers.includes('saldo po operacji')
      );
    }) ?? null
  );
};

type MhtmlFrame = {
  html: string;
  contentLocation: string | null;
};

const findPekaoInvestmentsFrame = (mhtml: string): MhtmlFrame | null => {
  const boundary = extractMhtmlBoundary(mhtml);
  if (!boundary) {
    return null;
  }

  const parts = splitMhtmlParts(mhtml, boundary);
  for (const part of parts) {
    const parsed = parseMhtmlPart(part);
    if (!parsed) {
      continue;
    }
    const { headers, body } = parsed;
    const decoded = decodeMhtmlBody(body, headers);
    if (decoded && /<pekao-root-investments\b/i.test(decoded)) {
      return {
        html: decoded,
        contentLocation: headers['content-location'] ?? null,
      };
    }
  }

  return null;
};

const extractMhtmlBoundary = (mhtml: string) => {
  const headerMatch =
    mhtml.match(/boundary="([^"]+)"/i) ?? mhtml.match(/boundary=([^\s;]+)/i);
  return headerMatch ? headerMatch[1] : null;
};

const splitMhtmlParts = (mhtml: string, boundary: string) => {
  const marker = `--${boundary}`;
  const segments = mhtml.split(marker);
  const parts: string[] = [];

  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.startsWith('--')) {
      break;
    }
    parts.push(segment);
  }

  return parts;
};

const parseMhtmlPart = (part: string) => {
  const trimmed = part.replace(/^\r?\n/, '');
  const separatorMatch = trimmed.match(/\r?\n\r?\n/);
  if (!separatorMatch || separatorMatch.index === undefined) {
    return null;
  }
  const separatorIndex = separatorMatch.index;
  const separatorLength = separatorMatch[0].length;
  const rawHeaders = trimmed.slice(0, separatorIndex);
  const body = trimmed.slice(separatorIndex + separatorLength);
  const headers = parseMhtmlHeaders(rawHeaders);

  return { headers, body };
};

const parseMhtmlHeaders = (rawHeaders: string) => {
  const headers: Record<string, string> = {};
  const lines = rawHeaders.split(/\r?\n/);
  let currentHeader: string | null = null;

  for (const line of lines) {
    if (/^\s/.test(line) && currentHeader) {
      headers[currentHeader] = `${headers[currentHeader]} ${line.trim()}`;
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[name] = value;
    currentHeader = name;
  }

  return headers;
};

const decodeMhtmlBody = (body: string, headers: Record<string, string>) => {
  const transferEncoding = headers['content-transfer-encoding']?.toLowerCase();
  const contentType = headers['content-type'] ?? '';
  const charsetMatch = contentType.match(/charset="?([^";\s]+)"?/i);
  const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';

  if (transferEncoding === 'quoted-printable') {
    return decodeQuotedPrintable(body, charset);
  }

  if (transferEncoding === 'base64') {
    return decodeBase64(body, charset);
  }

  return body;
};

const decodeQuotedPrintable = (input: string, charset: string) => {
  const normalized = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '=' && i + 2 < normalized.length) {
      const hex = normalized.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(normalized.charCodeAt(i));
  }

  return decodeBytes(bytes, charset);
};

const decodeBase64 = (input: string, charset: string) => {
  const cleaned = input.replace(/\s+/g, '');

  if (typeof atob === 'function') {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return decodeBytes(Array.from(bytes), charset);
  }

  if (typeof Buffer !== 'undefined') {
    const bytes = Uint8Array.from(Buffer.from(cleaned, 'base64'));
    return decodeBytes(Array.from(bytes), charset);
  }

  return '';
};

const decodeBytes = (bytes: number[], charset: string) => {
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
};
