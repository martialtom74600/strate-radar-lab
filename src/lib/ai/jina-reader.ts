import { StrateRadarError } from '../errors.js';
import { toAbsoluteHttpUrl } from '../url.js';

export const DEFAULT_JINA_MAX_MARKDOWN_CHARS = 12_000;

export type JinaReaderFetchResult =
  | { readonly ok: true; readonly markdown: string; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number };

function truncateMarkdown(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

/** Fetch page markdown via Jina Reader (`https://r.jina.ai/{URL}`). */
export async function fetchJinaReaderMarkdown(args: {
  readonly url: string;
  readonly timeoutMs: number;
  readonly maxMarkdownChars?: number;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): Promise<JinaReaderFetchResult> {
  const abs = toAbsoluteHttpUrl(args.url.trim());
  if (!abs) {
    return { ok: false, error: 'URL invalide', latencyMs: 0 };
  }

  const maxChars = args.maxMarkdownChars ?? DEFAULT_JINA_MAX_MARKDOWN_CHARS;
  const fetchFn = args.fetchImpl ?? fetch;
  const jinaUrl = `https://r.jina.ai/${abs}`;
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    Accept: 'text/plain',
  };
  const key = args.apiKey?.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  try {
    const response = await fetchFn(jinaUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        error: `Jina HTTP ${response.status}`,
        latencyMs,
      };
    }

    const body = await response.text();
    const markdown = truncateMarkdown(body, maxChars);
    if (!markdown) {
      return { ok: false, error: 'Jina : contenu vide', latencyMs };
    }

    return { ok: true, markdown, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        ok: false,
        error: `Jina timeout > ${args.timeoutMs}ms`,
        latencyMs,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200), latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

export function assertJinaReaderAvailable(url: string): void {
  if (!toAbsoluteHttpUrl(url)) {
    throw new StrateRadarError('JINA_READER', 'URL invalide pour Jina Reader.');
  }
}
