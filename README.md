# EvidenceDesk

**A small, auditable document Q&A backend. Every returned excerpt points to an immutable document revision and exact line range.**

Built with TypeScript, Node 24, native SQLite, BM25 retrieval, and an optional Ollama evidence selector. The default works offline and does **not** pretend to be an LLM: it returns relevant source excerpts verbatim. This is a working portfolio MVP, not a production knowledge platform.

## Try it in one minute

Install Node **24.12+ (24.x)**. Runtime dependencies: **none**.

```bash
npm test
npm run evaluate
npm run demo
```

The demo starts an ephemeral HTTP server, imports three fictional handbooks through the API, asks about webhook delivery, prints line citations, demonstrates a no-evidence refusal, and shuts down. It does not contact a model or external service. No account, payment, API key, or Docker is needed.

For static type checking, install the pinned development dependencies with `npm ci`, then run `npm run typecheck`. Node strips TypeScript syntax when running the app; it does not type-check it.

## Run a persistent workspace

1. Copy `.env.example` to `.env`.
2. Replace `EVIDENCE_API_TOKEN` with a generated token of at least 24 characters:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

The server binds to `127.0.0.1:8787` and stores the corpus in `var/evidence.sqlite`. Keep `.env` out of source control. In PowerShell use `$env:EVIDENCE_API_TOKEN` rather than Bash `$EVIDENCE_API_TOKEN` when making shell requests.

Example requests (Bash, after exporting your token):

```bash
curl -s http://127.0.0.1:8787/v1/documents \
  -H "Authorization: Bearer $EVIDENCE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"policy.md","content":"Backup archives are retained for thirty days.\nWebhook attempts are limited to five."}'

curl -s http://127.0.0.1:8787/v1/answers \
  -H "Authorization: Bearer $EVIDENCE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"question":"How long are backup archives retained?","topK":3}'
```

An answer has this shape (identifiers abbreviated here):

```json
{
  "status": "answered",
  "mode": "extractive",
  "answer": "[S1] Backup archives are retained for thirty days.",
  "citations": [{
    "id": "source-id", "documentId": "document-id", "name": "policy.md",
    "revision": 1, "sha256": "content-hash", "startLine": 1, "endLine": 1,
    "text": "Backup archives are retained for thirty days.", "label": "S1"
  }],
  "retrieval": {"matchedChunks": 1, "topScore": 1.4, "queryTerms": ["backup", "archive", "retain"]},
  "warning": "Offline extractive evidence, not an LLM-generated answer..."
}
```

## What is implemented

- Authenticated REST API for plain text and Markdown ingestion, listing, reading, updating, deleting, searching, and answering.
- Persistent SQLite transactions, optimistic concurrency on updates, and up to 20 retained revisions per document. Search uses the current revision; previous citation IDs still resolve until the document is deleted.
- Whole-line chunks of up to six lines / 8,000 characters, with one-line overlap when possible; normalized line endings; document SHA-256 and revision-specific source IDs.
- BM25 with Unicode tokenization, English stop words and small English suffix folding. No vector service or proprietary embedding API.
- Exact excerpts with file name, line numbers, revision, and source endpoint. If no chunk passes the lexical gate, returns `insufficient_evidence`.
- Optional Ollama selection of existing excerpts. Model-generated prose is never used as an answer, and unknown source indices are rejected.
- SSE event contract (`metadata`, `citation`, `answer`, `done`). This streams structured results **after** answer computation; it is not live token generation.
- 128 KiB document / 160 KiB request limits; at most 1,000 lines, 8,000 characters per line, and 400 chunks per document. At most 200 documents, 120 authenticated requests/minute, four concurrent answer requests, timing-safe token comparison, provider timeouts and response limits.
- Request ID/status/latency logs that omit document bodies, queries, tokens, and model payloads.

## API

All routes except `/health` require `Authorization: Bearer <token>`. Bodies use `application/json`.

| Method | Path | Body / result |
|---|---|---|
| GET | `/health` | Readiness of HTTP process, no corpus details |
| POST | `/v1/documents` | `{name, content}` → metadata (201) |
| GET | `/v1/documents` | Current document metadata |
| GET | `/v1/documents/:id` | Current content and metadata |
| PUT | `/v1/documents/:id` | `{name, content, expectedRevision}`; stale edit → 409 |
| DELETE | `/v1/documents/:id` | Deletes document, revisions, and citations (204) |
| GET | `/v1/sources/:sourceId` | Exact original excerpt, including older revisions |
| POST | `/v1/search` | `{query, topK?}` → ranked chunks |
| POST | `/v1/answers` | `{question, topK?, mode?}` → cited excerpts |
| POST | `/v1/answers/stream` | Same request → SSE events |

