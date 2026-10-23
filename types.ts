export type DocumentRecord = { id: string; name: string; revision: number; sha256: string; createdAt: string; updatedAt: string };
export type Source = { id: string; documentId: string; name: string; revision: number; sha256: string; startLine: number; endLine: number; text: string };
export type SearchHit = Source & { score: number; matchedTerms: string[] };
export type Citation = Source & { label: string };
export type Answer = {
  status: 'answered' | 'insufficient_evidence';
  mode: 'extractive' | 'ollama';
  answer: string;
  citations: Citation[];
  retrieval: { matchedChunks: number; topScore: number; queryTerms: string[] };
  warning: string;
};
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
