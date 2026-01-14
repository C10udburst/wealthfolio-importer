import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, ActivityImport, AddonContext } from '@wealthfolio/addon-sdk';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Input,
  Page,
  PageContent,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@wealthfolio/ui';
import {
  detectImporter,
  getImporterById,
  type ImportDetection,
  type ImportParseResult,
  type ImportSourceId,
  type ParseOptions,
} from '../parsers';

const SUPPORTED_EXTENSIONS = ['csv', 'xlsx', 'xls', 'pdf'] as const;
const FILE_ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

const SOURCE_OPTIONS = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'ing', label: 'ING Bank' },
  { id: 'pekao', label: 'Pekao Bank' },
  { id: 'xtb', label: 'XTB Broker' },
  { id: 'paypal', label: 'PayPal' },
];

const ACTIVITY_TYPE_OPTIONS = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'DEPOSIT',
  'WITHDRAWAL',
  'ADD_HOLDING',
  'REMOVE_HOLDING',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'FEE',
  'TAX',
  'SPLIT',
] as const;
const PAGE_SIZE_OPTIONS = [10, 25, 50];
const TRADE_ACTIVITY_TYPES = new Set(['BUY', 'SELL']);
const CASH_LIKE_ACTIVITY_TYPES = new Set([
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'INTEREST',
  'DIVIDEND',
]);
const FEE_ACTIVITY_TYPES = new Set(['FEE', 'TAX']);
const TABLE_INPUT_CLASS =
  'h-8 border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-muted-foreground/30';
const TABLE_INPUT_RIGHT_CLASS = `${TABLE_INPUT_CLASS} text-right`;
const TABLE_SELECT_TRIGGER_CLASS =
  'h-8 border-0 bg-transparent px-2 text-xs shadow-none focus:ring-1 focus:ring-muted-foreground/30';

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const getFileExtension = (file: File) => {
  const parts = file.name.split('.');
  if (parts.length < 2) {
    return null;
  }
  return parts[parts.length - 1].toLowerCase();
};

const formatInputDateTime = (value: Date | string | undefined) => {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return '';
  }
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60000);
  return localDate.toISOString().slice(0, 16);
};

const parseInputDateTime = (value: string) => {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return undefined;
  }
  return parsed.toISOString();
};

