import { BaseImporter } from './base-importer';
import type { ImportParseResult, ParseOptions } from './types';

export class PekaoImporter extends BaseImporter {
  id = 'pekao' as const;
  label = 'Pekao Bank';
  supportedExtensions = ['csv', 'xlsx', 'xls', 'pdf'];

  async parse(_file: File, _options: ParseOptions): Promise<ImportParseResult> {
    return this.finalize([], ['Pekao parser is not implemented yet.']);
  }
}
