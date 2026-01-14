import React from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Icons } from '@wealthfolio/ui';
import BulkDeletePage from './pages/bulk-delete-page';
import ImporterPage from './pages/importer-page';

export default function enable(ctx: AddonContext) {
  // Add a sidebar item
  const sidebarItem = ctx.sidebar.addItem({
    id: 'wealthfolio-importer',
    label: 'Wealthfolio Importer',
    icon: <Icons.Blocks className="h-5 w-5" />,
    route: '/addon/wealthfolio-importer',
    order: 100,
  });

  // Add a route
  const Wrapper = () => <ImporterPage ctx={ctx} />;
  ctx.router.add({
    path: '/addon/wealthfolio-importer',
    component: React.lazy(() => Promise.resolve({ default: Wrapper })),
  });

  const DeleteWrapper = () => <BulkDeletePage ctx={ctx} />;
  ctx.router.add({
    path: '/addon/wealthfolio-importer/delete',
    component: React.lazy(() => Promise.resolve({ default: DeleteWrapper })),
  });

  // Cleanup on disable
  ctx.onDisable(() => {
    try {
      sidebarItem.remove();
    } catch (err) {
      ctx.api.logger.error('Failed to remove sidebar item:', err);
    }
  });
}