`topK`: 1–5 (default 3). `mode`: `extractive` (default) or `ollama`. Search/question text: 2–500 characters. Errors use `{error:{code,message,requestId}}`. No CORS access is enabled; this API is designed for a trusted server-side client or local tooling.

## Optional local Ollama

Install Ollama and a model separately using its official documentation. Set `OLLAMA_URL` and `OLLAMA_MODEL` in `.env`, restart, then pass `"mode":"ollama"`.

The server sends the question and up to five retrieved excerpts to the configured model endpoint. The system prompt identifies these as untrusted data. The model may only select indices; the server validates them and constructs the answer from stored text. Documents cannot make the server execute commands, fetch URLs, or reveal the API token because the model has no tools and is never given that token.

This reduces the output surface; it **does not guarantee** correct relevance or protection from misleading source documents. Malicious instructions may appear in returned excerpts as inert quoted data. Treat them as document content. The adapter is tested using a fake HTTP provider; a real-model quality evaluation is a separate next step.

## Evaluation and tests

`npm test` exercises authenticated HTTP ingestion, validation, updates and conflicts, exact citation lines, persistence across SQLite restart, deletion, SSE framing, rate limiting, no-evidence refusal, malformed model output, and hostile document text.

`npm run evaluate` runs the checked-in `data/evaluation.json` against the fictional corpus. The initial local result is **Recall@3 = 1.00, MRR@3 = 1.00, no-evidence accuracy = 1.00**, with 10 answerable and 2 unrelated queries. These are tiny **development-set regression metrics**, not evidence of general accuracy. The tokenizer was improved after this set exposed plural/suffix misses; the set is not held out. CI gates: Recall@3 ≥ 0.90, MRR@3 ≥ 0.75, and both unrelated questions refused.

## Design decisions and limits

Read [ARCHITECTURE.md](ARCHITECTURE.md) for schema, data flow, trade-offs, and interview discussion points.

- Single shared workspace and token. No per-user authorization, multi-tenancy, encryption at rest, or secrets manager.
- Small corpora only. SQLite operations and lexical indexing are synchronous and run on the event loop. Search rebuilds in-memory token statistics per request; do not expose it to untrusted public traffic.
- Lexical matches are not semantic entailment. A related-but-unanswerable question can return a passage; negation, numerical reasoning, multilingual stemming, and synonyms are not reliably handled. Refusal means no sufficient **lexical** evidence, not a proof that an answer does not exist.
- Plain text/Markdown only. No PDF/OCR, web crawler, remote URL ingestion, or executable document formats.
- Excerpts may overlap or contain surrounding lines. This improves auditability but can add noise.
- Ollama mode selects excerpts; it does not produce fluent summaries. It may select the wrong excerpt, and model/context choices have not been benchmarked.
- Fixed-window, process-local rate limiting is a demo safeguard, not distributed abuse protection. Place behind TLS and proper access controls before any deployment.
- Docker and CI files are included; Docker image execution and hosted CI have not been verified in this environment.

## Suggested next milestones

1. Collect 50–100 real, permission-cleared question/source pairs and create a held-out evaluation set with hard negatives.
2. Add a hybrid retrieval experiment (BM25 + embeddings), compare against this baseline, and measure latency and retrieval quality.
3. Add workspace-scoped users and authorization tests before multi-tenant deployment.
4. Add a source viewer UI that highlights the exact cited lines and distinguishes evidence from generated commentary.

## Technical references

- [Node native TypeScript execution](https://nodejs.org/learn/typescript/run-natively)
- [Node SQLite API](https://nodejs.org/api/sqlite.html)
- [Ollama API](https://docs.ollama.com/api/chat)
- [Ollama structured outputs](https://ollama.com/blog/structured-outputs)

This repository is an AI-assisted learning/portfolio implementation. Be prepared to explain and modify it yourself before presenting it in an interview. Do not claim commercial use, large-scale traffic, or production deployments that have not occurred.
