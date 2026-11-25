# Answer Evaluation

Retrieval evaluation answers one question: did the correct chunk appear in the
top results? Answer evaluation asks different questions:

- Did the final answer resolve the user's question?
- Was every material claim supported by the cited evidence?
- Did citations point to gold or merely plausible adjacent text?
- Did the agent abstain on unsupported questions?
- Did it incorrectly refuse answerable questions?
- What latency, tool calls, and token cost were required?

## Artifacts

Predictions use `eval/predictions/*.jsonl`. See
`eval/predictions/README.md` for the exact record shape.

Correctness and faithfulness labels use `eval/judgements/*.jsonl`. See
`eval/judgements/README.md` for the rubric.

## Run

```powershell
npm.cmd run eval:answers -- `
  --predictions eval/predictions/no-rag.jsonl,eval/predictions/dense.jsonl,eval/predictions/hybrid.jsonl,eval/predictions/agentic.jsonl `
  --judgements eval/judgements/no-rag.jsonl,eval/judgements/dense.jsonl,eval/judgements/hybrid.jsonl,eval/judgements/agentic.jsonl
```

The report is written to:

```text
eval/reports/answer-eval.md
eval/reports/answer-eval.json
```

## Metrics

`answer_accuracy` is the mean of `correct` labels over judged answerable
questions.

`faithfulness` is the mean of `faithful` labels over judged answerable
questions.

`citation_gold_accuracy` is the fraction of structured citations whose
`doc_id` and line range overlap a gold chunk for that question.

`citation_locator_validity` is looser: it only checks that the cited line range
exists in the named corpus document.

`citation_coverage` is the fraction of answerable predictions with at least one
gold-supported citation.

`refusal_accuracy` is the fraction of unanswerable predictions with
`abstained=true`.

`false_refusal_rate` is the fraction of answerable predictions marked as
abstained.

Average latency, tool calls, and tokens are reported when supplied by the
prediction producer.

## Current Four-Strategy Run

The checked-in runs contain 240 answers:

```text
eval/predictions/no-rag-dsh-20261125.jsonl
eval/predictions/dense-dsh-20261125.jsonl
eval/predictions/hybrid-dsh-20261125.jsonl
eval/predictions/agentic-dsh-20261125.jsonl
eval/judgements/no-rag-dsh-20261125.auto.jsonl
eval/judgements/dense-dsh-20261125.auto.jsonl
eval/judgements/hybrid-dsh-20261125.auto.jsonl
eval/judgements/agentic-dsh-20261125.auto.jsonl
eval/reports/answer-eval.md
```

No RAG receives no corpus evidence. Dense and Hybrid receive pre-retrieved
evidence and make zero evidence-tool calls during generation. Agentic loads the
runtime Skill and uses the actual evidence tools, capped at four calls by the
runtime budget.

| Metric | Value |
| --- | ---: |
| No RAG answer accuracy | 0.6800 |
| Dense answer accuracy | 0.8800 |
| Hybrid answer accuracy | 0.9200 |
| Agentic answer accuracy | 0.9800 |
| Dense / Hybrid / Agentic Faithfulness | 0.9800 each |
| Agentic refusal accuracy | 1.0000 |
| Agentic false-refusal rate | 0.0000 |
| Agentic average evidence calls | 2.15 |
| Agentic maximum evidence calls | 4 |
| Agentic average / P95 latency | 9630.40 / 18289 ms |
| Agentic average tokens | 8559.27 |

The 50 answerable questions received automated LLM correctness and faithfulness
labels. The 10 unanswerable questions are scored deterministically from their
explicit abstention marker. Automated labels require human spot-checking and are
not equivalent to a formal human adjudication set.

Agentic improves automatic answer accuracy by 30 percentage points over No RAG
and 6 points over one-shot Hybrid. It removes false refusal for answerable
questions, but uses about 3.5 times the average tokens and 3.2 times the average
latency of Hybrid.

The run exposed concrete issues:

- Dense and Hybrid each refused or partially refused five answerable questions.
- One-shot retrieval often covered only one side of a multi-hop question;
  Agentic supplementation resolved the observed multi-hop failures.
- `s31` emitted numeric evidence labels (`[1#L...]`) instead of real document
  IDs. The evaluator correctly recorded invalid citation locators.
- `s24` cited a directly relevant adjacent chunk that was not included in its
  gold chunk list, exposing a gold-label audit item.
- Citation coverage is high (`0.9600`) for Dense, Hybrid, and Agentic, but
  citation gold precision is lower because answers often add extra, non-gold
  citations. Agentic expands 252 citations and has the lowest precision
  (`0.4664`), trading evidence completeness for reference noise.

Do not report the automated LLM labels as human-verified correctness. They are
useful provisional measurements and should be audited before a public benchmark
claim.
