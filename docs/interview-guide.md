# Interview Guide

## Honest Project Framing

Use AI-assisted development as context, not as a reason to avoid explaining the
project:

> This is an AI-assisted engineering project. I defined the project stages,
> selected and checked the approach, ran the tests and DSH evaluations, reviewed
> failures, and used the results to revise the design. I can explain and modify
> the retrieval, tool, budget, citation, and evaluation paths. I do not claim
> that every line was typed manually.

## Three-Minute Walkthrough

1. **Problem:** technical answers need current evidence, citations, and explicit
   refusal rather than model-memory guesses.
2. **Data:** eight Markdown sources produce 78 heading-aware chunks with real
   line ranges.
3. **Retrieval:** BGE-M3 supplies dense candidates, BM25 supplies lexical
   candidates, and RRF fuses their ranks.
4. **Agent:** a runtime Skill routes direct, single-hop, and multi-hop questions,
   optionally reads neighbours, rewrites queries, and refuses unsupported facts.
5. **Engineering controls:** strict schemas, timeouts, cancellation, citation
   checks, prompt-injection boundaries, and a hard four-call evidence budget.
6. **Evaluation:** 60 questions compare No RAG, Dense, Hybrid, and Agentic
   answers using retrieval, citation, refusal, quality, latency, and token
   metrics.
7. **Trade-off:** Agentic produced the highest automatic answer accuracy but was
   much more expensive than one-shot Hybrid.

## Key Numbers

- Corpus: 8 documents, 78 chunks.
- Dense model: BGE-M3, 1024 dimensions.
- Hybrid retrieval: RRF with `k=60`, top five results.
- Evidence budget: four hard calls per user turn.
- Tests: 70 passing.
- Retrieval Hybrid: Recall@5 `0.9300`, MRR@5 `0.9433`.
- Automatic answer accuracy: No RAG `0.6800`, Dense `0.8800`, Hybrid `0.9200`,
  Agentic `0.9800`.
- Agentic cost: 2.15 average evidence calls, 8,559 average tokens, 18.289 s P95.

Always add that accuracy and faithfulness are automated LLM labels requiring
human adjudication.

## Likely Questions

### Why RAG instead of fine-tuning?

The corpus changes, answers require traceable lines, and unsupported questions
must be refused. Fine-tuning does not provide those properties automatically.

### Why BM25 and dense retrieval together?

BM25 handles exact names, IDs, and terminology. Dense retrieval handles
paraphrases and semantic similarity. Their failure modes differ.

### Why RRF?

BM25 and cosine scores are not directly comparable. RRF combines ranks without
assuming a common score scale.

### Why is multi-query retrieval not always better?

It improves recall but may add distractors and worsen ranking. The measured
retrieval run raised Recall@5 from `0.9300` to `0.9400` while lowering MRR@5
from `0.9433` to `0.9307`.

### Why use a hard budget?

An early version documented four calls but still executed eight because the
model searched before loading the Skill. The runtime counter turned a prompt
suggestion into an enforceable boundary.

### How do you know evidence is sufficient?

Each material claim must have direct evidence, comparisons need evidence on
both sides, citations must use returned line ranges, and contradictions or
missing context block the answer.

### How do you measure success?

The benchmark separates retrieval quality from answer quality. Retrieval uses
Recall@5, HitRate@5, and MRR@5. Answers use correctness, faithfulness, citation
precision/coverage, refusal, false refusal, latency, and tokens.

### What failed?

One-shot retrieval missed the second side of several multi-hop questions.
Agentic supplementation fixed those cases. Citation precision also dropped as
extra evidence was added. One question exposed a likely gold-label omission.

### What would you do next?

Audit the 50 answerable labels manually, add a second independent judge, expand
the corpus, add a reranker, investigate citation noise, and compute confidence
intervals over repeated runs.

## Do Not Claim

- Do not say the model was trained or fine-tuned.
- Do not call automated judge results human-verified.
- Do not claim Agentic RAG is universally better.
- Do not quote gains without the latency and token cost.
- Do not claim the eight-document benchmark is production-scale evidence.
