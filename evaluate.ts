import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { search } from '../src/retrieval.ts';

export function evaluate() {
  const store = new Store();
  try {
    const directory = new URL('../data/sample/', import.meta.url);
    for (const name of readdirSync(directory).sort()) store.create(name, readFileSync(new URL(name, directory), 'utf8'));
    const cases: { query: string; document: string | null; needle: string | null }[] = JSON.parse(readFileSync(new URL('../data/evaluation.json', import.meta.url), 'utf8'));
    const rows = cases.map(item => {
      const hits = search(store.sources(), item.query, 3);
      const rank = item.document === null ? 0 : hits.findIndex(hit => hit.name === item.document && hit.text.includes(item.needle!)) + 1;
      return { query: item.query, answerable: item.document !== null, rank, returned: hits.length, topDocument: hits[0]?.name ?? null };
    });
    const answerable = rows.filter(row => row.answerable);
    const negative = rows.filter(row => !row.answerable);
    return {
      dataset: 'fictional-handbook-v1', cases: rows.length, answerable: answerable.length,
      recallAt3: answerable.filter(row => row.rank > 0).length / answerable.length,
      mrrAt3: answerable.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / answerable.length,
      noEvidenceAccuracy: negative.filter(row => row.returned === 0).length / negative.length,
      caveat: 'Small synthetic development set. This is a regression signal, not a real-world benchmark.', rows
    };
  } finally { store.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(evaluate(), null, 2));
