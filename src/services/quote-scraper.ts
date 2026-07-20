import type { AddonContext, Asset, Quote } from '@wealthfolio/addon-sdk';

const STORAGE_KEY = 'wealthfolio-importer.quote-scraper';
const DEFAULT_CODE = 'text';

type StoredConfig = {
  url: string;
  code: string;
  enabled?: boolean;
  lastLog?: string;
  lastResultJson?: string;
  lastNormalizedJson?: string;
  lastRunAt?: string;
};

export type QuoteScraperState = {
  selectedAssetId?: string;
  configs: Record<string, StoredConfig>;
};

export type QuoteScraperPipelineResult = {
  log: string;
  rawResult: unknown;
  normalized: Array<{ price: number; date: Date }>;
};

const safeJsonStringify = (value: unknown) => {
  try {
    return JSON.stringify(
      value,
      (_key, item) => {
        if (item instanceof Date) {
          return item.toISOString();
        }
        if (typeof item === 'bigint') {
          return item.toString();
        }
        if (typeof item === 'number' && !Number.isFinite(item)) {
          return null;
        }
        return item;
      },
      2,
    );
  } catch {
    try {
      return JSON.stringify(String(value), null, 2);
    } catch {
      return 'null';
    }
  }
};

const clampLog = (value: string, max = 50_000) => {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n… (truncated)`;
};

const formatDateISO = (date: Date) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toLocalDate = (value: Date) =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate());

const parseDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toLocalDate(value);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return toLocalDate(parsed);
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return toLocalDate(parsed);
    }
  }
  return null;
};

const parsePrice = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(',', '.');
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
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

const priceChanged = (existing: Quote, nextPrice: number) => {
  const existingPrice =
    typeof existing.adjclose === 'number'
      ? existing.adjclose
      : typeof existing.close === 'number'
        ? existing.close
        : existing.open;
  return Math.abs(existingPrice - nextPrice) > 0.004;
};

const buildQuote = (
  assetId: string,
  quoteDate: Date,
  price: number,
  currency: string,
  existing?: Quote,
): Quote => {
  const dateISO = formatDateISO(quoteDate);
  const timestamp = `${dateISO}T00:00:00.000Z`;
  return {
    id: existing?.id ?? crypto.randomUUID(),
    createdAt: existing?.createdAt ?? timestamp,
    dataSource: existing?.dataSource ?? 'MANUAL',
    timestamp,
    assetId,
    open: price,
    high: price,
    low: price,
    close: price,
    adjclose: price,
    volume: 0,
    currency: existing?.currency ?? currency,
    notes: existing?.notes ?? null,
  };
};

export const loadQuoteScraperState = async (ctx: AddonContext): Promise<QuoteScraperState> => {
  try {
    const raw = await ctx.api.secrets.get(STORAGE_KEY);
    if (!raw) {
      return { configs: {} };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { configs: {} };
    }
    const state = parsed as Partial<QuoteScraperState>;
    const configs = state.configs && typeof state.configs === 'object' ? state.configs : {};
    return {
      selectedAssetId: typeof state.selectedAssetId === 'string' ? state.selectedAssetId : undefined,
      configs: configs as Record<string, StoredConfig>,
    };
  } catch {
    return { configs: {} };
  }
};

export const saveQuoteScraperState = async (ctx: AddonContext, state: QuoteScraperState) => {
  await ctx.api.secrets.set(STORAGE_KEY, JSON.stringify(state));
};

export const upsertQuoteScraperConfig = async (
  ctx: AddonContext,
  assetId: string,
  update: Partial<StoredConfig>,
) => {
  const state = await loadQuoteScraperState(ctx);
  const prev = state.configs[assetId] ?? {
    url: '',
    code: DEFAULT_CODE,
    enabled: true,
  };
  state.configs[assetId] = {
    ...prev,
    ...update,
    url: typeof update.url === 'string' ? update.url : prev.url,
    code: typeof update.code === 'string' ? update.code : prev.code,
  };
  await saveQuoteScraperState(ctx, state);
  return state.configs[assetId];
};

const normalizeScriptResult = (result: unknown) => {
  if (typeof result === 'number' && Number.isFinite(result)) {
    return [{ price: result, date: toLocalDate(new Date()) }];
  }
  if (Array.isArray(result)) {
    const normalized: Array<{ price: number; date: Date }> = [];
    for (const item of result) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      const price = parsePrice(record.price);
      const date = parseDate(record.date);
      if (price === null || !date) {
        continue;
      }
      normalized.push({ price, date });
    }
    return normalized;
  }
  return [] as Array<{ price: number; date: Date }>;
};

export const runQuoteScraperPipeline = async (
  ctx: AddonContext,
  url: string,
  code: string,
): Promise<QuoteScraperPipelineResult> => {
  const logLines: string[] = [];
  const addLog = (line: string) => {
    logLines.push(line);
  };

  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return {
      log: 'Missing URL.',
      rawResult: null,
      normalized: [],
    };
  }

  addLog(`Fetch: ${trimmedUrl}`);

  const response = await ctx.api.network.request({
    url: trimmedUrl,
    method: 'GET',
  });

  addLog(`HTTP: ${response.status}`);

  const getHeader = (headers: Record<string, string>, name: string): string => {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers || {})) {
      if (key.toLowerCase() === target) {
        return headers[key];
      }
    }
    return '';
  };

  const contentType = getHeader(response.headers, 'content-type');
  const text = response.body;
  addLog(`Content-Type: ${contentType || '(unknown)'}`);
  addLog(`Body: ${text.length} chars`);

  let json: unknown = null;
  if (contentType.toLowerCase().includes('json')) {
    try {
      json = JSON.parse(text);
      addLog('JSON: parsed (content-type indicates JSON)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog(`JSON: parse failed (${message})`);
    }
  } else {
    try {
      json = JSON.parse(text);
      addLog('JSON: parsed (best-effort)');
    } catch {
      json = null;
    }
  }

  const headers: Record<string, string> = { ...response.headers };

  const script = (code || DEFAULT_CODE).trim() || DEFAULT_CODE;
  addLog('JS: executing');

  let rawResult: unknown;
  try {
    const fn = new Function(
      'context',
      '"use strict"; const { text, json, url, response, status, headers } = context; return (' +
        script +
        ');',
    ) as (context: {
      text: string;
      json: unknown;
      url: string;
      response: any;
      status: number;
      headers: Record<string, string>;
    }) => unknown;

    rawResult = fn({
      text,
      json,
      url: trimmedUrl,
      response: response as any,
      status: response.status,
      headers,
    });

    if (rawResult && typeof (rawResult as Promise<unknown>).then === 'function') {
      rawResult = await (rawResult as Promise<unknown>);
    }

    addLog(`JS: ok (type=${Array.isArray(rawResult) ? 'array' : typeof rawResult})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog(`JS: error (${message})`);
    rawResult = null;
  }

  const normalized = normalizeScriptResult(rawResult);
  addLog(`Normalize: ${normalized.length} quote${normalized.length === 1 ? '' : 's'}`);

  return {
    log: clampLog(logLines.join('\n')),
    rawResult,
    normalized,
  };
};

