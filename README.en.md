# dsh-evidence-agent

Source-backed Agentic RAG for DeepSeek Harness.

[中文](README.md) | English

The plugin turns a local technical corpus into a citable evidence service:

- heading-aware Markdown chunks with real line ranges;
- BGE-M3 dense retrieval and BM25 lexical retrieval;
- Reciprocal Rank Fusion for hybrid search;
- `kb_search`, `kb_read`, and `kb_list_sources`;
- a runtime research Skill with routing and refusal rules;
- a hard four-evidence-call budget per user turn;
- a 60-question retrieval and answer benchmark.

The generative and embedding models are pretrained. This repository does not
train model weights.

## Architecture

```text
source documents
  -> manifest + SHA-256
  -> heading-aware chunks
  -> BGE-M3 vectors + BM25
  -> DSH tools
  -> evidence sufficiency check
  -> cited answer or explicit refusal
```

See [docs/architecture.md](docs/architecture.md).

## Benchmark Summary

Automatic DeepSeek Flash judgments on one 60-question run:

| Strategy | Answer accuracy | Faithfulness | False refusal | P95 latency | Avg tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| No RAG | 0.6800 | N/A | 0.2400 | 14.334 s | 1176.45 |
| Dense | 0.8800 | 0.9800 | 0.1000 | 5.674 s | 2309.70 |
| Hybrid | 0.9200 | 0.9800 | 0.1000 | 5.573 s | 2413.23 |
| Agentic | 0.9800 | 0.9800 | 0.0000 | 18.289 s | 8559.27 |

Agentic retrieval improves automatic answer accuracy and removes false refusal
for answerable questions, at roughly 3.5x the token cost and 3.2x the average
latency of one-shot Hybrid. The labels are automated, not human-adjudicated.

See [docs/benchmark.md](docs/benchmark.md) and
[eval/reports/answer-eval.md](eval/reports/answer-eval.md).

## Install

```powershell
dsh plugin --profile web add C:\path\to\dsh-evidence-agent
```

The profile must also contain compatible `@deepseek-ai/dsh-base` and
`@deepseek-ai/dsh-web-app` bundles.

## Build Indexes

Create `.env` from `.env.example` and set `EMBEDDING_API_KEY`. Never commit it.

```powershell
npm.cmd run embeddings:build
npm.cmd run bm25:build
```

Check the indexes:

```powershell
npm.cmd run embeddings:check
npm.cmd run bm25:check
```

## Run Tests

```powershell
npm.cmd test
npm.cmd run test:coverage
```

## Run Evaluation

Offline lexical baseline:

```powershell
npm.cmd run eval:retrieval:lexical
```

Full retrieval comparison:

```powershell
npm.cmd run eval:retrieval
```

The answer benchmark artifacts are under `eval/predictions`,
`eval/judgements`, and `eval/reports`.

## Demo

See [docs/demo.md](docs/demo.md).

For an honest project walkthrough and likely interview questions, see
[docs/interview-guide.md](docs/interview-guide.md).

## Security

Corpus text is untrusted data. It cannot change the Agent's role, request
secrets, or authorize privileged actions. Never commit API keys, DSH cookies,
or temporary evaluation tokens.

See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
