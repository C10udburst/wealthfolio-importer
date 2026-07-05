import type { AddonContext } from '@wealthfolio/addon-sdk';

export const SYMBOL_MAPPING_STORAGE_KEY = 'wealthfolio-importer.symbol-mappings';

export const normalizeSymbol = (value: string) =>
  value.trim().toUpperCase();

export const normalizeSymbolMappings = (
  mappings: Record<string, string>,
) => {
  const normalized: Record<string, string> = {};
  Object.entries(mappings).forEach(([from, to]) => {
    const fromSymbol = normalizeSymbol(from);
    const toSymbol = normalizeSymbol(to);
    if (!fromSymbol || !toSymbol || fromSymbol === toSymbol) {
      return;
    }
    normalized[fromSymbol] = toSymbol;
  });
  return normalized;
};

export const loadSymbolMappings = async (ctx: AddonContext) => {
  try {
    const raw = await ctx.api.secrets.get(SYMBOL_MAPPING_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return normalizeSymbolMappings(parsed as Record<string, string>);
  } catch {
    return {};
  }
};

export const saveSymbolMappings = async (ctx: AddonContext, mappings: Record<string, string>) => {
  const normalized = normalizeSymbolMappings(mappings);
  await ctx.api.secrets.set(
    SYMBOL_MAPPING_STORAGE_KEY,
    JSON.stringify(normalized),
  );
};

export const applySymbolMapping = (
  symbol: string,
  mappings: Record<string, string>,
) => {
  const trimmed = symbol.trim();
  if (!trimmed || trimmed.toUpperCase().startsWith('$CASH-')) {
    return symbol;
  }
  const mapped = mappings[normalizeSymbol(trimmed)];
  return mapped ?? symbol;
};
