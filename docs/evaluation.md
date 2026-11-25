# Retrieval Evaluation

## Scope

This evaluation measures whether the correct evidence chunk appears in the
top five retrieval results. It does not measure whether a generated answer is
correct, faithful, or useful.

The checked-in question set contains 60 items:

| Type | Count | Purpose |
| --- | ---: | --- |
| `single_hop` | 35 | One focused fact, definition, or procedure |
| `multi_hop` | 15 | Two or more evidence chunks must be combined |
| `unanswerable` | 10 | The corpus should not support a factual answer |

Each row records:

```json
{
  "id": "m06",
  "type": "multi_hop",
  "question": "...",
  "retrieval_queries": ["...", "..."],
  "gold_doc_ids": ["..."],
  "gold_chunk_ids": ["...", "..."],
  "reference_answer": "..."
}
```

## Strategies

`hybrid_raw_question`

Uses the original user-facing question. This approximates a system with no
query rewrite.

`lexical`

Uses BM25 and the authored retrieval query.

`dense`

Uses BGE-M3 cosine similarity and the authored retrieval query.

`hybrid`

Fuses BM25 and dense rankings with RRF using `k=60`.

`multi_query`

Runs Hybrid for each authored subquery, then fuses the ranked lists with another
RRF layer. This is a deterministic retrieval proxy for Agentic RAG. It does not
include live model planning or adaptive stopping.

## Metrics

Recall@5 is the fraction of gold chunks found in the top five. Multi-hop
questions can have more than one gold chunk.

HitRate@5 is the fraction of answerable questions with at least one gold chunk
in the top five.

MRR@5 is the mean reciprocal rank of the first gold chunk. A correct chunk at
rank one scores `1`, rank two scores `1/2`, and so on.

The unanswerable evidence-return rate is diagnostic only. Retrieval commonly
returns a plausible but unsupported candidate even when the model should later
refuse. It is not a refusal metric.

## Results

The checked-in run used `top_k=5` and `candidate_k=20`.

| Strategy | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: |
| Hybrid + raw question | 0.9100 | 0.9400 | 0.7290 |
| BM25 | 0.9100 | 1.0000 | 0.9367 |
| Dense | 0.8900 | 0.9800 | 0.9207 |
| Hybrid + retrieval query | 0.9300 | 1.0000 | 0.9433 |
| Multi-query Hybrid | 0.9400 | 0.9800 | 0.9307 |

The most important result is not a single winner. Query formulation raises
Hybrid MRR from `0.7290` to `0.9433`. Multi-query retrieval raises Recall@5
from `0.9300` to `0.9400`, but lowers HitRate@5 and MRR@5. More retrieval does
not automatically produce a better ranking.

The multi-query proxy improved coverage for multi-hop questions such as cache
storage plus `DynamicCache`, fixed-size cache plus offloading, and lexical
search plus vector indexes. It also exposed regressions:

- `m08`: gold coverage fell from `0.5` to `0`.
- `m13`: gold coverage fell from `1.0` to `0.5`.

These cases should be investigated before claiming that multi-query Agentic
retrieval is universally better.

## Interpretation Limits

- Retrieval queries in the dataset approximate an ideal rewrite step and are
  not generated online by the model.
- The corpus has only eight documents and 78 chunks.
- The run measures search latency after query embeddings exist. Embedding API
  latency is excluded.
- The dataset has 60 questions, which is useful for development but too small
  for a strong statistical claim.
- No answer generator is part of this report.
- Answer correctness, Faithfulness, citation usefulness, refusal accuracy, and
  end-to-end latency remain pending.

## Reproduce

Offline BM25-only run:

```powershell
npm.cmd run eval:retrieval:lexical
```

Full retrieval comparison:

```powershell
npm.cmd run eval:retrieval
```

The full command needs a working `EMBEDDING_API_KEY` and a current vector index.
Reports are written to `eval/reports/`.
