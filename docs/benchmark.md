# Benchmark Summary

## Test Set

The checked-in benchmark contains 60 questions over the eight-document corpus:

| Type | Count |
| --- | ---: |
| Single-hop | 35 |
| Multi-hop | 15 |
| Unanswerable | 10 |

Every answerable question contains gold document and chunk IDs. Every
unanswerable question must lead to an explicit refusal rather than an invented
answer.

## Retrieval Results

| Strategy | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: |
| Hybrid + raw user question | 0.9100 | 0.9400 | 0.7290 |
| BM25 | 0.9100 | 1.0000 | 0.9367 |
| Dense | 0.8900 | 0.9800 | 0.9207 |
| Hybrid + retrieval query | 0.9300 | 1.0000 | 0.9433 |
| Multi-query Hybrid proxy | 0.9400 | 0.9800 | 0.9307 |

Query formulation improves Hybrid MRR from `0.7290` to `0.9433`, but multi-query
retrieval does not automatically improve ordering: Recall rises to `0.9400`
while MRR falls to `0.9307`.

## End-to-End Results

| Strategy | Answer accuracy | Faithfulness | Refusal | False refusal | P95 latency | Avg tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No RAG | 0.6800 | N/A | 1.0000 | 0.2400 | 14.334 s | 1176.45 |
| Dense | 0.8800 | 0.9800 | 1.0000 | 0.1000 | 5.674 s | 2309.70 |
| Hybrid | 0.9200 | 0.9800 | 1.0000 | 0.1000 | 5.573 s | 2413.23 |
| Agentic | 0.9800 | 0.9800 | 1.0000 | 0.0000 | 18.289 s | 8559.27 |

Agentic retrieval has the best automatic answer accuracy and eliminates false
refusal in this run. It averages `2.15` evidence-tool calls and stays within the
hard maximum of four. The improvement is expensive: compared with Hybrid,
Agentic uses about `3.5x` tokens and `3.2x` average latency.

Citation coverage is `0.9600` for Dense, Hybrid, and Agentic. Agentic emits many
additional citations, so citation-gold precision drops to `0.4664`; this is a
precision/coverage trade-off, not evidence that Agentic fabricated its answer.

## Failure Findings

- One-shot retrieval solved only one side of several multi-hop questions.
- Agentic supplementation fixed the observed multi-hop failures.
- `s24` exposes a likely gold-label omission: the answer cites a directly
  relevant adjacent chunk outside the current gold list.
- `s31` in the Hybrid run used numeric evidence labels as document IDs. The
  citation evaluator correctly rejected those locators.
- Models sometimes summarize corpus-wide facts during refusal without citing
  evidence, lowering faithfulness even when the refusal decision is correct.

## Interpretation Limits

- Correctness and faithfulness are automated DeepSeek Flash judgments, not
  human adjudication.
- The corpus is small: eight documents and 78 chunks.
- Search latency excludes embedding API time.
- Results are from one generation run; confidence intervals and significance
  tests have not been computed.

## Reproduce

```powershell
npm.cmd run eval:retrieval
```

Answer generation and judging require a running authenticated DSH server:

```powershell
$env:DSH_EVAL_TOKEN = "<temporary token>"
npm.cmd run eval:generate -- --workspace "<workspace-id>" --strategy agentic
npm.cmd run eval:judge -- --workspace "<workspace-id>" `
  --predictions eval/predictions/agentic-dsh-20261125.jsonl
```

Never commit the temporary token.
