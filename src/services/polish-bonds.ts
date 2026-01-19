import type { AddonContext, Quote } from '@wealthfolio/addon-sdk';
import * as XLSX from 'xlsx';
import { normalizeSymbol } from '../utils/symbol-mappings';

const BONDS_URL =
  'https://www.gov.pl/attachment/b3ec5054-0cc1-45ce-900a-6242e284e65c';
const BOND_SYMBOL_PATTERN = /^([A-Z]{3}\d{4})(?:\.(\d{1,2}))?$/;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

type BondSeries = {
  seriesId: string;
  bondType: string;
  saleStart: Date;
  saleEnd: Date;
  emissionPrice: number;
  maturity: unknown;
  rateValues: Array<number | null>;
  interestValues: Array<number | null>;
};

type SheetMeta = {
  dataStartRow: number;
  rateIdx: number;
  interestIdx: number;
  rateCount: number;
  interestCount: number;
  hasSubHeader: boolean;
};

type BondMatch = {
  seriesId: string;
  purchaseDay?: number;
  bondType: string;
};

let workbookPromise: Promise<XLSX.WorkBook> | null = null;
const sheetMetaCache = new Map<string, SheetMeta>();
const sheetSeriesCache = new Map<string, Map<string, BondSeries>>();

const formatDateISO = (date: Date) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toLocalDate = (value: Date) =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate());

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(',', '.');
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toLocalDate(value);
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) {
      return null;
    }
    return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return toLocalDate(parsed);
    }
  }
  return null;
};

const addMonths = (date: Date, months: number) => {
  const year = date.getFullYear();
  const monthIndex = date.getMonth() + months;
  const day = date.getDate();
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(year, monthIndex, clampedDay);
};

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const monthsBetween = (start: Date, end: Date) => {
  let months = 0;
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cursor < end && months < 600) {
    cursor = addMonths(cursor, 1);
    months += 1;
  }
  if (cursor.getTime() !== end.getTime()) {
    return null;
  }
  return months;
};

const resolvePeriodMonths = (termMonths: number | null, periodCount: number) => {
  if (!termMonths || periodCount <= 0) {
    return null;
  }
  if (termMonths % periodCount === 0) {
    return termMonths / periodCount;
  }
  return null;
};

const parseMaturityMonths = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  const match = normalized.match(/(\d+)\s*([a-z./]+)/i);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (Number.isNaN(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  if (unit.startsWith('mies') || unit.startsWith('m.')) {
    return amount;
  }
  if (unit.startsWith('rok') || unit.startsWith('lat')) {
    return amount * 12;
  }
  return null;
};

const countNonEmptyFrom = (row: unknown[], startIdx: number) => {
  let count = 0;
  for (let idx = startIdx; idx < row.length; idx += 1) {
    const value = row[idx];
    if (value === null || value === undefined || value === '') {
      break;
    }
    count += 1;
  }
  return count;
};

const extractNumberRange = (
  row: unknown[],
  startIdx: number,
  count: number,
) => {
  const values: Array<number | null> = [];
  for (let idx = 0; idx < count; idx += 1) {
    values.push(toNumber(row[startIdx + idx]));
  }
  return values;
};

const daysBetween = (start: Date, end: Date) => {
  const startUtc = Date.UTC(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
  );
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((endUtc - startUtc) / MS_PER_DAY));
};

const resolvePurchaseDate = (
  saleStart: Date,
  saleEnd: Date,
  purchaseDay?: number,
) => {
  if (!purchaseDay || purchaseDay < 1 || purchaseDay > 31) {
    return saleStart;
  }
  const cursor = new Date(
    saleStart.getFullYear(),
    saleStart.getMonth(),
    saleStart.getDate(),
  );
  const end = new Date(
    saleEnd.getFullYear(),
    saleEnd.getMonth(),
    saleEnd.getDate(),
  );

  while (cursor <= end) {
    if (cursor.getDate() === purchaseDay) {
      return new Date(cursor);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return saleStart;
};

const parseBondSymbol = (symbol: string): BondMatch | null => {
  const normalized = normalizeSymbol(symbol);
  const match = BOND_SYMBOL_PATTERN.exec(normalized);
  if (!match) {
    return null;
  }
  const seriesId = match[1];
  const bondType = seriesId.slice(0, 3);
  const purchaseDay = match[2] ? Number(match[2]) : undefined;
  return Number.isNaN(purchaseDay) ? { seriesId, bondType } : { seriesId, bondType, purchaseDay };
};

const getWorkbook = async () => {
  if (workbookPromise) {
    return workbookPromise;
  }
  workbookPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(BONDS_URL, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }
      const fileData = await response.arrayBuffer();
      return XLSX.read(fileData, { cellDates: true });
    } finally {
      clearTimeout(timeout);
    }
  })();

  try {
    return await workbookPromise;
  } catch (error) {
    workbookPromise = null;
    throw error;
  }
};

