# @asab/shared

Cross-workspace types and contracts shared by the API and ingestion worker.

Will hold: domain types/DTOs and the swappable AI provider interfaces
(`Embedder`, `Chat`, `Reranker` — issue #6). Currently a minimal placeholder
from the monorepo scaffold (issue #2).

```bash
npm run build -w @asab/shared      # compile to dist/
npm run typecheck -w @asab/shared
```
