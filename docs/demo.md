# Two-Minute Demo

## Prepare

Start DeepSeek Harness and select the `dsh-evidence-agent` workspace:

```powershell
dsh web
```

Open the printed localhost URL. The project profile must already include the
plugin bundle.

## Demo Sequence

### 1. Show Scope Control

Ask:

```text
你好
```

Expected behavior: the Agent replies without calling any knowledge-base tool.

### 2. Show One-Shot Hybrid RAG

Ask:

```text
RRF 如何计算融合分数？请依据知识库回答并给引用。
```

Expected behavior: `kb_search` retrieves evidence, `kb_read` may load adjacent
context, and the answer cites real document line ranges.

### 3. Show Multi-Hop Research

Ask:

```text
比较 BM25 和 RRF：它们各自解决什么问题、如何配合？请依据知识库回答。
```

Expected behavior: the Agent combines lexical retrieval and rank-fusion
evidence, staying within the four-call budget.

### 4. Show Refusal

Ask:

```text
知识库有没有这个项目的商业收入或客户数据？
```

Expected behavior: the Agent states that the current knowledge base cannot
confirm the requested business data. It must not invent numbers.

### 5. Show Evidence

Open the **轨迹** tab and point out:

- Skill loading;
- `kb_search` and optional `kb_read`;
- `budget_remaining`;
- final citations.

### 6. Show Evaluation

Open:

```text
eval/reports/retrieval-baseline.md
eval/reports/answer-eval.md
```

Explain both the improvement and the cost, rather than presenting Agentic RAG
as universally better.
