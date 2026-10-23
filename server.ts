import { Store } from './store.ts';
import { createApp } from './app.ts';
const token = process.env.EVIDENCE_API_TOKEN ?? '';
const store = new Store(process.env.DATABASE_PATH ?? './var/evidence.sqlite');
const server = createApp({ store, token,
  ollama: process.env.OLLAMA_MODEL ? { model: process.env.OLLAMA_MODEL, baseUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434' } : undefined,
  onLog: event => console.log(JSON.stringify(event))
});
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`EvidenceDesk listening on ${process.env.HOST ?? '127.0.0.1'}:${port}`));
const stop = () => server.close(() => { store.close(); process.exit(0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