const parseNumberValue = (value: string) => {
  if (value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const normalizeImportNumber = (value: number | undefined) => {
  if (value === undefined || value === null) {
    return value;
  }
  return Number.isFinite(value) ? Math.abs(value) : value;
};

const normalizeKeyDate = (value: Date | string | undefined) => {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }
  return date.toISOString();
};

const normalizeKeyAmount = (value: number | undefined) => {
  if (value === undefined || value === null) {
    return '';
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return String(value);
  }
  return amount.toFixed(6);
};

const normalizeKeyCurrency = (value: string | undefined, fallback?: string | null) => {
  const currency = value && value.trim() ? value.trim() : fallback || '';
  return currency.toUpperCase();
};

const normalizeKeyComment = (value: string | undefined) => {
  if (!value) {
    return '';
  }
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
};

const buildActivityKey = (
  date: Date | string | undefined,
  amount: number | undefined,
  currency: string | undefined,
  fallbackCurrency?: string | null,
  comment?: string | undefined,
) =>
  `${normalizeKeyDate(date)}|${normalizeKeyAmount(amount)}|${normalizeKeyCurrency(
    currency,
    fallbackCurrency,
  )}|${normalizeKeyComment(comment)}`;

const getActivityIssues = (
  activity: ActivityImport,
  fallbackCurrency: string | null,
) => {
  const issues: string[] = [];
  const activityType = activity.activityType;
  const symbol = typeof activity.symbol === 'string' ? activity.symbol.trim() : '';
  const currency =
    typeof activity.currency === 'string' && activity.currency.trim()
      ? activity.currency.trim()
      : fallbackCurrency;

  if (!activityType) {
    issues.push('Missing activity type');
  }
  if (!activity.date) {
    issues.push('Missing date');
  }
  if (!symbol) {
    issues.push('Missing symbol');
  }
  if (!currency) {
    issues.push('Missing currency');
  }

  const amount = activity.amount ?? undefined;
  const quantity = activity.quantity ?? undefined;
  const unitPrice = activity.unitPrice ?? undefined;
  const fee = activity.fee ?? undefined;

  if (TRADE_ACTIVITY_TYPES.has(activityType)) {
    if (!unitPrice || unitPrice <= 0) {
      issues.push('Unit price required for trades');
    }
    if (
      (quantity === undefined || quantity === 0) &&
      (amount === undefined || amount === 0)
    ) {
      issues.push('Quantity or amount required for trades');
    }
  }

  if (FEE_ACTIVITY_TYPES.has(activityType)) {
    if ((fee === undefined || fee === 0) && (amount === undefined || amount === 0)) {
      issues.push('Fee or amount required for fees/taxes');
    }
  }

  if (CASH_LIKE_ACTIVITY_TYPES.has(activityType)) {
    if (amount === undefined || amount === 0) {
      issues.push('Amount required for cash activity');
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
};

interface ImporterPageProps {
  ctx: AddonContext;
}

export default function ImporterPage({ ctx }: ImporterPageProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sourceOverride, setSourceOverride] = useState<'auto' | ImportSourceId>(
    'auto',
  );
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ImportParseResult | null>(null);
  const [detection, setDetection] = useState<ImportDetection | null>(null);
  const [activities, setActivities] = useState<ActivityImport[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extension = file ? getFileExtension(file) : null;
  const effectiveSourceId =
    sourceOverride === 'auto' ? detection?.sourceId ?? null : sourceOverride;
  const effectiveSourceLabel =
    SOURCE_OPTIONS.find((option) => option.id === effectiveSourceId)?.label ?? 'Unknown';
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  );
  const filteredActivities = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const indexed = activities.map((activity, index) => ({ activity, index }));
    if (!query) {
      return indexed;
    }
    return indexed.filter(({ activity }) => {
      const haystack = [
        activity.symbol,
        activity.comment,
        activity.activityType,
        activity.currency,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [activities, searchText]);
  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(filteredActivities.length / pageSize)),
    [filteredActivities.length, pageSize],
  );
  const paginatedActivities = useMemo(() => {
    const startIndex = pageIndex * pageSize;
    return filteredActivities.slice(startIndex, startIndex + pageSize);
  }, [filteredActivities, pageIndex, pageSize]);
  const activityStats = useMemo(() => {
    const fallbackCurrency = selectedAccount?.currency ?? null;
    let invalidCount = 0;
    for (const activity of activities) {
      const status = getActivityIssues(activity, fallbackCurrency);
      if (!status.isValid) {
        invalidCount += 1;
      }
    }
    return {
      total: activities.length,
      invalid: invalidCount,
    };
  }, [activities, selectedAccount]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingAccounts(true);
    setAccountsError(null);
    ctx.api.accounts
      .getAll()
      .then((data) => {
        if (cancelled) {
          return;
        }
        setAccounts(data);
        if (data.length > 0) {
          const defaultAccount = data.find((account) => account.isDefault) ?? data[0];
          setSelectedAccountId((current) => current || defaultAccount?.id || '');
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Failed to load accounts.';
        setAccountsError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingAccounts(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setDetection(null);
      return () => undefined;
    }

    detectImporter(file)
      .then((result) => {
        if (!cancelled) {
          setDetection(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetection(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setParseResult(null);
      setParseError(null);
      setActivities([]);
      setImportError(null);
      setImportSuccess(null);
      setIsParsing(false);
      return () => undefined;
    }

    if (!selectedAccount) {
      setParseResult(null);
      setParseError(null);
      setActivities([]);
      setImportError(null);
      setImportSuccess(null);
      setIsParsing(false);
      return () => undefined;
    }

    if (!effectiveSourceId) {
      setParseResult(null);
      setParseError(null);
      setActivities([]);
      setImportError(null);
      setImportSuccess(null);
      setIsParsing(false);
      return () => undefined;
    }

    const importer = getImporterById(effectiveSourceId);
    if (!importer) {
      setParseResult(null);
      setParseError('No parser available for the selected source.');
      setActivities([]);
      setImportError(null);
      setImportSuccess(null);
      setIsParsing(false);
      return () => undefined;
    }

    const parseOptions: ParseOptions = {
      accountId: selectedAccount.id,
      accountCurrency: selectedAccount.currency,
    };

    setIsParsing(true);
    setParseError(null);
    importer
      .parse(file, parseOptions)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setParseResult(result);
        setActivities(result.records);
        setPageIndex(0);
        setSearchText('');
        setImportError(null);
        setImportSuccess(null);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Failed to parse the file.';
        setParseError(message);
        setParseResult(null);
        setActivities([]);
        setSearchText('');
        setImportError(null);
        setImportSuccess(null);
      })
      .finally(() => {
        if (!cancelled) {
          setIsParsing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [file, effectiveSourceId, selectedAccount]);

  useEffect(() => {
    const maxPageIndex = Math.max(0, pageCount - 1);
    if (pageIndex > maxPageIndex) {
      setPageIndex(maxPageIndex);
    }
  }, [pageCount, pageIndex]);

  useEffect(() => {
    setPageIndex(0);
  }, [searchText]);

  const handleFileSelect = (selectedFile: File | null) => {
    if (!selectedFile) {
      setFile(null);
      setFileError(null);
      setParseResult(null);
      setParseError(null);
      setDetection(null);
      setActivities([]);
      setPageIndex(0);
      setSearchText('');
      setImportError(null);
      setImportSuccess(null);
      setSourceOverride('auto');
      return;
    }

    const selectedExtension = getFileExtension(selectedFile);
    if (!selectedExtension || !SUPPORTED_EXTENSIONS.includes(selectedExtension as typeof SUPPORTED_EXTENSIONS[number])) {
      setFile(null);
      setFileError('Unsupported file type. Please upload CSV, XLSX, or PDF.');
      return;
    }

    setFile(selectedFile);
    setFileError(null);
    setParseError(null);
    setParseResult(null);
    setDetection(null);
    setActivities([]);
    setPageIndex(0);
    setSearchText('');
    setImportError(null);
    setImportSuccess(null);
    setSourceOverride('auto');
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    handleFileSelect(event.dataTransfer.files?.[0] ?? null);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleRemoveFile = () => {
    setFile(null);
    setFileError(null);
    setParseResult(null);
    setParseError(null);
    setDetection(null);
    setActivities([]);
    setPageIndex(0);
    setSearchText('');
    setImportError(null);
    setImportSuccess(null);
    setSourceOverride('auto');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const updateActivityField = <K extends keyof ActivityImport>(
    index: number,
    field: K,
    value: ActivityImport[K],
  ) => {
    setActivities((prev) => {
      if (index < 0 || index >= prev.length) {
        return prev;
      }
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handlePageSizeChange = (value: string) => {
    const nextSize = Number(value);
    if (Number.isFinite(nextSize)) {
      setPageSize(nextSize);
      setPageIndex(0);
    }
  };

  const removeActivity = (index: number) => {
    setActivities((prev) => prev.filter((_, activityIndex) => activityIndex !== index));
  };

  const applyAccountCurrency = () => {
    if (!selectedAccount) {
      return;
    }
    setActivities((prev) =>
      prev.map((activity) =>
        activity.currency && activity.currency.trim()
          ? activity
          : { ...activity, currency: selectedAccount.currency },
      ),
    );
  };

  const fallbackCurrency = selectedAccount?.currency ?? null;
  const canImport = Boolean(
    file &&
      parseResult &&
      activities.length > 0 &&
      selectedAccount &&
      !isParsing &&
      !isImporting,
  );

  const handleImport = async () => {
    if (!selectedAccount || activities.length === 0) {
      return;
    }

    setIsImporting(true);
    setImportError(null);
    setImportSuccess(null);

    const preparedActivities = activities.map((activity) => {
      const currency =
        activity.currency && activity.currency.trim()
          ? activity.currency.trim()
          : selectedAccount.currency;
      const dateValue = activity.date instanceof Date ? activity.date.toISOString() : activity.date;
      return {
        ...activity,
        accountId: selectedAccount.id,
        currency,
        symbol: typeof activity.symbol === 'string' ? activity.symbol.trim() : '',
        date: dateValue ?? '',
        amount: normalizeImportNumber(activity.amount),
        quantity: normalizeImportNumber(activity.quantity) ?? 0,
        unitPrice: normalizeImportNumber(activity.unitPrice) ?? 0,
        fee: normalizeImportNumber(activity.fee) ?? 0,
      };
    });

    try {
      const existingActivities = await ctx.api.activities.getAll(selectedAccount.id);
      const existingKeys = new Set(
        existingActivities.map((activity) =>
          buildActivityKey(
            activity.date instanceof Date ? activity.date : new Date(activity.date),
            activity.amount,
            activity.currency,
            selectedAccount.currency,
            activity.comment ?? '',
          ),
        ),
      );
      let skippedExisting = 0;
      const dedupedActivities = preparedActivities.filter((activity) => {
        const key = buildActivityKey(
          activity.date,
          activity.amount,
          activity.currency,
          selectedAccount.currency,
          activity.comment ?? '',
        );
        if (existingKeys.has(key)) {
          skippedExisting += 1;
          return false;
        }
        return true;
      });

      if (dedupedActivities.length === 0) {
        setImportSuccess(
          skippedExisting > 0
            ? `No new activities to import. ${skippedExisting} duplicate${skippedExisting === 1 ? '' : 's'} already exist.`
            : 'No new activities to import.',
        );
        return;
      }

      const checked = await ctx.api.activities.checkImport(
        selectedAccount.id,
        dedupedActivities,
      );
      const invalidCount = checked.filter((activity) => !activity.isValid).length;
      setActivities(checked);

      if (invalidCount > 0) {
        setImportError(`Fix ${invalidCount} row${invalidCount === 1 ? '' : 's'} before importing.`);
        return;
      }

      const imported = await ctx.api.activities.import(checked);
      const skippedMessage =
        skippedExisting > 0
          ? ` Skipped ${skippedExisting} duplicate${skippedExisting === 1 ? '' : 's'}.`
          : '';
      setImportSuccess(
        `Imported ${imported.length} activit${imported.length === 1 ? 'y' : 'ies'}.${skippedMessage}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed.';
      setImportError(message);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Page>
      <PageHeader
        heading="Import bank or broker statements"
        text="Upload ING, Pekao, XTB, or PayPal exports. We will auto-detect the source, let you confirm it, and preview transactions before import."
        actions={
          <Button variant="outline" onClick={() => ctx.api.navigation.navigate('/addon/wealthfolio-importer/delete')}>
            <Icons.Trash className="mr-2 h-4 w-4" />
            Bulk delete
          </Button>
        }
      />
      <PageContent>
        <div className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle>Select account</CardTitle>
                <CardDescription>
                  Choose the account to import into. Missing currencies default to the
                  account currency.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {isLoadingAccounts && (
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Icons.Spinner className="h-4 w-4 animate-spin" />
                    Loading accounts...
                  </div>
                )}
                {accountsError && (
                  <div className="text-destructive flex items-center gap-2 text-sm">
                    <Icons.AlertCircle className="h-4 w-4" />
                    {accountsError}
                  </div>
                )}
                {!isLoadingAccounts && !accountsError && accounts.length === 0 && (
                  <div className="text-muted-foreground text-sm">
                    No accounts available. Create one in Wealthfolio first.
                  </div>
                )}
                {accounts.length > 0 && (
                  <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name} · {account.currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {selectedAccount && (
                  <div className="text-muted-foreground text-xs">
                    Importing to <span className="font-medium text-foreground">{selectedAccount.name}</span>
                    {' '}({selectedAccount.currency})
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Upload statement</CardTitle>
                <CardDescription>
                  Drag and drop a CSV, XLSX, or PDF file, or browse to select it.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
                  className={`flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-4 text-center transition ${
                    isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/40 bg-muted/30'
                  }`}
                  onClick={handleBrowseClick}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <Icons.Import className="text-muted-foreground mb-2 h-8 w-8" />
                  <div className="text-sm font-medium">Drop a file here or click to browse</div>
                  <div className="text-muted-foreground text-xs">
                    Supported: CSV, XLSX, PDF
                  </div>
                </div>

                <Input
                  ref={fileInputRef}
                  type="file"
                  accept={FILE_ACCEPT}
                  onChange={(event) => handleFileSelect(event.target.files?.[0] ?? null)}
                  className="hidden"
                />

                {file && (
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div className="space-y-1">
                      <div className="font-medium">{file.name}</div>
                      <div className="text-muted-foreground text-xs">
                        {formatBytes(file.size)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{extension?.toUpperCase() ?? 'FILE'}</Badge>
                      <Button variant="outline" size="sm" onClick={handleRemoveFile}>
                        Remove
                      </Button>
                    </div>
                  </div>
                )}

                {fileError && (
                  <div className="text-destructive flex items-center gap-2 text-sm">
                    <Icons.AlertCircle className="h-4 w-4" />
                    {fileError}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Source detection</CardTitle>
                <CardDescription>
                  We auto-detect the statement format and let you override it if needed.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!file && (
                  <div className="text-muted-foreground text-sm">
                    Upload a file to run auto-detection.
                  </div>
                )}

                {file && detection && (
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">Auto-detected</Badge>
                        <span className="font-medium">{SOURCE_OPTIONS.find((option) => option.id === detection.sourceId)?.label ?? 'Unknown'}</span>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {detection.reason} · Confidence {Math.round(detection.confidence * 100)}%
                      </div>
                    </div>
                    <Icons.CheckCircle className="text-emerald-500 h-5 w-5" />
                  </div>
                )}
                {file && !detection && (
                  <div className="text-muted-foreground text-sm">
                    Auto-detection not available for this file yet.
                  </div>
                )}

                <div className="space-y-2">
                  <div className="text-sm font-medium">Confirm source</div>
                  <Select
                    value={sourceOverride}
                    onValueChange={(value) =>
                      setSourceOverride(value as 'auto' | ImportSourceId)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Auto-detect" />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCE_OPTIONS.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="text-muted-foreground text-xs">
                    Using: <span className="font-medium text-foreground">{effectiveSourceLabel}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Commit import</CardTitle>
                <CardDescription>
                  Import will create activities once the commit pipeline is wired up.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">File</span>
                    <span className="font-medium">{file ? file.name : 'No file selected'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Source</span>
                    <span className="font-medium">{effectiveSourceId ? effectiveSourceLabel : 'Unknown'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Rows</span>
                    <span className="font-medium">
                      {parseResult ? `${activities.length} ready` : file ? 'Pending parse' : '-'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Duplicates</span>
                    <span className="font-medium">
                      {parseResult ? parseResult.duplicates : '-'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Account</span>
                    <span className="font-medium">
                      {selectedAccount ? selectedAccount.name : '-'}
                    </span>
                  </div>
                </div>

                {importError && (
                  <div className="text-destructive flex items-center gap-2 text-sm">
                    <Icons.AlertCircle className="h-4 w-4" />
                    {importError}
                  </div>
                )}
                {importSuccess && (
                  <div className="text-emerald-600 flex items-center gap-2 text-sm">
                    <Icons.CheckCircle className="h-4 w-4" />
                    {importSuccess}
                  </div>
                )}
                {isImporting && (
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Icons.Spinner className="h-4 w-4 animate-spin" />
                    Importing transactions...
                  </div>
                )}

                <Button
                  className="w-full"
                  disabled={!canImport}
                  onClick={handleImport}
                >
                  Import transactions
                </Button>
                <Button variant="outline" className="w-full" onClick={handleRemoveFile} disabled={!file}>
                  Start over
                </Button>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Preview transactions</CardTitle>
              <CardDescription>
                Review and edit transactions before importing. Preview updates when parsing completes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {!file && (
                  <div className="text-muted-foreground text-sm">
                    Upload a file to see a transaction preview.
                  </div>
                )}

                {file && isParsing && (
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Icons.Spinner className="h-4 w-4 animate-spin" />
                    Parsing file...
                  </div>
                )}

                {file && !selectedAccount && (
                  <div className="text-muted-foreground text-sm">
                    Select an account to start parsing.
                  </div>
                )}

                {file &&
                  selectedAccount &&
                  !isParsing &&
                  !parseResult &&
                  !parseError &&
                  !effectiveSourceId && (
                  <div className="text-muted-foreground text-sm">
                    Select a source to start parsing.
                  </div>
                )}

                {file && parseError && (
                  <div className="text-destructive flex items-center gap-2 text-sm">
                    <Icons.AlertCircle className="h-4 w-4" />
                    {parseError}
                  </div>
                )}

                {file && !isParsing && parseResult && (
                  <>
                    <div className="flex items-center justify-between text-xs">
                      <div className="text-muted-foreground">
                        Showing {paginatedActivities.length} of {filteredActivities.length} rows
                        {filteredActivities.length !== activityStats.total
                          ? ` (${activityStats.total} total)`
                          : ''}
                      </div>
                      <Badge variant="outline">
                        {parseResult.duplicates > 0
                          ? `${parseResult.duplicates} duplicate${parseResult.duplicates === 1 ? '' : 's'} detected`
                          : 'No duplicates detected'}
                      </Badge>
                    </div>
                    <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-4">
                      <div>
                        <div className="text-muted-foreground">Total rows</div>
                        <div className="font-semibold">{activityStats.total}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Needs review</div>
                        <div className="font-semibold">{activityStats.invalid}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Duplicates detected</div>
                        <div className="font-semibold">{parseResult.duplicates}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Warnings</div>
                        <div className="font-semibold">{parseResult.warnings.length}</div>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <Input
                        placeholder="Filter by symbol, comment, or type"
                        value={searchText}
                        onChange={(event) => setSearchText(event.target.value)}
                        className="h-8 sm:max-w-[260px]"
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSearchText('')}
                          disabled={!searchText}
                        >
                          Clear filter
                        </Button>
                      </div>
                    </div>
                    {parseResult.warnings.length > 0 && (
                      <div className="text-muted-foreground text-xs">
                        {parseResult.warnings.slice(0, 3).map((warning) => (
                          <div key={warning}>{warning}</div>
                        ))}
                        {parseResult.warnings.length > 3 && (
                          <div>+{parseResult.warnings.length - 3} more warnings</div>
                        )}
                      </div>
                    )}
                    {activities.length === 0 ? (
                      <div className="text-muted-foreground text-sm">No rows parsed.</div>
                    ) : filteredActivities.length === 0 ? (
                      <div className="text-muted-foreground text-sm">
                        No rows match the current filter.
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                          <div className="text-muted-foreground">
                            Page {pageIndex + 1} of {pageCount}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">Rows</span>
                            <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
                              <SelectTrigger className="h-8 w-[90px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {PAGE_SIZE_OPTIONS.map((size) => (
                                  <SelectItem key={size} value={String(size)}>
                                    {size}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                              disabled={pageIndex === 0}
                            >
                              Prev
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setPageIndex((current) => Math.min(pageCount - 1, current + 1))
                              }
                              disabled={pageIndex >= pageCount - 1}
                            >
                              Next
                            </Button>
                          </div>
                        </div>
                        <div className="rounded-md border overflow-x-auto">
                          <Table className="min-w-[1120px] text-xs">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-[90px] px-2">Status</TableHead>
                                <TableHead className="w-[50px] px-2 text-center">
                                  <span className="sr-only">Actions</span>
                                </TableHead>
                                <TableHead className="w-[170px] px-2">Date</TableHead>
                                <TableHead className="w-[140px] px-2">Type</TableHead>
                                <TableHead className="px-2 min-w-[120px]">Symbol</TableHead>
                                <TableHead className="px-2 text-right">Amount</TableHead>
                                <TableHead className="w-[90px] px-2">
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-1 text-xs text-muted-foreground"
                                      >
                                        Currency
                                        <Icons.ChevronsUpDown className="ml-1 h-3 w-3 opacity-60" />
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-56 space-y-2 text-xs" align="start">
                                      <div className="font-medium">Currency actions</div>
                                      <p className="text-muted-foreground">
                                        Fill empty currency cells with the selected account currency.
                                      </p>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={applyAccountCurrency}
                                        disabled={!selectedAccount}
                                      >
                                        Apply {selectedAccount?.currency ?? 'account currency'}
                                      </Button>
                                    </PopoverContent>
                                  </Popover>
                                </TableHead>
                                <TableHead className="px-2 text-right">Quantity</TableHead>
                                <TableHead className="px-2 text-right">Unit Price</TableHead>
                                <TableHead className="px-2 text-right">Fee</TableHead>
                                <TableHead className="px-2 min-w-[240px]">Comment</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {paginatedActivities.map(({ activity, index }) => {
                                const activityIndex = index;
                                const status = getActivityIssues(activity, fallbackCurrency);
                                return (
                                  <TableRow
                                    key={`${activityIndex}-${activity.lineNumber ?? ''}`}
                                    className={status.isValid ? undefined : 'bg-destructive/5'}
                                  >
                                    <TableCell className="px-2 py-1">
                                      <Badge
                                        variant={status.isValid ? 'secondary' : 'destructive'}
                                        title={status.issues.join(' | ')}
                                      >
                                        {status.isValid ? 'Ready' : 'Review'}
                                      </Badge>
                                    </TableCell>
                                    <TableCell className="px-2 py-1 text-center">
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                        onClick={() => removeActivity(activityIndex)}
                                      >
                                        <Icons.Trash className="h-4 w-4" />
                                      </Button>
                                    </TableCell>
                                    <TableCell className="px-2 py-1">
                                      <Input
                                        type="datetime-local"
                                        value={formatInputDateTime(activity.date)}
                                        className={TABLE_INPUT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(
                                            activityIndex,
                                            'date',
                                            parseInputDateTime(event.target.value),
                                          )
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-1">
                                      <Select
                                        value={activity.activityType}
                                        onValueChange={(value) =>
                                          updateActivityField(activityIndex, 'activityType', value as ActivityImport['activityType'])
                                        }
                                      >
                                        <SelectTrigger className={TABLE_SELECT_TRIGGER_CLASS}>
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {ACTIVITY_TYPE_OPTIONS.map((type) => (
                                            <SelectItem key={type} value={type}>
                                              {type}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </TableCell>
                                    <TableCell className="px-2 py-1 min-w-[120px]">
                                      <Input
                                        value={activity.symbol ?? ''}
                                        className={TABLE_INPUT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(activityIndex, 'symbol', event.target.value)
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-1 text-right">
                                      <Input
                                        type="number"
                                        step="0.01"
                                        value={activity.amount ?? ''}
                                        className={TABLE_INPUT_RIGHT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(
                                            activityIndex,
                                            'amount',
                                            parseNumberValue(event.target.value),
                                          )
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-1">
                                      <Input
                                        value={activity.currency ?? ''}
                                        placeholder={fallbackCurrency ?? ''}
                                        className={TABLE_INPUT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(activityIndex, 'currency', event.target.value)
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-1 text-right">
                                      <Input
                                        type="number"
                                        step="0.0001"
                                        value={activity.quantity ?? ''}
                                        className={TABLE_INPUT_RIGHT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(
                                            activityIndex,
                                            'quantity',
                                            parseNumberValue(event.target.value),
                                          )
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-1 text-right">
                                      <Input
                                        type="number"
                                        step="0.0001"
                                        value={activity.unitPrice ?? ''}
                                        className={TABLE_INPUT_RIGHT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(
                                            activityIndex,
                                            'unitPrice',
                                            parseNumberValue(event.target.value),
                                          )
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-1 text-right">
                                      <Input
                                        type="number"
                                        step="0.01"
                                        value={activity.fee ?? ''}
                                        className={TABLE_INPUT_RIGHT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(
                                            activityIndex,
                                            'fee',
                                            parseNumberValue(event.target.value),
                                          )
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="px-2 py-1 min-w-[240px]">
                                      <Input
                                        value={activity.comment ?? ''}
                                        className={TABLE_INPUT_CLASS}
                                        onChange={(event) =>
                                          updateActivityField(activityIndex, 'comment', event.target.value)
                                        }
                                      />
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </>
                    )}
                  </>
                )}
              </CardContent>
          </Card>
        </div>
      </PageContent>
    </Page>
  );
}
