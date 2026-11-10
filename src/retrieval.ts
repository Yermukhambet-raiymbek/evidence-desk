import type { Source, SearchHit } from './types.ts';

// Deliberately lexical: Unicode tokens plus small English suffix folding, not semantic embeddings.
const STOP = new Set('a an the is are was were be been being to of in on for with and or by from at as it this that what which how when where why who do does did can could would should tell me about please your you we our their they its i s'.split(' '));
function fold(token: string): string {
  if (!/^[a-z]+$/.test(token)) return token;
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) token = token.slice(0, -1);
  if (token.length > 5 && token.endsWith('ed')) token = token.slice(0, -2);
  return token;
}
export function tokenize(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 1 && !STOP.has(t)).map(fold);
}

/** Standard BM25 (k1=1.2, b=.75), plus a transparent minimum lexical evidence gate. */
export function search(sources: Source[], query: string, topK = 3): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !sources.length) return [];
  const docs = sources.map(source => {
    const tokens = tokenize(source.text);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { source, tokens, counts };
  });
  const averageLength = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length || 1;
  const dfs = new Map(terms.map(t => [t, docs.filter(d => d.counts.has(t)).length]));
  const minimumMatches = terms.length === 1 ? 1 : Math.min(2, terms.length);
  return docs.map(d => {
    const matchedTerms = terms.filter(t => d.counts.has(t));
    const score = terms.reduce((sum, term) => {
      const frequency = d.counts.get(term) ?? 0;
      if (!frequency) return sum;
      const df = dfs.get(term)!;
      const idf = Math.log(1 + (docs.length - df + .5) / (df + .5));
      return sum + idf * (frequency * 2.2) / (frequency + 1.2 * (1 - .75 + .75 * d.tokens.length / averageLength));
    }, 0);
    return { ...d.source, score: Number(score.toFixed(6)), matchedTerms };
  }).filter(d => d.matchedTerms.length >= minimumMatches && d.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topK);
}
