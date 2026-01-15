export const SYMBOL_MAPPING_STORAGE_KEY = 'wealthfolio-importer:symbol-mappings';

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

export const loadSymbolMappings = () => {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(SYMBOL_MAPPING_STORAGE_KEY);
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

export const saveSymbolMappings = (mappings: Record<string, string>) => {
  if (typeof window === 'undefined') {
    return;
  }
  const normalized = normalizeSymbolMappings(mappings);
  window.localStorage.setItem(
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
