# dsh-evidence-agent

A source-backed RAG plugin for DeepSeek Harness. It builds a searchable index
from local Markdown technical documentation, uses runtime tools to gather
evidence, and refuses to answer when the corpus does not support a claim.

[中文](README.md) | English

## Features

- Heading-aware Markdown chunking with stable document IDs and real line ranges.
- BGE-M3 dense retrieval, BM25 lexical retrieval, and Reciprocal Rank Fusion.
- `kb_search`, `kb_read`, and `kb_list_sources` tools for DSH agents.
- Direct, multi-hop, query-rewrite, and adjacent-context retrieval flows.
- A hard limit of four evidence-tool calls per user turn.
- `[doc_id#Lstart-Lend]` citations and explicit abstention without evidence.
- A 60-question benchmark covering No RAG, Dense, Hybrid, and Agentic answers.

## Architecture

```text
Markdown sources
  -> manifest and SHA-256
  -> heading-aware chunks
  -> BGE-M3 vectors + BM25 index
  -> DSH evidence tools
  -> evidence sufficiency check
  -> cited answer or explicit refusal
```

See [docs/architecture.md](docs/architecture.md) for component details.

## Quick Start

Node.js 18 or newer is required. The active DSH profile also needs compatible
`@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` bundles.

```powershell
git clone https://github.com/GRS-YK/dsh-evidence-agent.git
cd dsh-evidence-agent
dsh plugin --profile web add .
```

Create `.env` from `.env.example` and set the embedding service credentials.
Never commit this file.

```powershell
npm.cmd run embeddings:build
npm.cmd run bm25:build
npm.cmd run embeddings:check
npm.cmd run bm25:check
dsh web
```

Example questions and expected behavior are in
[docs/examples.md](docs/examples.md).

## Evaluation

The benchmark contains 35 single-hop, 15 multi-hop, and 10 unanswerable
questions. Retrieval results:

| Strategy | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: |
| Hybrid + raw question | 0.9100 | 0.9400 | 0.7290 |
| BM25 | 0.9100 | 1.0000 | 0.9367 |
| Dense | 0.8900 | 0.9800 | 0.9207 |
| Hybrid + retrieval query | 0.9300 | 1.0000 | 0.9433 |
| Multi-query Hybrid | 0.9400 | 0.9800 | 0.9307 |

End-to-end answer results:

| Strategy | Accuracy | Faithfulness | Refusal | False refusal | P95 latency | Avg tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No RAG | 0.6800 | N/A | 1.0000 | 0.2400 | 14.334 s | 1176.45 |
| Dense | 0.8800 | 0.9800 | 1.0000 | 0.1000 | 5.674 s | 2309.70 |
| Hybrid | 0.9200 | 0.9800 | 1.0000 | 0.1000 | 5.573 s | 2413.23 |
| Agentic | 0.9800 | 0.9800 | 1.0000 | 0.0000 | 18.289 s | 8559.27 |

Agentic answers averaged 2.15 evidence calls and never exceeded the four-call
limit. Compared with one-shot Hybrid, they used about 3.5 times as many tokens
and 3.2 times the average latency.

Correctness and faithfulness are automatic DeepSeek Flash labels from one run,
not human-adjudicated labels. The eight-document corpus is useful for testing
the implementation but is too small for production-scale claims.

Run the offline lexical benchmark:

```powershell
npm.cmd run eval:retrieval:lexical
```

The full retrieval suite requires an embedding configuration and current vector
index:

```powershell
npm.cmd run eval:retrieval
```

See [docs/benchmark.md](docs/benchmark.md),
[docs/evaluation.md](docs/evaluation.md), and
[docs/answer-evaluation.md](docs/answer-evaluation.md).

## Tests

```powershell
npm.cmd test
npm.cmd run test:coverage
```

CI runs the suite on Node.js 18, 20, 22, and 24.

## Limitations

- The corpus is small and dense search uses an exact cosine scan over JSONL.
- No reranker is implemented.
- Most answer-quality labels require human spot checks.
- Agentic retrieval costs substantially more than one-shot Hybrid.
- Prompt-injection defenses have not yet been tested with a broad adversarial set.

## License

The project is released under the MIT License. See [LICENSE](LICENSE).
