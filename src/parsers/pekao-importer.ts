import { BaseImporter } from './base-importer';
import type { ImportDetection, ImportParseResult, ParseOptions } from './types';

export class PekaoImporter extends BaseImporter {
  id = 'pekao' as const;
  label = 'Pekao Bank';
  supportedExtensions = ['mhtml'];
  fileNamePattern = /^Pekao24\.mhtml$/i;

  async detect(file: File): Promise<ImportDetection | null> {
    if (this.fileNamePattern?.test(file.name)) {
      return {
        sourceId: this.id,
        confidence: 0.85,
        reason: 'Filename matches Pekao export pattern',
      };
    }
    return null;
  }

  async parse(file: File, _options: ParseOptions): Promise<ImportParseResult> {
    const warnings: string[] = [];
    const mhtml = await file.text();
    const frame = findPekaoInvestmentsFrame(mhtml);

    if (!frame) {
      return this.finalize([], [
        'Unable to locate the Pekao investments frame in the MHTML file.',
      ]);
    }

    const doc = new DOMParser().parseFromString(frame.html, 'text/html');
    console.log('Pekao investments DOM', doc);

    if (frame.contentLocation) {
      warnings.push(`Parsed Pekao frame from ${frame.contentLocation}.`);
    }

    return this.finalize([], warnings);
  }
}

type MhtmlFrame = {
  html: string;
  contentLocation: string | null;
};

const findPekaoInvestmentsFrame = (mhtml: string): MhtmlFrame | null => {
  const boundary = extractMhtmlBoundary(mhtml);
  if (!boundary) {
    return null;
  }

  const parts = splitMhtmlParts(mhtml, boundary);
  for (const part of parts) {
    const parsed = parseMhtmlPart(part);
    if (!parsed) {
      continue;
    }
    const { headers, body } = parsed;
    const decoded = decodeMhtmlBody(body, headers);
    if (decoded && /<pekao-root-investments\b/i.test(decoded)) {
      return {
        html: decoded,
        contentLocation: headers['content-location'] ?? null,
      };
    }
  }

  return null;
};

const extractMhtmlBoundary = (mhtml: string) => {
  const headerMatch =
    mhtml.match(/boundary="([^"]+)"/i) ?? mhtml.match(/boundary=([^\s;]+)/i);
  return headerMatch ? headerMatch[1] : null;
};

const splitMhtmlParts = (mhtml: string, boundary: string) => {
  const marker = `--${boundary}`;
  const segments = mhtml.split(marker);
  const parts: string[] = [];

  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.startsWith('--')) {
      break;
    }
    parts.push(segment);
  }

  return parts;
};

const parseMhtmlPart = (part: string) => {
  const trimmed = part.replace(/^\r?\n/, '');
  const separatorMatch = trimmed.match(/\r?\n\r?\n/);
  if (!separatorMatch || separatorMatch.index === undefined) {
    return null;
  }
  const separatorIndex = separatorMatch.index;
  const separatorLength = separatorMatch[0].length;
  const rawHeaders = trimmed.slice(0, separatorIndex);
  const body = trimmed.slice(separatorIndex + separatorLength);
  const headers = parseMhtmlHeaders(rawHeaders);

  return { headers, body };
};

const parseMhtmlHeaders = (rawHeaders: string) => {
  const headers: Record<string, string> = {};
  const lines = rawHeaders.split(/\r?\n/);
  let currentHeader: string | null = null;

  for (const line of lines) {
    if (/^\s/.test(line) && currentHeader) {
      headers[currentHeader] = `${headers[currentHeader]} ${line.trim()}`;
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[name] = value;
    currentHeader = name;
  }

  return headers;
};

const decodeMhtmlBody = (body: string, headers: Record<string, string>) => {
  const transferEncoding = headers['content-transfer-encoding']?.toLowerCase();
  const contentType = headers['content-type'] ?? '';
  const charsetMatch = contentType.match(/charset="?([^";\s]+)"?/i);
  const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';

  if (transferEncoding === 'quoted-printable') {
    return decodeQuotedPrintable(body, charset);
  }

  if (transferEncoding === 'base64') {
    return decodeBase64(body, charset);
  }

  return body;
};

const decodeQuotedPrintable = (input: string, charset: string) => {
  const normalized = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '=' && i + 2 < normalized.length) {
      const hex = normalized.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(normalized.charCodeAt(i));
  }

  return decodeBytes(bytes, charset);
};

const decodeBase64 = (input: string, charset: string) => {
  const cleaned = input.replace(/\s+/g, '');

  if (typeof atob === 'function') {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return decodeBytes(Array.from(bytes), charset);
  }

  if (typeof Buffer !== 'undefined') {
    const bytes = Uint8Array.from(Buffer.from(cleaned, 'base64'));
    return decodeBytes(Array.from(bytes), charset);
  }

  return '';
};

const decodeBytes = (bytes: number[], charset: string) => {
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
};
