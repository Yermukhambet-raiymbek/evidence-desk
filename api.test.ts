import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, MAX_DOCUMENT_BYTES } from '../src/store.ts';
import { createApp } from '../src/app.ts';
const token = 'test-token-for-local-tests-only-12345';
async function fixture(options: { requestsPerMinute?: number } = {}) {
  const store = new Store(); const logs: any[] = [];
  const server = createApp({ store, token, ...options, onLog: event => logs.push(event) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const base = `http://127.0.0.1:${address.port}`;
  return { store, logs, base, request: (path: string, body?: unknown, method = body ? 'POST' : 'GET') => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); } };
}

test('API rejects unauthorized requests, validates input, and emits no document/token logs', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base + '/health')).status, 200);
    assert.equal((await fetch(f.base + '/v1/documents')).status, 401);
    assert.equal((await f.request('/v1/documents', { name: '../escape.md', content: 'secret' })).status, 400);
    assert.equal((await f.request('/v1/documents', { name: 'ok.md', content: 'x'.repeat(MAX_DOCUMENT_BYTES + 1) })).status, 413);
    assert.equal((await f.request('/v1/search', { query: 'and the' })).status, 400);
    assert.equal((await f.request('/v1/search', { query: 'backup retention', topK: 100 })).status, 400);
    const posted = await f.request('/v1/documents', { name: 'policy.md', content: 'Private backup retention is thirty days.' });
    assert.equal(posted.status, 201); const doc = await posted.json();
    assert.equal((await f.request(`/v1/documents/${doc.id}`)).status, 200);
    const update = await f.request(`/v1/documents/${doc.id}`, { name: 'policy.md', content: 'Private backup retention is sixty days.', expectedRevision: 1 }, 'PUT');
    assert.equal(update.status, 200);
    assert.equal((await f.request(`/v1/documents/${doc.id}`, { name: 'policy.md', content: 'stale text', expectedRevision: 1 }, 'PUT')).status, 409);
    const response = await f.request('/v1/answers', { question: 'backup retention' });
    assert.equal(response.status, 200); const result = await response.json();
    assert.match(result.answer, /sixty/); assert.equal(result.citations[0].revision, 2);
    assert.equal((await f.request('/v1/sources/' + result.citations[0].id)).status, 200);
    assert.ok(!JSON.stringify(f.logs).includes(token)); assert.ok(!JSON.stringify(f.logs).includes('Private backup'));
    assert.equal((await f.request(`/v1/documents/${doc.id}`, undefined, 'DELETE')).status, 204);
    assert.equal((await f.request(`/v1/documents/${doc.id}`)).status, 404);
  } finally { await f.close(); }
});

test('SSE returns parseable evidence and the same final answer contract', async () => {
  const f = await fixture();
  try {
    await f.request('/v1/documents', { name: 'policy.md', content: 'Backup retention is thirty days.' });
    const response = await f.request('/v1/answers/stream', { question: 'backup retention' });
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const events = (await response.text()).trim().split('\n\n').map(block => ({ event: block.split('\n')[0].slice(7), data: JSON.parse(block.split('\n')[1].slice(6)) }));
    assert.deepEqual(events.map(event => event.event), ['metadata', 'citation', 'answer', 'done']);
    assert.equal(events[2].data.citations[0].id, events[1].data.id);
  } finally { await f.close(); }
});

test('rate limits authenticated workload and rejects malformed JSON and media types', async () => {
  const f = await fixture({ requestsPerMinute: 3 });
  try {
    assert.equal((await fetch(f.base + '/v1/documents', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(f.base + '/v1/documents', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await f.request('/v1/documents')).status, 200);
    const limited = await f.request('/v1/documents'); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  } finally { await f.close(); }
});

test('service fails closed without a non-example API token', () => {
  const store = new Store();
  try { assert.throws(() => createApp({ store, token: '' })); assert.throws(() => createApp({ store, token: 'replace-with-at-least-24-random-characters' })); }
  finally { store.close(); }
});
