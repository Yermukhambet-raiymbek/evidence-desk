import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from './store.ts';
import { answer } from './answers.ts';
import type { OllamaConfig } from './answers.ts';
import { search, tokenize } from './retrieval.ts';
import { HttpError } from './types.ts';

export const MAX_BODY_BYTES = 160 * 1024;
type Config = { store: Store; token: string; ollama?: OllamaConfig; requestsPerMinute?: number; onLog?: (event: Record<string, unknown>) => void };
const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Send application/json.');
  let size = 0; const buffers: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'Request exceeds 160 KiB.');
    buffers.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'Body must be valid JSON.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError(400, 'invalid_body', 'Body must be a JSON object.');
  return body;
}
function queryInput(body: Record<string, unknown>, key: string) {
  const query = body[key]; const topK = body.topK ?? 3;
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 500 || !tokenize(query).length)
    throw new HttpError(400, 'invalid_query', `${key} must contain searchable text, between 2 and 500 characters.`);
  if (!Number.isInteger(topK) || Number(topK) < 1 || Number(topK) > 5) throw new HttpError(400, 'invalid_top_k', 'topK must be an integer from 1 to 5.');
  return { query: query.trim(), topK: Number(topK) };
}
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }

export function createApp(config: Config) {
  if (config.token.length < 24 || config.token.startsWith('replace-with')) throw new Error('EVIDENCE_API_TOKEN must contain at least 24 characters and must not use the example value.');
  let bucketStart = Date.now(); let requestCount = 0; let activeAnswers = 0;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID(); const started = Date.now();
    res.setHeader('X-Request-ID', requestId); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.on('finish', () => config.onLog?.({ requestId, method: req.method, status: res.statusCode, durationMs: Date.now() - started }));
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', version: '0.1.0' });
      if (!sameToken(req.headers.authorization ?? '', `Bearer ${config.token}`)) throw new HttpError(401, 'unauthorized', 'A valid bearer token is required.');
      if (Date.now() - bucketStart > 60_000) { bucketStart = Date.now(); requestCount = 0; }
      if (++requestCount > (config.requestsPerMinute ?? 120)) { res.setHeader('Retry-After', '60'); throw new HttpError(429, 'rate_limited', 'Request limit reached. Retry in one minute.'); }
      if (url.pathname === '/v1/documents') {
        if (req.method === 'GET') return json(res, 200, { documents: config.store.list() });
        if (req.method === 'POST') { const body = await readJson(req); return json(res, 201, config.store.create(body.name, body.content)); }
      }
      const docMatch = url.pathname.match(/^\/v1\/documents\/([a-f0-9-]{36})$/);
      if (docMatch) {
        if (req.method === 'GET') return json(res, 200, config.store.get(docMatch[1]));
        if (req.method === 'PUT') { const body = await readJson(req); return json(res, 200, config.store.update(docMatch[1], body.name, body.content, body.expectedRevision)); }
        if (req.method === 'DELETE') { config.store.remove(docMatch[1]); res.writeHead(204); return res.end(); }
      }
      const sourceMatch = url.pathname.match(/^\/v1\/sources\/([a-f0-9]{32})$/);
      if (sourceMatch && req.method === 'GET') return json(res, 200, config.store.source(sourceMatch[1]));
      if (url.pathname === '/v1/search' && req.method === 'POST') {
        const { query, topK } = queryInput(await readJson(req), 'query'); return json(res, 200, { hits: search(config.store.sources(), query, topK) });
      }
      if (['/v1/answers', '/v1/answers/stream'].includes(url.pathname) && req.method === 'POST') {
        const body = await readJson(req); const { query, topK } = queryInput(body, 'question');
        const mode = body.mode ?? 'extractive';
        if (mode !== 'extractive' && mode !== 'ollama') throw new HttpError(400, 'invalid_mode', 'mode must be extractive or ollama.');
        if (activeAnswers >= 4) throw new HttpError(429, 'busy', 'At most four answers may run concurrently.');
        activeAnswers++;
        let result;
        try { result = await answer(config.store, query, topK, mode, config.ollama); } finally { activeAnswers--; }
        if (url.pathname.endsWith('/stream')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
          const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          event('metadata', { mode: result.mode, status: result.status, requestId });
          for (const citation of result.citations) event('citation', citation);
          event('answer', result); event('done', {}); return res.end();
        }
        return json(res, 200, result);
      }
      throw new HttpError(404, 'not_found', 'Route not found.');
    } catch (error) {
      const known = error instanceof HttpError;
      if (!res.headersSent) json(res, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Internal server error.', requestId } });
      else res.end();
    }
  });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  return server;
}
