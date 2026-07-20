import React from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Icons } from '@wealthfolio/ui';
import BulkDeletePage from './pages/bulk-delete-page';
import ImporterPage from './pages/importer-page';
import MappingsPage from './pages/mappings-page';
import QuoteScraperPage from './pages/quote-scraper-page';
import { startPolishBondTracking } from './services/polish-bonds';
import { startQuoteScraperTracking } from './services/quote-scraper';

export default function enable(ctx: AddonContext) {
  // Add a sidebar item
  const sidebarItem = ctx.sidebar.addItem({
    id: 'wealthfolio-importer',
    label: 'Importer',
    icon: 'blocks',
    route: '/addon/wealthfolio-importer',
    order: 100,
  });

  // Add a route
  const Wrapper = () => <ImporterPage ctx={ctx} />;
  ctx.router.add({
    path: '/addon/wealthfolio-importer',
    component: React.lazy(() => Promise.resolve({ default: Wrapper })),
  } as any);

  const DeleteWrapper = () => <BulkDeletePage ctx={ctx} />;
  ctx.router.add({
    path: '/addon/wealthfolio-importer/delete',
    component: React.lazy(() => Promise.resolve({ default: DeleteWrapper })),
  } as any);

  const MappingsWrapper = () => <MappingsPage ctx={ctx} />;
  ctx.router.add({
    path: '/addon/wealthfolio-importer/mappings',
    component: React.lazy(() => Promise.resolve({ default: MappingsWrapper })),
  } as any);

  const QuoteScraperWrapper = () => <QuoteScraperPage ctx={ctx} />;
  ctx.router.add({
    path: '/addon/wealthfolio-importer/quote-scraper',
    component: React.lazy(() => Promise.resolve({ default: QuoteScraperWrapper })),
  } as any);

  const stopPolishBondTracking = startPolishBondTracking(ctx);
  const stopQuoteScraperTracking = startQuoteScraperTracking(ctx);

  // Cleanup on disable
  ctx.onDisable(() => {
    try {
      stopPolishBondTracking();
    } catch (err) {
      ctx.api.logger.error(
        `Failed to stop bond tracking: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      stopQuoteScraperTracking();
    } catch (err) {
      ctx.api.logger.error(
        `Failed to stop quote scraper tracking: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      sidebarItem.remove();
    } catch (err) {
      ctx.api.logger.error(
        `Failed to remove sidebar item: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
