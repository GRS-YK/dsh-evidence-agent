# Retrieval Evaluation

Generated: 2026-11-25T08:24:29.817Z

> This report evaluates retrieval only. Answer correctness, faithfulness, citation usefulness, and refusal quality are not measured here.
> `hybrid_raw_question` uses the user-facing question unchanged. The other strategies use the dataset retrieval queries, which approximate a rewrite step.
> `multi_query` uses the authored subqueries in the dataset and is an Agentic RAG retrieval proxy, not a live LLM planning run.
> `average_search_ms` measures retrieval work after query embeddings are prepared; it excludes embedding API latency.
> The unanswerable column is evidence-return rate, not refusal rate. A generator can still correctly abstain when candidates are returned.

## Overall

| Strategy | Recall@5 | HitRate@5 | MRR@5 | Unanswerable evidence returned | Avg search ms | Avg evidence calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No RAG | N/A | N/A | N/A | N/A | 0.00 | 0.00 |
| hybrid_raw_question | 0.9100 | 0.9400 | 0.7290 | 1.0000 | 0.6599 | 1.0000 |
| lexical | 0.9100 | 1.0000 | 0.9367 | 1.0000 | 0.0902 | 1.0000 |
| dense | 0.8900 | 0.9800 | 0.9207 | 1.0000 | 0.1187 | 1.0000 |
| hybrid | 0.9300 | 1.0000 | 0.9433 | 1.0000 | 0.2990 | 1.0000 |
| multi_query | 0.9400 | 0.9800 | 0.9307 | 1.0000 | 0.3959 | 1.2500 |

## By question type

### hybrid_raw_question

| Type | Count | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: | ---: |
| single_hop | 35 | 0.9429 | 0.9429 | 0.7057 |
| multi_hop | 15 | 0.8333 | 0.9333 | 0.7833 |
| unanswerable | 10 | N/A | N/A | N/A |

### lexical

| Type | Count | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: | ---: |
| single_hop | 35 | 1.0000 | 1.0000 | 0.9381 |
| multi_hop | 15 | 0.7000 | 1.0000 | 0.9333 |
| unanswerable | 10 | N/A | N/A | N/A |

### dense

| Type | Count | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: | ---: |
| single_hop | 35 | 0.9714 | 0.9714 | 0.9200 |
| multi_hop | 15 | 0.7000 | 1.0000 | 0.9222 |
| unanswerable | 10 | N/A | N/A | N/A |

### hybrid

| Type | Count | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: | ---: |
| single_hop | 35 | 1.0000 | 1.0000 | 0.9524 |
| multi_hop | 15 | 0.7667 | 1.0000 | 0.9222 |
| unanswerable | 10 | N/A | N/A | N/A |

### multi_query

| Type | Count | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: | ---: |
| single_hop | 35 | 1.0000 | 1.0000 | 0.9524 |
| multi_hop | 15 | 0.8000 | 0.9333 | 0.8800 |
| unanswerable | 10 | N/A | N/A | N/A |
