# ADR 0008: Retrieval without paid embeddings

- Status: Accepted
- Date: 2026-11-24

## Context

Build-an-Agent turns a company's public site into a cited assistant. The spec asks for pgvector, hybrid search and reranking. Under ADR 0003 the default path is keyless and $0, and no keyless provider offers an embedding API. The owner has an NVIDIA API catalog key (evaluation-only terms, owner runs only). The schema already has `chunks.embedding vector(1024)` with an HNSW index and a generated `tsv` with a GIN index.

Probe on 2026-11-24 (owner key): the catalog lists 7 embedding models. Only `nvidia/nemotron-3.5-embed-1b` (native 2048) and `nvidia/nemotron-3.5-embed-8b` (native 4096) answered; `embed-qa-4`, `llama-3.2-nv-embedqa-1b-v1`, `llama-3.2-nemoretriever-1b-vlm-embed-v1`, `nv-embedqa-mistral-7b-v2` and `snowflake/arctic-embed-l` returned 404. `nemotron-3.5-embed-1b` honours `dimensions: 1024` (Matryoshka), returns exactly 1024 floats, accepts batches of 32 and answers in about 0.3 s. A relevant query/passage pair scored cosine 0.55 against 0.01 for an unrelated one.

## Decision

1. **Full-text always.** Every chunk is searchable through Postgres full-text search: the generated `tsvector`, an OR query over the question's terms (`to_tsquery('english', 'a | b | ...')`, sanitised in code) and `ts_rank_cd` ranking. This is the whole retrieval path on the keyless chain.
2. **Vectors when a provider is configured.** `config/models.json` gains an `embeddings` section (`dimensions` plus an ordered `chain` of `{provider, model, dimensions, maxBatch, quirks}`); the schema rejects entries whose dimensions differ from the store's. `EmbeddingProvider` is an interface with one OpenAI-compatible adapter (`/embeddings`, quirks `input-type`, `dimensions-param`, `truncate-end`). The owner chain uses `nvidia/nemotron-3.5-embed-1b` at 1024 dimensions; NVIDIA's evaluation-only terms keep it out of the public demo, which therefore runs full-text only and says so (`retrieval.mode` on the assistant). Responses are validated (count and dimensions) and failures fall back to full-text for the rest of the run. `pnpm smoke` probes each embedding entry.
3. **Reciprocal rank fusion** (k = 60) merges the two ranked lists (20 each) into the top 10 candidates; it needs no score calibration between `ts_rank_cd` and cosine.
4. **LLM rerank with the fast role** scores the candidates 0–3 in one tool-less call (`retrieval.rerank.v1`); candidates below 1 are dropped and the top 5 are used. If the reranker fails or returns nothing usable, the fused order is kept.
5. **Quarantine for RAG.** Page text never reaches a model that has tools. Chunks matching the injection heuristic (`detectInjection`) are stored with `flagged = true`, excluded by the store's queries and filtered again in code, and reported as `critic.flagged` (`injection_suspected`). Every model that reads chunks (rerank, answer, designer, eval generator, grader, contradiction check) is tool-less, gets chunks wrapped as untrusted data, and returns output that code validates: citations must point at retrieved passages, eval and contradiction quotes must appear verbatim in their chunk. The assistant's grounding and injection rules are a fixed platform prompt (`assistant.answer.v1`) placed before the designer-written persona; the designer cannot change them.
6. **Refusal is a code path.** No retrieved chunk means a refusal without a model call; the answer model's `NOT_IN_SOURCES` sentinel becomes a refusal (never streamed); an answer with no valid citation is reported as `ungrounded`.

## Consequences

- Keyless assistants miss paraphrased questions that share no words with the site; the eval set and gaps report make this visible per assistant. Reranking recovers precision but not recall.
- One extra fast-model call per question (rerank). On throttled keyless providers that roughly doubles latency; `retrieval.rerank` can be turned off per assistant.
- Switching embedding models later requires re-embedding a collection (dimensions are fixed at 1024 by the column type).
- A heuristic flag can hide legitimate text that discusses prompt injection; flagged chunks are counted and listed so a reviewer can see what was excluded.
