import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

const REQUIRED_CORE_HEADERS = ['type', 'time', 'amount', 'id', 'comment'];
const CASH_OPERATIONS_SHEET_NAMES = [
  'cash operations',
  'operacje gotówkowe',
  'operacje gotowkowe',
  'cash operation history',
  'historia operacji',
];

const parseExcelDateTime = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) {
      return null;
    }
    return new Date(
      Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, parsed.S),
    );
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    const isoMatch = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (isoMatch) {
      const [, year, month, day, hours, minutes, seconds = '0'] = isoMatch;
      return new Date(
        Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hours),
          Number(minutes),
          Number(seconds),
        ),
      );
    }
    const euMatch = normalized.match(
      /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (euMatch) {
      const [, day, month, year, hours, minutes, seconds = '0'] = euMatch;
      return new Date(
        Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hours),
          Number(minutes),
          Number(seconds),
        ),
      );
    }
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  return null;
};

const parseNumericString = (value: string): number | null => {
  const normalized = value
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^0-9.\-]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
};

const sanitizeXtbText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : String(value ?? '').trim();

const extractCurrencyFromXlsxName = (entryName: string): string | null => {
  const segments = entryName.split('/');
  const fileName = segments[segments.length - 1] ?? '';
  const match = fileName.match(/^([A-Z]{3})_/i);
  return match ? match[1].toUpperCase() : null;
};

const extractCurrencyFromWorkbook = (workbook: XLSX.WorkBook): string | null => {
  const openPosSheet =
    workbook.Sheets['Open Positions'] ??
    workbook.Sheets['Pozycje otwarte'];
  if (!openPosSheet) {
    return null;
  }
  const rows = XLSX.utils.sheet_to_json(openPosSheet, {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];
  for (const row of rows) {
    if (Array.isArray(row)) {
      for (const cell of row) {
        if (typeof cell === 'string') {
          const trimmed = cell.trim().toUpperCase();
          if (['PLN', 'USD', 'EUR', 'GBP', 'CHF'].includes(trimmed)) {
            return trimmed;
          }
        }
      }
    }
  }
  return null;
};

const readXlsxFromZip = async (buffer: ArrayBuffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const xlsxEntries = Object.values(zip.files)
    .filter((entry) => !entry.dir && /\.xlsx$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (xlsxEntries.length === 0) {
    return {
      xlsxBuffer: null,
      entryName: null,
      warnings: ['ZIP archive does not contain an XLSX file.'],
    };
  }

  const warnings: string[] = [];
  if (xlsxEntries.length > 1) {
    warnings.push('ZIP archive contains multiple XLSX files; used the first one.');
  }

  const selectedEntry = xlsxEntries[0];
  const xlsxBuffer = await selectedEntry.async('arraybuffer');
  return {
    xlsxBuffer,
    entryName: selectedEntry.name,
    warnings,
  };
};

const loadXlsxFile = async (file: File) => {
  const buffer = await file.arrayBuffer();
  const isZipByName = /\.zip$/i.test(file.name);

  if (isZipByName) {
    try {
      const zipResult = await readXlsxFromZip(buffer);
      if (zipResult.xlsxBuffer) {
        return zipResult;
      }
    } catch {
      // If JSZip fails, fallback to direct buffer
    }
  }

  // Check if buffer is a zip file (magic bytes PK\x03\x04)
  try {
    const zipResult = await readXlsxFromZip(buffer);
    if (zipResult.xlsxBuffer) {
      return zipResult;
    }
  } catch {
    // Not a zip archive containing an .xlsx
  }

  return {
    xlsxBuffer: buffer,
    entryName: file.name,
    warnings: [],
  };
};

const extractTradeDetails = (comment: string) => {
  const trimmed = comment.trim();
  if (!trimmed) {
    return { quantity: null, unitPrice: null };
  }

  const patterns = [
    // Matches "OPEN BUY ETFBM40TR.PL 0.4 @ 171.92" or "OPEN BUY 0.4 @ 171.92" or "CLOSE BUY ... 0.4 / 0.4 @ 171.92"
    /(?:(?:open|close)\s+)?(?:buy|sell)\s+(?:.*?\s+)?([\d.,]+)(?:\s*\/\s*[\d.,]+)?\s*@\s*([\d.,]+)/i,
    // Fallback: any "<quantity> @ <price>"
    /([\d.,]+)(?:\s*\/\s*[\d.,]+)?\s*@\s*([\d.,]+)/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      const quantity = parseNumericString(match[1]);
      const unitPrice = parseNumericString(match[2]);
      return { quantity, unitPrice };
    }
  }

  return { quantity: null, unitPrice: null };
};

const ACTIVITY_TYPES = {
  BUY: 'BUY',
  SELL: 'SELL',
  DIVIDEND: 'DIVIDEND',
  INTEREST: 'INTEREST',
  TAX: 'TAX',
  FEE: 'FEE',
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
} as const;

type ActivityTypeValue = (typeof ACTIVITY_TYPES)[keyof typeof ACTIVITY_TYPES];

const mapActivityType = (value: string, amount: number | null): ActivityTypeValue => {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'stock purchase':
      return ACTIVITY_TYPES.BUY;
    case 'stock sale':
    case 'close trade':
      return ACTIVITY_TYPES.SELL;
    case 'dividend':
      return ACTIVITY_TYPES.DIVIDEND;
    case 'free-funds interest':
    case 'interest':
      return ACTIVITY_TYPES.INTEREST;
    case 'free-funds interest tax':
    case 'withholding tax':
    case 'dividend tax':
    case 'interest tax':
    case 'tax':
      return ACTIVITY_TYPES.TAX;
    case 'sec fee':
    case 'fee':
    case 'commission':
      return ACTIVITY_TYPES.FEE;
    case 'deposit':
      return ACTIVITY_TYPES.DEPOSIT;
    case 'withdrawal':
      return ACTIVITY_TYPES.WITHDRAWAL;
    default:
      if (amount !== null) {
        return amount >= 0 ? ACTIVITY_TYPES.DEPOSIT : ACTIVITY_TYPES.WITHDRAWAL;
      }
      return ACTIVITY_TYPES.DEPOSIT;
  }
};