const getSheetMeta = (sheetName: string, rows: unknown[][]): SheetMeta | null => {
  const cached = sheetMetaCache.get(sheetName);
  if (cached) {
    return cached;
  }
  const headerRow = rows[0] ?? [];
  const subHeaderRow = rows[1] ?? [];
  const rateIdx = headerRow.findIndex(
    (value) => typeof value === 'string' && value.includes('Oprocentowanie'),
  );
  if (rateIdx < 0) {
    return null;
  }
  const interestIdx = headerRow.findIndex(
    (value) => typeof value === 'string' && value.includes('Odsetki'),
  );
  const hasSubHeader =
    (subHeaderRow[0] === null ||
      subHeaderRow[0] === undefined ||
      subHeaderRow[0] === '') &&
    subHeaderRow.some(
      (value) => typeof value === 'string' && value.trim().length > 0,
    );

  const dataStartRow = hasSubHeader ? 2 : 1;
  let rateCount = 1;
  if (hasSubHeader) {
    rateCount = countNonEmptyFrom(subHeaderRow, rateIdx);
  } else if (interestIdx > rateIdx) {
    rateCount = Math.max(1, interestIdx - rateIdx);
  }
  if (rateCount <= 0) {
    rateCount = 1;
  }

  let interestCount = 0;
  if (interestIdx >= 0) {
    interestCount = hasSubHeader
      ? countNonEmptyFrom(subHeaderRow, interestIdx)
      : 1;
    if (interestCount <= 0) {
      interestCount = 1;
    }
  }

  const meta = {
    dataStartRow,
    rateIdx,
    interestIdx,
    rateCount,
    interestCount,
    hasSubHeader,
  };
  sheetMetaCache.set(sheetName, meta);
  return meta;
};

const parseSeriesRow = (
  row: unknown[],
  meta: SheetMeta,
  bondType: string,
): BondSeries | null => {
  const seriesId = String(row[0] ?? '').trim().toUpperCase();
  if (!seriesId || !BOND_SYMBOL_PATTERN.test(seriesId)) {
    return null;
  }
  const saleStart = toDate(row[3]);
  const saleEnd = toDate(row[4]);
  const emissionPrice = toNumber(row[5]);
  if (!saleStart || !saleEnd || emissionPrice === null) {
    return null;
  }
  const rateValues =
    meta.rateIdx >= 0 ? extractNumberRange(row, meta.rateIdx, meta.rateCount) : [];
  const interestValues =
    meta.interestIdx >= 0
      ? extractNumberRange(row, meta.interestIdx, meta.interestCount)
      : [];

  return {
    seriesId,
    bondType,
    saleStart,
    saleEnd,
    emissionPrice,
    maturity: row[2],
    rateValues,
    interestValues,
  };
};

const loadBondSeries = async (bondType: string) => {
  const cached = sheetSeriesCache.get(bondType);
  if (cached) {
    return cached;
  }
  const workbook = await getWorkbook();
  const worksheet = workbook.Sheets[bondType];
  if (!worksheet) {
    return null;
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  const meta = getSheetMeta(bondType, rows);
  if (!meta) {
    return null;
  }
  const map = new Map<string, BondSeries>();
  for (let rowIndex = meta.dataStartRow; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.length === 0) {
      continue;
    }
    const series = parseSeriesRow(row, meta, bondType);
    if (series) {
      map.set(series.seriesId, series);
    }
  }
  sheetSeriesCache.set(bondType, map);
  return map;
};

const getBondSeries = async (seriesId: string, bondType: string) => {
  const seriesMap = await loadBondSeries(bondType);
  if (!seriesMap) {
    return null;
  }
  return seriesMap.get(seriesId) ?? null;
};

let opisMapPromise: Promise<Map<string, string>> | null = null;

