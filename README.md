# Wealthfolio Importer

A Wealthfolio addon that imports activities from bank/broker exports and lets you
clean them up before committing.

## What it does
- Adds a Wealthfolio sidebar entry with an import workflow, symbol mapping tools, and bulk delete.
- Parses supported exports into draft activities with validation and inline editing.
- Deduplicates against existing activities and runs Wealthfolio validation before import.
- Refreshes manual quotes for assets you configure in the quote scraper (fetch a URL, run JS, write quotes).

## Supported sources and file types
- ING Bank: CSV exports named like `Lista_transakcji_nr_...csv`
- Pekao Bank: MHTML export `Pekao24.mhtml`
- XTB Broker: XLS/XLSX export with `CASH OPERATION HISTORY` sheet
- PayPal: CSV export named like `Download*.CSV` (Polish headers)

## Import workflow
1. Select the Wealthfolio account to import into.
2. Upload a statement file or drag-and-drop it.
3. Confirm the detected source (or override it).
4. Review the parsed activities, edit cells inline, and resolve validation issues.
5. Import. The addon skips duplicates and runs `checkImport` before committing.

## Symbol mappings
- Map broker symbols to the tickers you want to keep in Wealthfolio.
- Suggestions come from the market data search endpoint (Yahoo).
- Saved mappings are applied to future imports and can be applied to existing activities.

## Bulk delete
- Pick an account and date range, preview the matched activities, and delete in bulk.
- Recalculates portfolio stats after deletion.

## Development
```bash
# Install dependencies
npm install

# Start development server
npm run dev:server

# Build for production
npm run build

# Package addon
npm run bundle
```

## License

MIT
