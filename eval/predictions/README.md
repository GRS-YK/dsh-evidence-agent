# Answer Predictions

Place immutable model outputs in one JSONL file. Each line describes one answer
for one strategy and one question:

```json
{
  "id": "s01",
  "strategy": "hybrid",
  "answer": "The plugin exports an apply(ctx) function. [dsh-first-plugin#L15-L29]",
  "citations": [
    {
      "doc_id": "dsh-first-plugin",
      "line_start": 15,
      "line_end": 29
    }
  ],
  "abstained": false,
  "latency_ms": 1250,
  "tool_calls": 1,
  "input_tokens": 900,
  "output_tokens": 120
}
```

Allowed strategies:

- `no_rag`
- `dense`
- `hybrid`
- `agentic`

Predictions should cover the same 60 IDs as `eval/questions.jsonl`. Missing
answers are reported rather than silently skipped.

Example filenames:

```text
eval/predictions/hybrid-2026-11-25.jsonl
eval/predictions/agentic-2026-11-25.jsonl
```

The checked-in runs are:

```text
eval/predictions/no-rag-dsh-20261125.jsonl
eval/predictions/dense-dsh-20261125.jsonl
eval/predictions/hybrid-dsh-20261125.jsonl
eval/predictions/agentic-dsh-20261125.jsonl
```

No RAG, Dense, and Hybrid use DSH's `minimal` Agent preset. Dense and Hybrid
receive pre-retrieved evidence in the prompt, so generation makes zero evidence
tool calls. Agentic uses the `standard` preset and the actual
`dsh-evidence-agent_kb_*` tools.

Do not edit an answer after judging it. Save a new run file instead.