const loadOpisMap = async () => {
  if (opisMapPromise) {
    return opisMapPromise;
  }
  opisMapPromise = (async () => {
    const workbook = await getWorkbook();
    const worksheet = workbook.Sheets.Opis;
    if (!worksheet) {
      return new Map<string, string>();
    }
    const rows: unknown[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    const map = new Map<string, string>();
    rows.forEach((row) => {
      const code = String(row?.[1] ?? '').trim().toUpperCase();
      const description = String(row?.[2] ?? '').trim();
      if (code && description) {
        map.set(code, description);
      }
    });
    return map;
  })();

  return opisMapPromise;
};

const formatBondName = (seriesId: string, description?: string) => {
  if (!description) {
    return seriesId;
  }
  const lines = description
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const label = lines.length > 1 ? lines[lines.length - 1] : lines[0];
  return `${seriesId} ${label}`.trim();
};

const buildQuote = (symbol: string, quoteDate: Date, price: number): Quote => {
  const dateISO = formatDateISO(quoteDate);
  const timestamp = `${dateISO}T00:00:00.000Z`;
  const datePart = dateISO.replace(/-/g, '');
  const normalizedSymbol = normalizeSymbol(symbol);
  return {
    id: `${datePart}_${normalizedSymbol}`,
    createdAt: timestamp,
    dataSource: 'MANUAL',
    timestamp,
    symbol: normalizedSymbol,
    open: price,
    high: price,
    low: price,
    close: price,
    adjclose: price,
    volume: 0,
    currency: 'PLN',
  };
};

const buildQuotePayload = (
  symbol: string,
  quoteDate: Date,
  price: number,
  existing?: Quote,
): Quote => {
  const base = buildQuote(symbol, quoteDate, price);
  if (!existing) {
    return base;
  }
  return {
    ...base,
    id: existing.id ?? base.id,
    createdAt: existing.createdAt ?? base.createdAt,
    dataSource: existing.dataSource ?? base.dataSource,
  };
};

const priceChanged = (existing: Quote, nextPrice: number) => {
  const existingPrice =
    typeof existing.adjclose === 'number'
      ? existing.adjclose
      : typeof existing.close === 'number'
        ? existing.close
        : existing.open;
  return Math.abs(existingPrice - nextPrice) > 0.004;
};

const extractQuoteDateKey = (quote: Quote) => {
  if (quote.timestamp) {
    const parsed = new Date(quote.timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDateISO(parsed);
    }
  }
  const id = quote.id ?? '';
  const isoMatch = id.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  const compactMatch = id.match(/(\d{8})/);
  if (compactMatch) {
    const compact = compactMatch[1];
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }
  return null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

const getBuyoutDate = (series: BondSeries, purchaseDate: Date) => {
  const maturityDate = toDate(series.maturity);
  if (maturityDate) {
    return maturityDate;
  }
  const termMonths = parseMaturityMonths(series.maturity);
  if (termMonths === null) {
    return null;
  }
  return addMonths(purchaseDate, termMonths);
};

const buildPeriods = (
  start: Date,
  end: Date,
  periodCount: number,
  periodMonths: number | null,
) => {
  const periods: Array<{ start: Date; end: Date }> = [];
  if (periodCount <= 0) {
    return periods;
  }
  if (periodMonths) {
    let cursor = start;
    for (let i = 0; i < periodCount; i += 1) {
      const next = i === periodCount - 1 ? end : addMonths(cursor, periodMonths);
      periods.push({ start: cursor, end: next });
      cursor = next;
    }
    return periods;
  }
  const totalDays = daysBetween(start, end);
  const baseDays = Math.floor(totalDays / periodCount);
  const remainder = totalDays % periodCount;
  let cursor = start;
  for (let i = 0; i < periodCount; i += 1) {
    const span = baseDays + (i < remainder ? 1 : 0);
    const next = i === periodCount - 1 ? end : addDays(cursor, span);
    periods.push({ start: cursor, end: next });
    cursor = next;
  }
  return periods;
};

type DailyValue = { date: Date; price: number };

const buildScheduledValues = (series: BondSeries, purchaseDay?: number) => {
  const purchaseDate = resolvePurchaseDate(
    series.saleStart,
    series.saleEnd,
    purchaseDay,
  );
  const buyoutDate = getBuyoutDate(series, purchaseDate);
  if (!buyoutDate) {
    return null;
  }

  if (series.bondType === 'OTS') {
    const rate = series.rateValues[0];
    const interest = series.interestValues[0];
    let interestAmount: number | null = null;
    if (purchaseDay !== undefined && typeof rate === 'number') {
      const days = daysBetween(purchaseDate, buyoutDate);
      interestAmount = series.emissionPrice * rate * (days / 365);
    } else if (typeof interest === 'number') {
      interestAmount = interest;
    } else if (typeof rate === 'number') {
      const days = daysBetween(purchaseDate, buyoutDate);
      interestAmount = series.emissionPrice * rate * (days / 365);
    }
    if (interestAmount === null) {
      return null;
    }
    return [
      {
        date: purchaseDate,
        price: round2(series.emissionPrice),
      },
      {
        date: buyoutDate,
        price: round2(series.emissionPrice + interestAmount),
      },
    ];
  }

  const periodCount = Math.max(
    series.rateValues.length,
    series.interestValues.length,
  );
  if (periodCount <= 0) {
    return null;
  }

  const termMonths =
    parseMaturityMonths(series.maturity) ?? monthsBetween(purchaseDate, buyoutDate);
  const periodMonths = resolvePeriodMonths(termMonths, periodCount);
  const periods = buildPeriods(purchaseDate, buyoutDate, periodCount, periodMonths);
  if (periods.length === 0) {
    return null;
  }

  const values: DailyValue[] = [
    { date: purchaseDate, price: round2(series.emissionPrice) },
  ];
  let currentValue = series.emissionPrice;
  for (let i = 0; i < periods.length; i += 1) {
    const rate = series.rateValues[i];
    const interest = series.interestValues[i];
    if (typeof rate !== 'number' && typeof interest !== 'number') {
      continue;
    }
    const periodDays = daysBetween(periods[i].start, periods[i].end);
    let interestAmount: number | null = null;
    if (typeof interest === 'number') {
      interestAmount = interest;
    } else if (typeof rate === 'number') {
      interestAmount = currentValue * rate * (periodDays / 365);
    }
    if (interestAmount === null) {
      continue;
    }
    const nextValue = round2(currentValue + interestAmount);
    values.push({ date: periods[i].end, price: nextValue });
    currentValue = nextValue;
  }

  return values;
};

const fetchHoldingSymbols = async (ctx: AddonContext) => {
  const accounts = await ctx.api.accounts.getAll();
  const holdingsByAccount = await Promise.all(
    accounts.map(async (account) => {
      try {
        return await ctx.api.portfolio.getHoldings(account.id);
      } catch {
        return [];
      }
    }),
  );

  const symbols = new Set<string>();
  holdingsByAccount.flat().forEach((holding) => {
    const symbol = normalizeSymbol(holding.instrument?.symbol ?? '');
    if (symbol) {
      symbols.add(symbol);
    }
  });

  return Array.from(symbols);
};

const updateQuotesInBatches = async (
  ctx: AddonContext,
  quotes: Quote[],
  batchSize = 50,
) => {
  for (let i = 0; i < quotes.length; i += batchSize) {
    const batch = quotes.slice(i, i + batchSize);
    await Promise.all(
      batch.map((quote) => ctx.api.quotes.update(quote.symbol, quote)),
    );
  }
};

const ensureBondMetadata = async (
  ctx: AddonContext,
  symbol: string,
  bondType: string,
  seriesId: string,
) => {
  let profile: { name?: string | null; assetClass?: string | null; assetSubClass?: string | null; countries?: string | null; sectors?: string | null; notes?: string | null } | null = null;
  try {
    profile = await ctx.api.assets.getProfile(symbol);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.api.logger.warn(`Polish bonds: failed to load profile for ${symbol} (${message}).`);
    return;
  }
  if (!profile) {
    return;
  }

  const opisMap = await loadOpisMap();
  const description = opisMap.get(bondType);
  const name = !profile.name || !profile.name.trim()
    ? formatBondName(seriesId, description)
    : undefined;

  const assetClass = profile.assetClass?.trim() || 'Bonds';
  const assetSubClass = profile.assetSubClass?.trim() || 'Government';
  const countries =
    profile.countries && profile.countries.trim().length > 0
      ? profile.countries
      : JSON.stringify([{ name: 'Poland', weight: 100 }]);
  const sectors = profile.sectors ?? '';
  const notes = profile.notes ?? '';

  const needsUpdate =
    !profile.assetClass ||
    !profile.assetSubClass ||
    !profile.countries ||
    !profile.countries.trim() ||
    !!name;

  if (!needsUpdate) {
    return;
  }

  await ctx.api.assets.updateProfile({
    symbol,
    name,
    sectors,
    countries,
    notes,
    assetClass,
    assetSubClass,
  });
};

export const startPolishBondTracking = (ctx: AddonContext) => {
  const processedSymbols = new Set<string>();
  const skippedSymbols = new Set<string>();
  const metadataUpdatedSymbols = new Set<string>();
  const inFlightSymbols = new Set<string>();
  let suppressPortfolioRefresh = false;
  let suppressTimeout: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<void> | null = null;
  let unlisten: (() => void) | null = null;
  let disabled = false;

  const suspendPortfolioRefresh = (durationMs = 1500) => {
    suppressPortfolioRefresh = true;
    if (suppressTimeout) {
      clearTimeout(suppressTimeout);
    }
    suppressTimeout = setTimeout(() => {
      suppressPortfolioRefresh = false;
      suppressTimeout = null;
    }, durationMs);
  };

  const refreshHoldings = async () => {
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = (async () => {
      let symbols: string[];
      try {
        symbols = await fetchHoldingSymbols(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.api.logger.warn(`Polish bonds: failed to load holdings (${message}).`);
        return;
      }

      for (const symbol of symbols) {
        if (processedSymbols.has(symbol)) {
          continue;
        }
        if (skippedSymbols.has(symbol)) {
          continue;
        }
        if (inFlightSymbols.has(symbol)) {
          continue;
        }
        const match = parseBondSymbol(symbol);
        if (!match) {
          continue;
        }

        inFlightSymbols.add(symbol);
        try {
          const series = await getBondSeries(match.seriesId, match.bondType);
          if (!series) {
            if (!skippedSymbols.has(symbol)) {
              ctx.api.logger.warn(
                `Polish bonds: no bond series data for ${symbol}.`,
              );
              skippedSymbols.add(symbol);
            }
            continue;
          }

          const scheduledValues = buildScheduledValues(
            series,
            match.purchaseDay,
          );
          if (!scheduledValues || scheduledValues.length === 0) {
            if (!skippedSymbols.has(symbol)) {
              ctx.api.logger.warn(
                `Polish bonds: no price schedule for ${symbol}.`,
              );
              skippedSymbols.add(symbol);
            }
            continue;
          }

          if (!metadataUpdatedSymbols.has(symbol)) {
            try {
              await ensureBondMetadata(ctx, symbol, match.bondType, match.seriesId);
              metadataUpdatedSymbols.add(symbol);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ctx.api.logger.warn(
                `Polish bonds: failed to update metadata for ${symbol} (${message}).`,
              );
            }
          }

          let existingDates = new Set<string>();
          const existingByDate = new Map<string, Quote>();
          try {
            const history = await ctx.api.quotes.getHistory(symbol);
            existingDates = new Set(
              history
                .map((quote) => extractQuoteDateKey(quote))
                .filter((key): key is string => Boolean(key)),
            );
            history.forEach((quote) => {
              const key = extractQuoteDateKey(quote);
              if (key && !existingByDate.has(key)) {
                existingByDate.set(key, quote);
              }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.api.logger.warn(
              `Polish bonds: failed to load quote history for ${symbol} (${message}).`,
            );
          }

          const quotesToAdd: Quote[] = [];
          scheduledValues.forEach((value) => {
            const dateKey = formatDateISO(value.date);
            const existing = existingByDate.get(dateKey);
            if (existing) {
              if (priceChanged(existing, value.price)) {
                quotesToAdd.push(
                  buildQuotePayload(symbol, value.date, value.price, existing),
                );
              }
              return;
            }
            if (!existingDates.has(dateKey)) {
              quotesToAdd.push(buildQuotePayload(symbol, value.date, value.price));
            }
          });

          if (quotesToAdd.length > 0) {
            suspendPortfolioRefresh();
            await updateQuotesInBatches(ctx, quotesToAdd);
          }

          const lastPrice = scheduledValues[scheduledValues.length - 1]?.price;
          ctx.api.logger.info(
            `Polish bonds: added ${quotesToAdd.length} quotes for ${symbol}${typeof lastPrice === 'number' ? ` (buyback ${lastPrice})` : ''}.`,
          );
          processedSymbols.add(symbol);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.api.logger.warn(`Polish bonds: failed to update ${symbol} (${message}).`);
        } finally {
          inFlightSymbols.delete(symbol);
        }
      }
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  };

  const setup = async () => {
    try {
      unlisten = await ctx.api.events.portfolio.onUpdateComplete(() => {
        if (suppressPortfolioRefresh) {
          return;
        }
        void refreshHoldings();
      });
      if (disabled && unlisten) {
        unlisten();
        return;
      }
      await refreshHoldings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.api.logger.warn(`Polish bonds: failed to start tracking (${message}).`);
    }
  };

  void setup();

  return () => {
    disabled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (suppressTimeout) {
      clearTimeout(suppressTimeout);
      suppressTimeout = null;
    }
  };
};
