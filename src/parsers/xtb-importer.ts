import * as XLSX from 'xlsx';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

const REQUIRED_HEADERS = ['ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount'];

const parseExcelDate = (value: unknown) => {
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
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  return null;
};

const parseNumericString = (value: string) => {
  const normalized = value
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^0-9.\-]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
};

const sanitizeXtbText = (value: unknown) =>
  typeof value === 'string' ? value.trim() : String(value ?? '').trim();

const extractTradeDetails = (comment: string) => {
  const trimmed = comment.trim();
  if (!trimmed) {
    return { quantity: null, unitPrice: null };
  }

  const patterns = [
    /(?:open|close)\s+(?:buy|sell)\s+([\d.,]+)(?:\s*\/\s*[\d.,]+)?\s*@\s*([\d.,]+)/i,
    /(?:buy|sell)\s+([\d.,]+)(?:\s*\/\s*[\d.,]+)?\s*@\s*([\d.,]+)/i,
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
    case 'free-funds interest':
      return ACTIVITY_TYPES.INTEREST;
    case 'free-funds interest tax':
      return ACTIVITY_TYPES.TAX;
    case 'sec fee':
      return ACTIVITY_TYPES.FEE;
    case 'deposit':
      return ACTIVITY_TYPES.DEPOSIT;
    case 'withdrawal':
      return ACTIVITY_TYPES.WITHDRAWAL;
    case 'stock purchase':
      return ACTIVITY_TYPES.BUY;
    case 'stock sale':
      return ACTIVITY_TYPES.SELL;
    case 'close trade':
      return ACTIVITY_TYPES.SELL;
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
  supportedExtensions = ['xlsx', 'xls'];
  fileNamePattern = /^account_\d+_[a-z]{2}_xlsx_[^_]+_[^_]+\.xlsx$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.9,
        reason: 'Filename matches XTB export pattern',
      };
    }
    return null;
  }

  async parse(file: File, options: ParseOptions): Promise<ImportParseResult> {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    const sheetName = workbook.SheetNames.find(
      (name) => name.trim().toUpperCase() === 'CASH OPERATION HISTORY',
    );

    if (!sheetName) {
      return this.finalize([], [
        'Missing "CASH OPERATION HISTORY" sheet in the uploaded file.',
      ]);
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      raw: true,
    }) as unknown[][];

    const headerIndex = rows.findIndex((row) => {
      const normalizedRow = row.map((cell) => this.normalizeHeader(cell));
      return REQUIRED_HEADERS.every((header) =>
        normalizedRow.includes(this.normalizeHeader(header)),
      );
    });

    if (headerIndex < 0) {
      return this.finalize([], ['Unable to locate the required header row.']);
    }

    const headerRow = rows[headerIndex];
    const columnIndex = REQUIRED_HEADERS.reduce<Record<string, number>>(
      (acc, header) => {
        const normalizedHeader = this.normalizeHeader(header);
        const index = headerRow.findIndex(
          (cell) => this.normalizeHeader(cell) === normalizedHeader,
        );
        if (index >= 0) {
          acc[normalizedHeader] = index;
        }
        return acc;
      },
      {},
    );

    const records: ActivityImport[] = [];
    const warnings: string[] = [];

    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) {
        continue;
      }

      const idValue = row[columnIndex[this.normalizeHeader('ID')]];
      const typeValue = row[columnIndex[this.normalizeHeader('Type')]];
      const timeValue = row[columnIndex[this.normalizeHeader('Time')]];
      const commentValue = row[columnIndex[this.normalizeHeader('Comment')]];
      const symbolValue = row[columnIndex[this.normalizeHeader('Symbol')]];
      const amountValue = row[columnIndex[this.normalizeHeader('Amount')]];

      const type = typeof typeValue === 'string' ? typeValue.trim() : String(typeValue ?? '').trim();
      const time = parseExcelDate(timeValue);
      const amount = this.parseAmount(amountValue);

      const rowIsEmpty = !type && !timeValue && !commentValue && !symbolValue && !amountValue;
      if (rowIsEmpty) {
        continue;
      }

      if (!time || amount === null) {
        warnings.push(`Skipped row ${i + 1}: missing time or amount.`);
        continue;
      }

      let activityType = mapActivityType(type || 'Unknown', amount);
      const rawCurrency = null;
      const currency = (rawCurrency || options.accountCurrency || 'USD').toUpperCase();
      if (!rawCurrency && !options.accountCurrency) {
        warnings.push(`Row ${i + 1}: missing currency, defaulted to USD.`);
      }

      const rawSymbol =
        typeof symbolValue === 'string'
          ? symbolValue.trim().toUpperCase()
          : symbolValue
            ? String(symbolValue).trim().toUpperCase()
            : '';
      const cashSymbol = `$CASH-${currency.toUpperCase()}`;
      const comment = sanitizeXtbText(commentValue);
      const idText = sanitizeXtbText(idValue);
      const isProfitOfPosition = /profit of position/i.test(comment);
      if (isProfitOfPosition) {
        activityType = amount >= 0 ? ACTIVITY_TYPES.DEPOSIT : ACTIVITY_TYPES.WITHDRAWAL;
      }

      const isTradeActivity =
        activityType === ACTIVITY_TYPES.BUY || activityType === ACTIVITY_TYPES.SELL;
      const symbol = isTradeActivity ? rawSymbol || cashSymbol : cashSymbol;

      if (!rawSymbol && isTradeActivity) {
        warnings.push(`Row ${i + 1}: missing symbol for trade activity.`);
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
      if (
        isTradeActivity &&
        quantity !== null &&
        quantity !== 0 &&
        amount !== null
      ) {
        // Derive unit price from cash amount to keep trade pricing in account currency.
        unitPrice = amount / quantity;
      }

      records.push({
        accountId: options.accountId,
        activityType,
        date: time,
        symbol: symbol,
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

    return this.finalize(records, warnings);
  }
}
