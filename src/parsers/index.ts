import { IngImporter } from './ing-importer';
import { PayPalImporter } from './paypal-importer';
import { PekaoImporter } from './pekao-importer';
import { XtbImporter } from './xtb-importer';
import type { ImportDetection, ImportSourceId } from './types';

const importers = [
  new IngImporter(),
  new PekaoImporter(),
  new XtbImporter(),
  new PayPalImporter(),
];

export const getSupportedExtensions = () => {
  const extensions: string[] = [];
  for (const importer of importers) {
    for (const extension of importer.supportedExtensions) {
      const normalized = extension.toLowerCase();
      if (!extensions.includes(normalized)) {
        extensions.push(normalized);
      }
    }
  }
  return extensions;
};

export const getImporterById = (id: ImportSourceId | null | undefined) =>
  importers.find((importer) => importer.id === id) ?? null;

export const detectImporter = async (file: File): Promise<ImportDetection | null> => {
  const detections = await Promise.all(
    importers.map(async (importer) => {
      if (!importer.detect) {
        return null;
      }
      return importer.detect(file);
    }),
  );

  const filtered = detections.filter(
    (detection): detection is ImportDetection => detection !== null,
  );
  if (filtered.length === 0) {
    return null;
  }

  return filtered.sort((a, b) => b.confidence - a.confidence)[0];
};

export type {
  ImportDetection,
  ImportParseResult,
  ImportSourceId,
  ParseOptions,
} from './types';
