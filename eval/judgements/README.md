# Answer Judgements

Correctness and faithfulness cannot be inferred reliably from citation overlap
alone. They require a human label or an explicit judge run.

Each JSONL record identifies one prediction:

```json
{
  "id": "s01",
  "strategy": "hybrid",
  "correct": true,
  "faithful": true
}
```

Recommended rubric:

- `correct`: the answer resolves the question and agrees with `reference_answer`.
- `faithful`: every material factual claim is supported by the cited evidence,
  with no unsupported additions.

For `unanswerable` questions, refusal accuracy is computed from the prediction's
`abstained` field. A separate correctness label may still be recorded for audit.

Judge only one immutable prediction file at a time. If the model is rerun,
create a new prediction and judgement pair.
