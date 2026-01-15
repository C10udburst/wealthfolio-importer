import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActivityDetails,
  AddonContext,
  Holding,
  QuoteSummary,
} from '@wealthfolio/addon-sdk';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  Icons,
  Input,
  Page,
  PageContent,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@wealthfolio/ui';
import {
  loadSymbolMappings,
  normalizeSymbol,
  normalizeSymbolMappings,
  saveSymbolMappings,
} from '../utils/symbol-mappings';

interface MappingRow {
  id: string;
  from: string;
  to: string;
  isExisting: boolean;
}

const getActivitySymbol = (activity: ActivityDetails) =>
  activity.assetSymbol ?? (activity as ActivityDetails & { symbol?: string }).symbol ?? '';

interface SymbolSuggestionInputProps {
  ctx: AddonContext;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

const SymbolSuggestionInput = ({
  ctx,
  value,
  onChange,
  placeholder,
  disabled = false,
}: SymbolSuggestionInputProps) => {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<QuoteSummary[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    const query = value.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    const handle = setTimeout(() => {
      const marketApi =
        (ctx.api as typeof ctx.api & { marketData?: typeof ctx.api.market }).market ??
        (ctx.api as { marketData?: typeof ctx.api.market }).marketData;
      if (!marketApi) {
        setSearchError('Market search unavailable.');
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      setSearchError(null);
      marketApi
        .searchTicker(query)
        .then((results) => {
          setSuggestions(results ?? []);
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Failed to search symbols.';
          setSearchError(message);
          setSuggestions([]);
        })
        .finally(() => {
          setIsSearching(false);
        });
    }, 300);

    return () => clearTimeout(handle);
  }, [ctx, value]);

  const handleSelect = (symbol: string) => {
    onChange(symbol);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div>
          <Input
            value={value}
            placeholder={placeholder}
            className="h-8 text-xs"
            disabled={disabled}
            onFocus={() => {
              if (!disabled) {
                setOpen(true);
              }
            }}
            onChange={(event) => {
              onChange(event.target.value);
              if (!disabled) {
                setOpen(true);
              }
            }}
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="w-[320px] p-0 text-xs"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command>
          <CommandList>
            {isSearching && (
              <CommandItem value="searching" disabled>
                <Icons.Spinner className="mr-2 h-3.5 w-3.5 animate-spin" />
                Searching...
              </CommandItem>
            )}
            {searchError && (
              <CommandItem value="error" disabled>
                <Icons.AlertCircle className="mr-2 h-3.5 w-3.5" />
                {searchError}
              </CommandItem>
            )}
            {!isSearching && !searchError && suggestions.length === 0 && (
              <CommandEmpty>No suggestions yet.</CommandEmpty>
            )}
            {suggestions.length > 0 && (
              <CommandGroup heading="Yahoo suggestions">
                {suggestions.map((suggestion) => (
                  <CommandItem
                    key={`${suggestion.symbol}-${suggestion.exchange}`}
                    value={`${suggestion.symbol} ${suggestion.shortName ?? ''}`}
                    onSelect={() => handleSelect(suggestion.symbol)}
                  >
                    <Icons.Search className="mr-2 h-3.5 w-3.5" />
                    <div className="flex flex-col">
                      <span className="font-medium">{suggestion.symbol}</span>
                      <span className="text-muted-foreground">
                        {suggestion.shortName || suggestion.longName || suggestion.exchange}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

interface MappingsPageProps {
  ctx: AddonContext;
}

export default function MappingsPage({ ctx }: MappingsPageProps) {
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [isLoadingSymbols, setIsLoadingSymbols] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const loadSymbols = useCallback(async () => {
    setIsLoadingSymbols(true);
    setLoadError(null);
    setApplyStatus(null);
    try {
      const activities = await ctx.api.activities.getAll();
      const uniqueSymbols = new Set<string>();
      activities.forEach((activity: ActivityDetails) => {
        const rawSymbol = getActivitySymbol(activity);
        const normalized = normalizeSymbol(rawSymbol);
        if (!normalized || normalized.startsWith('$CASH-')) {
          return;
        }
        uniqueSymbols.add(normalized);
      });

      const sorted = Array.from(uniqueSymbols).sort((a, b) =>
        a.localeCompare(b),
      );
      const storedMappings = loadSymbolMappings();
      const existingRows: MappingRow[] = sorted.map((symbol) => ({
        id: `existing-${normalizeSymbol(symbol)}`,
        from: symbol,
        to: storedMappings[normalizeSymbol(symbol)] ?? '',
        isExisting: true,
      }));
      const mappedOnlyRows = Object.entries(storedMappings)
        .filter(([from]) => !uniqueSymbols.has(from))
        .map(([from, to]) => ({
          id: `custom-${from}`,
          from,
          to,
          isExisting: false,
        }));

      setRows([...existingRows, ...mappedOnlyRows]);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to load symbols.';
      setLoadError(message);
    } finally {
      setIsLoadingSymbols(false);
    }
  }, [ctx]);

  useEffect(() => {
    void loadSymbols();
  }, [loadSymbols]);

  const filteredRows = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) {
      return rows;
    }
    return rows.filter(
      (row) =>
        row.from.toLowerCase().includes(query) ||
        row.to.toLowerCase().includes(query),
    );
  }, [rows, searchText]);

  const updateRow = (rowId: string, updates: Partial<MappingRow>) => {
    setRows((prev) =>
      prev.map((row) => (row.id === rowId ? { ...row, ...updates } : row)),
    );
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { id: `custom-${Date.now()}`, from: '', to: '', isExisting: false },
    ]);
  };

  const removeRow = (rowId: string) => {
    setRows((prev) => prev.filter((row) => row.id !== rowId));
  };

  const buildMappings = () => {
    const mapping: Record<string, string> = {};
    rows.forEach((row) => {
      if (!row.from || !row.to) {
        return;
      }
      mapping[row.from] = row.to;
    });
    return normalizeSymbolMappings(mapping);
  };

  const handleSave = () => {
    const mapping = buildMappings();
    saveSymbolMappings(mapping);
    setSaveStatus(
      Object.keys(mapping).length
        ? `Saved ${Object.keys(mapping).length} mapping(s).`
        : 'Saved empty mapping.',
    );
  };

  const handleApplyExisting = async () => {
    const mapping = buildMappings();
    if (Object.keys(mapping).length === 0) {
      setApplyStatus('No mappings to apply.');
      return;
    }

    setIsApplying(true);
    setApplyStatus(null);
    try {
      const activities = await ctx.api.activities.getAll();
      const symbolToAssetId = new Map<string, string>();
      activities.forEach((activity) => {
        const symbol = normalizeSymbol(getActivitySymbol(activity));
        if (!symbol) {
          return;
        }
        symbolToAssetId.set(symbol, activity.assetId);
      });
      const accounts = await ctx.api.accounts.getAll();
      const holdingsByAccount = await Promise.all(
        accounts.map(async (account) => {
          try {
            return await ctx.api.portfolio.getHoldings(account.id);
          } catch {
            return [] as Holding[];
          }
        }),
      );
      holdingsByAccount.flat().forEach((holding) => {
        const symbol = normalizeSymbol(holding.instrument?.symbol ?? '');
        const assetId = holding.instrument?.id;
        if (!symbol || !assetId) {
          return;
        }
        if (!symbolToAssetId.has(symbol)) {
          symbolToAssetId.set(symbol, assetId);
        }
      });

      const missingTargets = new Set<string>();
      const missingMappingCounts = new Map<string, number>();
      const updates = activities.flatMap((activity) => {
        const symbol = normalizeSymbol(getActivitySymbol(activity));
        const targetSymbol = mapping[symbol];
        if (!symbol || !targetSymbol) {
          return [];
        }
        if (targetSymbol === symbol) {
          return [];
        }
        const targetAssetId = symbolToAssetId.get(targetSymbol);
        if (!targetAssetId) {
          missingTargets.add(targetSymbol);
          const key = `${symbol} -> ${targetSymbol}`;
          missingMappingCounts.set(key, (missingMappingCounts.get(key) ?? 0) + 1);
          return [];
        }
        if (activity.assetId === targetAssetId) {
          return [];
        }
        return [
          {
            id: activity.id,
            accountId: activity.accountId,
            activityType: activity.activityType,
            activityDate: activity.date,
            assetId: targetAssetId,
            quantity: activity.quantity,
            unitPrice: activity.unitPrice,
            amount: activity.amount,
            currency: activity.currency,
            fee: activity.fee,
            isDraft: activity.isDraft,
            comment: activity.comment ?? null,
          },
        ];
      });

      if (updates.length === 0) {
        const missing =
          missingTargets.size > 0
            ? ` Missing targets (target symbol not found in holdings/activities): ${Array.from(
                missingMappingCounts.entries(),
              )
                .slice(0, 6)
                .map(([pair, count]) => `${pair} (x${count})`)
                .join(', ')}${missingMappingCounts.size > 6 ? '…' : ''}.`
            : '';
        setApplyStatus(`No activities updated.${missing}`);
        return;
      }

      const chunkSize = 200;
      let updatedCount = 0;
      for (let i = 0; i < updates.length; i += chunkSize) {
        const chunk = updates.slice(i, i + chunkSize);
        await ctx.api.activities.saveMany({ updates: chunk });
        updatedCount += chunk.length;
      }

      const missingMessage =
        missingTargets.size > 0
          ? ` ${missingTargets.size} target symbol${missingTargets.size === 1 ? '' : 's'} missing.`
          : '';
      setApplyStatus(`Updated ${updatedCount} activities.${missingMessage}`);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to apply mappings.';
      setApplyStatus(message);
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Page>
      <PageHeader
        heading="Symbol mappings"
        text="Map broker symbols to the tickers you want to keep in Wealthfolio. Saved mappings will apply to future imports."
        actions={
          <Button
            variant="outline"
            onClick={() => ctx.api.navigation.navigate('/addon/wealthfolio-importer')}
          >
            <Icons.ArrowLeft className="mr-2 h-4 w-4" />
            Back to importer
          </Button>
        }
      />
      <PageContent>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Existing symbols</CardTitle>
              <CardDescription>
                Review and map symbols found in your current activities.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Filter by symbol"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    className="h-8 w-[220px]"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSearchText('')}
                    disabled={!searchText}
                  >
                    Clear
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadSymbols}
                    disabled={isLoadingSymbols}
                  >
                    {isLoadingSymbols ? 'Loading...' : 'Refresh symbols'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={addRow}>
                    <Icons.Plus className="mr-2 h-3.5 w-3.5" />
                    Add mapping
                  </Button>
                </div>
              </div>

              {loadError && (
                <div className="text-destructive flex items-center gap-2 text-sm">
                  <Icons.AlertCircle className="h-4 w-4" />
                  {loadError}
                </div>
              )}

              {rows.length === 0 && !isLoadingSymbols && !loadError && (
                <div className="text-muted-foreground text-sm">
                  No symbols loaded yet.
                </div>
              )}

              {rows.length > 0 && (
                <div className="rounded-md border overflow-x-auto">
                  <Table className="min-w-[720px] text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[260px] px-2">Current symbol</TableHead>
                        <TableHead className="px-2">Mapped symbol</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="px-2 py-1">
                            {row.isExisting ? (
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">{row.from}</Badge>
                              </div>
                            ) : (
                              <Input
                                value={row.from}
                                placeholder="From symbol"
                                className="h-8 text-xs"
                                onChange={(event) =>
                                  updateRow(row.id, { from: event.target.value })
                                }
                              />
                            )}
                          </TableCell>
                          <TableCell className="px-2 py-1">
                            <div className="flex items-center gap-2">
                              <div className="flex-1">
                                <SymbolSuggestionInput
                                  ctx={ctx}
                                  value={row.to}
                                  placeholder="Map to..."
                                  onChange={(value) => updateRow(row.id, { to: value })}
                                />
                              </div>
                              {!row.isExisting && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  onClick={() => removeRow(row.id)}
                                >
                                  <Icons.Trash className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleSave}>
                  <Icons.Save className="mr-2 h-4 w-4" />
                  Save mappings
                </Button>
                <Button
                  variant="outline"
                  onClick={handleApplyExisting}
                  disabled={isApplying}
                >
                  {isApplying ? 'Applying...' : 'Apply to existing activities'}
                </Button>
                {saveStatus && (
                  <span className="text-muted-foreground text-sm">{saveStatus}</span>
                )}
                {applyStatus && (
                  <span className="text-muted-foreground text-sm">{applyStatus}</span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </PageContent>
    </Page>
  );
}
