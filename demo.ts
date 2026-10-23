import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createApp } from '../src/app.ts';
import { Store } from '../src/store.ts';
const store = new Store();
const token = randomBytes(32).toString('hex');
const server = createApp({ store, token });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No listening address');
const base = `http://127.0.0.1:${address.port}`;
const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  const directory = new URL('../data/sample/', import.meta.url);
  for (const name of readdirSync(directory).sort()) {
    const response = await fetch(`${base}/v1/documents`, { method: 'POST', headers, body: JSON.stringify({ name, content: readFileSync(new URL(name, directory), 'utf8') }) });
    if (response.status !== 201) throw new Error(`Ingestion failed: ${await response.text()}`);
  }
  const question = 'How many webhook delivery attempts are allowed?';
  const response = await fetch(`${base}/v1/answers`, { method: 'POST', headers, body: JSON.stringify({ question }) });
  const result = await response.json();
  console.log(JSON.stringify({ question, ...result }, null, 2));
  const noEvidence = await fetch(`${base}/v1/answers`, { method: 'POST', headers, body: JSON.stringify({ question: 'Which dinosaur invented quantum ballet?' }) });
  console.log('\nNo-evidence example:', (await noEvidence.json()).status);
} finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
