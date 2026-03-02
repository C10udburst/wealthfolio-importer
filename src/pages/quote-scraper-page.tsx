import React, { useEffect, useMemo, useState } from 'react';
import type { ActivityDetails, AddonContext, Asset } from '@wealthfolio/addon-sdk';
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
  CommandInput,
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
  Textarea,
} from '@wealthfolio/ui';
import {
  loadQuoteScraperState,
  runQuoteScraperPipeline,
  updateQuotesFromScraper,
  upsertQuoteScraperConfig,
  saveQuoteScraperState,
} from '../services/quote-scraper';

type ManualAssetOption = {
  assetId: string;
  symbol: string;
  name: string;
  quoteCcy: string;
};

const getActivitySymbol = (activity: ActivityDetails) =>
  activity.assetSymbol ?? (activity as ActivityDetails & { symbol?: string }).symbol ?? '';

const safeStringify = (value: unknown) => {
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

interface QuoteScraperPageProps {
  ctx: AddonContext;
}

export default function QuoteScraperPage({ ctx }: QuoteScraperPageProps) {
  const [assets, setAssets] = useState<ManualAssetOption[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);

  const [selectedAssetId, setSelectedAssetId] = useState<string>('');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('text');

  const [comboOpen, setComboOpen] = useState(false);

  const [outputText, setOutputText] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [normalizedText, setNormalizedText] = useState('');

  const [runError, setRunError] = useState<string | null>(null);
  const [runSuccess, setRunSuccess] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.assetId === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );

  useEffect(() => {
    const state = loadQuoteScraperState();
    if (state.selectedAssetId) {
      setSelectedAssetId(state.selectedAssetId);
    }
    if (state.selectedAssetId && state.configs[state.selectedAssetId]) {
      const cfg = state.configs[state.selectedAssetId];
      setUrl(cfg.url ?? '');
      setCode(cfg.code ?? 'text');
      setOutputText(cfg.lastLog ?? '');
      setPreviewText(cfg.lastResultJson ?? '');
      setNormalizedText(cfg.lastNormalizedJson ?? '');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingAssets(true);
    setAssetsError(null);

    const load = async () => {
      const activities = await ctx.api.activities.getAll();
      const byAssetId = new Map<string, string>();

      activities.forEach((activity) => {
        if (!activity.assetId) {
          return;
        }
        const symbol = getActivitySymbol(activity).trim();
        if (symbol && !byAssetId.has(activity.assetId)) {
          byAssetId.set(activity.assetId, symbol);
        }
      });

      const assetIds = Array.from(byAssetId.keys());
      const profiles = await mapLimit(assetIds, 8, async (assetId) => {
        const profile = await ctx.api.assets.getProfile(assetId).catch(() => null);
        return { assetId, profile };
      });

      const options: ManualAssetOption[] = [];
      profiles.forEach(({ assetId, profile }) => {
        if (!profile) {
          return;
        }
        const asset = profile as Asset;
        if (asset.quoteMode !== 'MANUAL') {
          return;
        }
        const symbol =
          byAssetId.get(assetId) ||
          asset.displayCode ||
          asset.instrumentSymbol ||
          assetId;
        const name = asset.name?.trim() ? asset.name : symbol;
        options.push({
          assetId,
          symbol,
          name,
          quoteCcy: asset.quoteCcy ?? 'USD',
        });
      });

      options.sort((left, right) => left.symbol.localeCompare(right.symbol));
      return options;
    };

    load()
      .then((result) => {
        if (!cancelled) {
          setAssets(result);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to load assets.';
        if (!cancelled) {
          setAssetsError(message);
          setAssets([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingAssets(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  useEffect(() => {
    if (!selectedAssetId) {
      return;
    }
    const state = loadQuoteScraperState();
    const cfg = state.configs[selectedAssetId];

    setUrl(cfg?.url ?? '');
    setCode(cfg?.code ?? 'text');
    setOutputText(cfg?.lastLog ?? '');
    setPreviewText(cfg?.lastResultJson ?? '');
    setNormalizedText(cfg?.lastNormalizedJson ?? '');

    saveQuoteScraperState({
      ...state,
      selectedAssetId,
    });
  }, [selectedAssetId]);

  useEffect(() => {
    if (!selectedAssetId) {
      return;
    }
    const handle = setTimeout(() => {
      upsertQuoteScraperConfig(selectedAssetId, {
        url,
        code,
      });
    }, 250);

    return () => clearTimeout(handle);
  }, [code, selectedAssetId, url]);

  const onRunPipeline = async (updateQuotes: boolean) => {
    setRunError(null);
    setRunSuccess(null);

    if (!selectedAssetId) {
      setRunError('Select a manual security first.');
      return;
    }

    setIsRunning(true);
    try {
      if (updateQuotes) {
        const result = await updateQuotesFromScraper(ctx, selectedAssetId, url, code);
        setOutputText(result.log);
        setPreviewText(safeStringify(result.rawResult));
        setNormalizedText(
          safeStringify(
            result.normalized.map((row) => ({
              price: row.price,
              date: row.date.toISOString().slice(0, 10),
            })),
          ),
        );
        setRunSuccess(`Updated ${result.updated} quote(s).`);

        upsertQuoteScraperConfig(selectedAssetId, {
          lastLog: result.log,
          lastResultJson: safeStringify(result.rawResult),
          lastNormalizedJson: safeStringify(
            result.normalized.map((row) => ({
              price: row.price,
              date: row.date.toISOString().slice(0, 10),
            })),
          ),
          lastRunAt: new Date().toISOString(),
        });
      } else {
        const result = await runQuoteScraperPipeline(url, code);
        setOutputText(result.log);
        setPreviewText(safeStringify(result.rawResult));
        setNormalizedText(
          safeStringify(
            result.normalized.map((row) => ({
              price: row.price,
              date: row.date.toISOString().slice(0, 10),
            })),
          ),
        );
        setRunSuccess('Pipeline executed.');

        upsertQuoteScraperConfig(selectedAssetId, {
          lastLog: result.log,
          lastResultJson: safeStringify(result.rawResult),
          lastNormalizedJson: safeStringify(
            result.normalized.map((row) => ({
              price: row.price,
              date: row.date.toISOString().slice(0, 10),
            })),
          ),
          lastRunAt: new Date().toISOString(),
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Pipeline failed.';
      setRunError(message);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Page>
      <PageHeader
        heading="Quote scraper"
        text="Fetch a URL, run JavaScript against the response, preview the result, and update manual quotes."
      />

      <PageContent>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Input</CardTitle>
              <CardDescription>
                Your script can reference: <Badge>text</Badge>{' '}
                <Badge>json</Badge>{' '}
                <Badge>status</Badge>{' '}
                <Badge>headers</Badge>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-medium">Manual security</div>
                {isLoadingAssets && (
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Icons.Spinner className="h-4 w-4 animate-spin" />
                    Loading securities...
                  </div>
                )}
                {assetsError && (
                  <div className="text-destructive flex items-center gap-2 text-sm">
                    <Icons.AlertCircle className="h-4 w-4" />
                    {assetsError}
                  </div>
                )}

                <Popover open={comboOpen} onOpenChange={setComboOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between"
                      disabled={isLoadingAssets || assets.length === 0}
                    >
                      <span className="truncate">
                        {selectedAsset
                          ? `${selectedAsset.symbol} — ${selectedAsset.name}`
                          : 'Select a manual security'}
                      </span>
                      <Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[520px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search symbol..." />
                      <CommandList>
                        <CommandEmpty>
                          {assets.length === 0
                            ? 'No manual securities found.'
                            : 'No matches.'}
                        </CommandEmpty>
                        <CommandGroup>
                          {assets.map((asset) => (
                            <CommandItem
                              key={asset.assetId}
                              value={`${asset.symbol} ${asset.name}`}
                              onSelect={() => {
                                setSelectedAssetId(asset.assetId);
                                setComboOpen(false);
                              }}
                            >
                              <div className="flex w-full items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">
                                    {asset.symbol}
                                  </div>
                                  <div className="text-muted-foreground truncate text-xs">
                                    {asset.name}
                                  </div>
                                </div>
                                <Badge>{asset.quoteCcy}</Badge>
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">URL</div>
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/quotes"
                  disabled={!selectedAssetId}
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">JavaScript (expression)</div>
                <Textarea
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  className="min-h-[280px] font-mono text-xs"
                  disabled={!selectedAssetId}
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => onRunPipeline(false)}
                  disabled={!selectedAssetId || isRunning}
                >
                  {isRunning ? (
                    <>
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      Running...
                    </>
                  ) : (
                    <>
                      {/* <Icons.PlayCircle className="mr-2 h-4 w-4" /> */}
                      Run
                    </>
                  )}
                </Button>
                <Button
                  onClick={() => onRunPipeline(true)}
                  disabled={!selectedAssetId || isRunning}
                >
                  {isRunning ? (
                    <>
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      Updating...
                    </>
                  ) : (
                    <>
                      {/* <Icons.Save className="mr-2 h-4 w-4" /> */}
                      Update quotes
                    </>
                  )}
                </Button>
              </div>

              {runError && (
                <div className="text-destructive flex items-center gap-2 text-sm">
                  <Icons.AlertCircle className="h-4 w-4" />
                  {runError}
                </div>
              )}
              {runSuccess && (
                <div className="text-sm text-green-600">{runSuccess}</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Output</CardTitle>
              <CardDescription>
                Pipeline: fetch → execute JS → normalize (number or list of {'{'}"price","date"{'}'})
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-medium">Log</div>
                <pre className="bg-muted max-h-[240px] overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                  {outputText || '—'}
                </pre>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Parsed result preview</div>
                <pre className="bg-muted max-h-[240px] overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                  {previewText || '—'}
                </pre>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Normalized quotes preview</div>
                <pre className="bg-muted max-h-[240px] overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                  {normalizedText || '—'}
                </pre>
              </div>
            </CardContent>
          </Card>
        </div>
      </PageContent>
    </Page>
  );
}
