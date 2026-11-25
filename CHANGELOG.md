# Changelog

## 0.1.0 - 2026-11-25

### Added

- DeepSeek Harness bundle and runtime Skill.
- Structure-aware Markdown ingestion and manifest integrity checks.
- BGE-M3 dense index with incremental reuse.
- BM25 lexical index for English and Chinese character n-grams.
- Hybrid retrieval with RRF.
- `kb_search`, `kb_read`, and `kb_list_sources`.
- Citations with real document line ranges.
- Hard four-call evidence budget per user turn.
- 60-question retrieval and answer benchmark.
- No RAG, Dense, Hybrid, and Agentic evaluation runs.
- Automated answer, citation, refusal, faithfulness, latency, and token reports.

### Known Limitations

- The corpus contains eight documents and 78 chunks.
- No reranker is implemented.
- JSONL vectors use exact cosine scans rather than ANN indexing.
- Correctness labels are automated and require human spot checks.
- No production Web demonstration video is checked in yet.