export class XtbImporter extends BaseImporter {
  id = 'xtb' as const;
  label = 'XTB Broker';
  supportedExtensions = ['zip', 'xlsx', 'xls'];
  fileNamePattern = /^([a-z]{3}_)?\d+_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.(?:zip|xlsx|xls)$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.95,
        reason: 'Filename matches XTB export pattern',
      };
    }
    return null;
  }

  async parse(file: File, options: ParseOptions): Promise<ImportParseResult> {
    const { xlsxBuffer, entryName, warnings } = await loadXlsxFile(file);
    if (!xlsxBuffer) {
      return this.finalize([], warnings);
    }

    const workbook = XLSX.read(xlsxBuffer, { type: 'array', cellDates: true });
    const sheetName =
      workbook.SheetNames.find((name) =>
        CASH_OPERATIONS_SHEET_NAMES.includes(this.normalizeHeader(name)),
      ) ??
      workbook.SheetNames.find((name) => {
        const sheet = workbook.Sheets[name];
        if (!sheet) return false;
        const rows = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: null,
          raw: true,
        }) as unknown[][];
        return rows.some((row) => {
          const normalized = row.map((cell) => this.normalizeHeader(cell));
          return ['type', 'time', 'amount'].every((h) => normalized.includes(h));
        });
      }) ??
      workbook.SheetNames[0];

    if (!sheetName) {
      return this.finalize([], [...warnings, 'Unable to locate a worksheet in the XLSX file.']);
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      raw: true,
    }) as unknown[][];

    const headerIndex = rows.findIndex((row) => {
      const normalizedRow = row.map((cell) => this.normalizeHeader(cell));
      const hasCore = REQUIRED_CORE_HEADERS.every((header) =>
        normalizedRow.includes(header),
      );
      const hasTickerOrSymbol =
        normalizedRow.includes('ticker') || normalizedRow.includes('symbol');
      return hasCore && hasTickerOrSymbol;
    });

    if (headerIndex < 0) {
      return this.finalize([], ['Unable to locate the required header row in Cash Operations.']);
    }

    const headerRow = rows[headerIndex];
    const normalizedHeaders = headerRow.map((cell) => this.normalizeHeader(cell));

    const typeIndex = normalizedHeaders.indexOf('type');
    const tickerIndex =
      normalizedHeaders.indexOf('ticker') >= 0
        ? normalizedHeaders.indexOf('ticker')
        : normalizedHeaders.indexOf('symbol');
    const instrumentIndex = normalizedHeaders.indexOf('instrument');
    const timeIndex = normalizedHeaders.indexOf('time');
    const amountIndex = normalizedHeaders.indexOf('amount');
    const commentIndex = normalizedHeaders.indexOf('comment');
    const idIndex = normalizedHeaders.indexOf('id');

    const records: ActivityImport[] = [];
    const parseWarnings = [...warnings];
    const fileCurrency =
      (entryName ? extractCurrencyFromXlsxName(entryName) : null) ??
      extractCurrencyFromWorkbook(workbook);
    const fallbackCurrency = options.accountCurrency || 'USD';
    const currency = (fileCurrency || fallbackCurrency).toUpperCase();
    if (!fileCurrency && !options.accountCurrency) {
      parseWarnings.push('Currency not found in file; defaulted to USD.');
    }

    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) {
        continue;
      }

      const typeValue = typeIndex >= 0 ? row[typeIndex] : null;
      const tickerValue = tickerIndex >= 0 ? row[tickerIndex] : null;
      const instrumentValue = instrumentIndex >= 0 ? row[instrumentIndex] : null;
      const timeValue = timeIndex >= 0 ? row[timeIndex] : null;
      const amountValue = amountIndex >= 0 ? row[amountIndex] : null;
      const commentValue = commentIndex >= 0 ? row[commentIndex] : null;
      const idValue = idIndex >= 0 ? row[idIndex] : null;

      const type = sanitizeXtbText(typeValue);
      if (['total', 'razem', 'suma'].includes(type.toLowerCase())) {
        continue;
      }

      const time = parseExcelDateTime(timeValue);
      const amount = this.parseAmount(amountValue);

      const rowIsEmpty =
        !type && !timeValue && !commentValue && !tickerValue && amountValue === null;
      if (rowIsEmpty) {
        continue;
      }

      if (!time || amount === null) {
        parseWarnings.push(`Skipped row ${i + 1}: missing time or amount.`);
        continue;
      }

      const activityType = mapActivityType(type || 'Unknown', amount);

      const rawSymbol = sanitizeXtbText(tickerValue || instrumentValue).toUpperCase();
      const cashSymbol = `$CASH-${currency.toUpperCase()}`;
      const comment = sanitizeXtbText(commentValue);
      const idText = sanitizeXtbText(idValue);

      const isTradeActivity =
        activityType === ACTIVITY_TYPES.BUY || activityType === ACTIVITY_TYPES.SELL;
      const symbol =
        (isTradeActivity || activityType === ACTIVITY_TYPES.DIVIDEND) && rawSymbol
          ? rawSymbol
          : cashSymbol;

      if (!rawSymbol && isTradeActivity) {
        parseWarnings.push(`Row ${i + 1}: missing ticker for trade activity.`);
      }

      let finalComment =
        !isTradeActivity && rawSymbol && !comment.toUpperCase().includes(rawSymbol)
          ? comment
            ? `${comment} (${rawSymbol})`
            : rawSymbol
          : comment;
      if (idText) {
        finalComment = finalComment
          ? `${finalComment} (ID: ${idText})`
          : `ID: ${idText}`;
      }

      let { quantity, unitPrice } = isTradeActivity
        ? extractTradeDetails(comment)
        : { quantity: null, unitPrice: null };

      if (isTradeActivity && amount !== null) {
        if (quantity !== null && quantity !== 0) {
          unitPrice = Math.abs(amount) / quantity;
        } else if (unitPrice !== null && unitPrice !== 0) {
          quantity = Math.abs(amount) / unitPrice;
        }
      }

      records.push({
        accountId: options.accountId,
        activityType,
        date: time,
        symbol,
        amount,
        currency,
        quantity: quantity ?? undefined,
        unitPrice: unitPrice ?? undefined,
        isDraft: true,
        isValid: true,
        comment: finalComment,
        lineNumber: i + 1,
      });
    }

    return this.finalize(records, parseWarnings);
  }
}
