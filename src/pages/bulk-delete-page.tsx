import React, { useEffect, useMemo, useState } from 'react';
import { QueryKeys } from '@wealthfolio/addon-sdk';
import type { Account, ActivityDetails, AddonContext } from '@wealthfolio/addon-sdk';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@wealthfolio/ui';

const parseDate = (value: Date | string) => {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

const parseStartDate = (value: string) => {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

const parseEndDate = (value: string) => {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

const chunkArray = <T,>(items: T[], size: number) => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

const refreshPortfolioStats = async (ctx: AddonContext, accountId: string) => {
  await ctx.api.portfolio.recalculate();
  const queryKeys = [
    QueryKeys.ACTIVITIES,
    QueryKeys.ACTIVITY_DATA,
    QueryKeys.HOLDINGS,
    QueryKeys.PORTFOLIO_SUMMARY,
    QueryKeys.ACCOUNTS_SUMMARY,
    QueryKeys.INCOME_SUMMARY,
    QueryKeys.PERFORMANCE_SUMMARY,
    QueryKeys.latestValuations,
  ];
  queryKeys.forEach((key) => ctx.api.query.invalidateQueries(key));
  ctx.api.query.invalidateQueries(QueryKeys.valuationHistory(accountId));
};

interface BulkDeletePageProps {
  ctx: AddonContext;
}

export default function BulkDeletePage({ ctx }: BulkDeletePageProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [activities, setActivities] = useState<ActivityDetails[]>([]);
  const [isLoadingActivities, setIsLoadingActivities] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  );
  const dateRange = useMemo(() => {
    return {
      start: parseStartDate(fromDate),
      end: parseEndDate(toDate),
    };
  }, [fromDate, toDate]);
  const filteredActivities = useMemo(() => {
    if (!activities.length) {
      return [];
    }
    return activities.filter((activity) => {
      const activityDate = parseDate(activity.date);
      if (!activityDate) {
        return false;
      }
      if (dateRange.start && activityDate < dateRange.start) {
        return false;
      }
      if (dateRange.end && activityDate > dateRange.end) {
        return false;
      }
      return true;
    });
  }, [activities, dateRange.end, dateRange.start]);

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

  const handleLoadActivities = async () => {
    if (!selectedAccount) {
      return;
    }
    setIsLoadingActivities(true);
    setDeleteError(null);
    setDeleteSuccess(null);
    setConfirmDelete(false);
    try {
      const data = await ctx.api.activities.getAll(selectedAccount.id);
      setActivities(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load activities.';
      setDeleteError(message);
    } finally {
      setIsLoadingActivities(false);
    }
  };

  const handleDeleteActivities = async () => {
    if (!selectedAccount || filteredActivities.length === 0) {
      return;
    }

    setIsDeleting(true);
    setDeleteError(null);
    setDeleteSuccess(null);
    try {
      const deleteIds = filteredActivities.map((activity) => activity.id);
      const chunks = chunkArray(deleteIds, 300);
      for (const chunk of chunks) {
        await ctx.api.activities.saveMany({ deleteIds: chunk });
      }
      try {
        await refreshPortfolioStats(ctx, selectedAccount.id);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to refresh portfolio stats after deletion.';
        setDeleteError(message);
      }
      setDeleteSuccess(`Deleted ${deleteIds.length} activit${deleteIds.length === 1 ? 'y' : 'ies'}.`);
      setActivities((prev) => prev.filter((activity) => !deleteIds.includes(activity.id)));
      setConfirmDelete(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deletion failed.';
      setDeleteError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Page>
      <PageHeader
        heading="Bulk delete activities"
        text="Select an account and date range to remove activities in bulk."
        actions={
          <Button variant="outline" onClick={() => ctx.api.navigation.navigate('/addon/wealthfolio-importer')}>
            <Icons.ArrowLeft className="mr-2 h-4 w-4" />
            Back to import
          </Button>
        }
      />
      <PageContent>
        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Deletion scope</CardTitle>
              <CardDescription>Choose the account and date range to delete.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-muted-foreground text-xs">From</div>
                  <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">To</div>
                  <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
                </div>
              </div>

              <Button
                variant="outline"
                className="w-full"
                disabled={!selectedAccount || isLoadingActivities}
                onClick={handleLoadActivities}
              >
                {isLoadingActivities ? 'Loading...' : 'Load activities'}
              </Button>

              {deleteError && (
                <div className="text-destructive flex items-center gap-2 text-sm">
                  <Icons.AlertCircle className="h-4 w-4" />
                  {deleteError}
                </div>
              )}
              {deleteSuccess && (
                <div className="text-emerald-600 flex items-center gap-2 text-sm">
                  <Icons.CheckCircle className="h-4 w-4" />
                  {deleteSuccess}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Preview deletions</CardTitle>
              <CardDescription>
                Confirm the count before deleting. This action cannot be undone.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!selectedAccount && (
                <div className="text-muted-foreground text-sm">Select an account to begin.</div>
              )}
              {selectedAccount && activities.length === 0 && (
                <div className="text-muted-foreground text-sm">
                  Load activities to see how many will be deleted.
                </div>
              )}
              {selectedAccount && activities.length > 0 && (
                <div className="rounded-md border p-4 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Account</span>
                    <span className="font-medium">{selectedAccount.name}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Total loaded</span>
                    <span className="font-medium">{activities.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Matched range</span>
                    <span className="font-medium">{filteredActivities.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Date range</span>
                    <span className="font-medium">
                      {fromDate || 'Any'} → {toDate || 'Any'}
                    </span>
                  </div>
                </div>
              )}

              {filteredActivities.length > 0 && (
                <div className="flex items-center gap-2">
                  <Badge variant="destructive">{filteredActivities.length} to delete</Badge>
                  <label className="text-xs text-muted-foreground flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={confirmDelete}
                      onChange={(event) => setConfirmDelete(event.target.checked)}
                    />
                    I understand this cannot be undone
                  </label>
                </div>
              )}

              <Button
                variant="destructive"
                className="w-full"
                disabled={!confirmDelete || filteredActivities.length === 0 || isDeleting}
                onClick={handleDeleteActivities}
              >
                {isDeleting ? 'Deleting...' : 'Delete activities'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </PageContent>
    </Page>
  );
}
