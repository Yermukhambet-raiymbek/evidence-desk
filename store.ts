import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DocumentRecord, Source } from './types.ts';
import { HttpError } from './types.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const MAX_DOCUMENT_BYTES = 128 * 1024;
export const MAX_DOCUMENTS = 200;
export const MAX_REVISIONS = 20;
export const MAX_DOCUMENT_LINES = 1000;
export const MAX_CHUNK_CHARACTERS = 8000;
export const MAX_DOCUMENT_CHUNKS = 400;
export function validateDocument(name: unknown, content: unknown): { name: string; content: string } {
  if (typeof name !== 'string' || name.length > 120 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*\.(txt|md)$/iu.test(name) || name.includes('..'))
    throw new HttpError(400, 'invalid_name', 'Use a plain .txt or .md filename, at most 120 characters.');
  if (typeof content !== 'string' || !content.trim() || content.includes('\0'))
    throw new HttpError(400, 'invalid_content', 'Content must be non-empty text without NUL characters.');
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'document_too_large', 'Document exceeds 128 KiB.');
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > MAX_DOCUMENT_LINES) throw new HttpError(413, 'too_many_lines', 'Document exceeds 1,000 lines.');
  if (lines.some(line => line.length > MAX_CHUNK_CHARACTERS)) throw new HttpError(413, 'line_too_long', 'A line exceeds 8,000 characters; wrap long lines before uploading.');
  return { name, content: normalized };
}

export class Store {
  db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, revision INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(document_id, revision));
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL, FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS chunks_revision ON chunks(document_id, revision);`);
  }
  close() { this.db.close(); }
  list(): DocumentRecord[] {
    return this.db.prepare(`SELECT d.id,r.name,d.current_revision AS revision,r.sha256,d.created_at AS createdAt,d.updated_at AS updatedAt
      FROM documents d JOIN revisions r ON r.document_id=d.id AND r.revision=d.current_revision ORDER BY d.created_at,d.id`).all() as DocumentRecord[];
  }
  get(id: string): DocumentRecord & { content: string } {
    const row = this.db.prepare(`SELECT d.id,r.name,d.current_revision AS revision,r.sha256,r.content,d.created_at AS createdAt,d.updated_at AS updatedAt FROM documents d
      JOIN revisions r ON r.document_id=d.id AND r.revision=d.current_revision WHERE d.id=?`).get(id);
    if (!row) throw new HttpError(404, 'not_found', 'Document not found.');
    return row as DocumentRecord & { content: string };
  }
  create(name: unknown, content: unknown): DocumentRecord {
    const value = validateDocument(name, content);
    if (this.list().length >= MAX_DOCUMENTS) throw new HttpError(409, 'corpus_full', 'This demo supports at most 200 documents.');
    const id = randomUUID(); const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('INSERT INTO documents VALUES (?,1,?,?)').run(id, now, now);
      this.writeRevision(id, 1, value.name, value.content);
    });
    const { content: _, ...metadata } = this.get(id); return metadata;
  }
  update(id: string, name: unknown, content: unknown, expectedRevision: unknown): DocumentRecord {
    const value = validateDocument(name, content);
    if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1) throw new HttpError(400, 'invalid_revision', 'expectedRevision must be a positive integer.');
    this.transaction(() => {
      const old = this.get(id);
      if (old.revision !== expectedRevision) throw new HttpError(409, 'revision_conflict', 'The document changed; reload it before editing.');
      if (old.revision >= MAX_REVISIONS) throw new HttpError(409, 'revision_limit', 'This demo retains at most 20 revisions per document.');
      this.writeRevision(id, old.revision + 1, value.name, value.content);
      this.db.prepare('UPDATE documents SET current_revision=?,updated_at=? WHERE id=?').run(old.revision + 1, new Date().toISOString(), id);
    });
    const { content: _, ...metadata } = this.get(id); return metadata;
  }
  remove(id: string) {
    this.get(id); this.db.prepare('DELETE FROM documents WHERE id=?').run(id);
  }
  sources(): Source[] {
    return this.db.prepare(`SELECT c.id,c.document_id AS documentId,r.name,c.revision,r.sha256,c.start_line AS startLine,c.end_line AS endLine,c.text
      FROM chunks c JOIN documents d ON d.id=c.document_id AND d.current_revision=c.revision
      JOIN revisions r ON r.document_id=c.document_id AND r.revision=c.revision ORDER BY c.id`).all() as Source[];
  }
  source(id: string): Source {
    const row = this.db.prepare(`SELECT c.id,c.document_id AS documentId,r.name,c.revision,r.sha256,c.start_line AS startLine,c.end_line AS endLine,c.text
      FROM chunks c JOIN revisions r ON r.document_id=c.document_id AND r.revision=c.revision WHERE c.id=?`).get(id);
    if (!row) throw new HttpError(404, 'not_found', 'Source not found.');
    return row as Source;
  }
  private transaction(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private writeRevision(id: string, revision: number, name: string, content: string) {
    const sha = hash(content);
    this.db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(id, revision, name, content, sha);
    const lines = content.split('\n');
    // Whole-line windows: at most six lines / 8,000 characters. Overlap one line when progress permits.
    let chunks = 0;
    for (let start = 0; start < lines.length;) {
      let end = start; let length = 0;
      while (end < lines.length && end - start < 6) {
        const added = lines[end].length + (end > start ? 1 : 0);
        if (length + added > MAX_CHUNK_CHARACTERS) break;
        length += added; end++;
      }
      const text = lines.slice(start, end).join('\n');
      if (text.trim()) {
        if (++chunks > MAX_DOCUMENT_CHUNKS) throw new HttpError(413, 'too_many_chunks', 'Document exceeds 400 indexed chunks.');
        this.db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?)').run(hash(`${id}:${revision}:${start + 1}:${end}:${sha}`).slice(0, 32), id, revision, start + 1, end, text);
      }
      if (end === lines.length) break;
      start = end - start > 1 ? end - 1 : end;
    }
  }
}
