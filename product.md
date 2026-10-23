# Northstar demo product guide
This is fictional public demonstration data.
## Documents
Supported document formats are plain text and Markdown.
Each document is limited to 128 KiB.
PDF and spreadsheet parsing are not supported.

## Search
BM25 ranks passages using lexical token matches.
Semantic embeddings are not enabled in this demo.
Search queries can return up to five passages.
The offline answer mode returns exact source excerpts.

## Accounts
The demo uses a single shared workspace.
Separate user accounts and tenant isolation are not implemented.
The API authenticates requests using a bearer token.