const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        results[idx] = await mapper(items[idx]);
      }
    });

  await Promise.all(workers);
  return results;
};

export const updateQuotesFromScraper = async (
  ctx: AddonContext,
  assetId: string,
  url: string,
  code: string,
) => {
  const profile: Asset | null = await ctx.api.assets
    .getProfile(assetId)
    .catch(() => null);

  const quoteMode = profile?.quoteMode;
  if (quoteMode && quoteMode !== 'MANUAL') {
    await ctx.api.assets.updateQuoteMode(assetId, 'MANUAL');
  }

  const currency = profile?.quoteCcy ?? 'USD';

  const pipeline = await runQuoteScraperPipeline(ctx, url, code);
  const normalized = pipeline.normalized;

  if (normalized.length === 0) {
    return {
      ...pipeline,
      updated: 0,
    };
  }

  let history: Quote[] = [];
  try {
    history = await ctx.api.quotes.getHistory(assetId);
  } catch {
    history = [];
  }

  const byDate = new Map<string, Quote>();
  for (const quote of history) {
    const key = extractQuoteDateKey(quote);
    if (key && !byDate.has(key)) {
      byDate.set(key, quote);
    }
  }

  const toUpdate: Quote[] = [];
  for (const item of normalized) {
    const key = formatDateISO(item.date);
    const existing = byDate.get(key);
    if (existing && !priceChanged(existing, item.price)) {
      continue;
    }
    toUpdate.push(buildQuote(assetId, item.date, item.price, currency, existing));
  }

  await Promise.all(toUpdate.map((quote) => ctx.api.quotes.update(assetId, quote)));

  return {
    ...pipeline,
    updated: toUpdate.length,
  };
};

export const startQuoteScraperTracking = (ctx: AddonContext) => {
  let stopped = false;
  let interval: number | null = null;

  const runOnce = async () => {
    if (stopped) {
      return;
    }
    const state = await loadQuoteScraperState(ctx);
    const entries = Object.entries(state.configs ?? {}).filter(
      ([, cfg]) => (cfg.enabled ?? true) && !!cfg.url?.trim(),
    );

    if (entries.length === 0) {
      return;
    }

    await mapLimit(entries, 2, async ([assetId, cfg]) => {
      if (stopped) {
        return null;
      }
      try {
        const result = await updateQuotesFromScraper(
          ctx,
          assetId,
          cfg.url,
          cfg.code,
        );

        await upsertQuoteScraperConfig(ctx, assetId, {
          lastLog: result.log,
          lastResultJson: safeJsonStringify(result.rawResult),
          lastNormalizedJson: safeJsonStringify(
            result.normalized.map((row) => ({
              price: row.price,
              date: formatDateISO(row.date),
            })),
          ),
          lastRunAt: new Date().toISOString(),
        });

        ctx.api.logger.info(
          `Quote scraper: updated ${result.updated} quote(s) for ${assetId}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.api.logger.warn(
          `Quote scraper: failed for ${assetId} (${message}).`,
        );
      }
      return null;
    });
  };

  const start = () => {
    // Run once shortly after enable to avoid blocking startup.
    setTimeout(() => {
      runOnce().catch(() => undefined);
    }, 1500);

    // Conservative interval (6h) to avoid hammering external endpoints.
    interval = window.setInterval(() => {
      runOnce().catch(() => undefined);
    }, 6 * 60 * 60 * 1000);
  };

  if (typeof window !== 'undefined') {
    start();
  }

  return () => {
    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };
};
