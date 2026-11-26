# dsh-evidence-agent

一个运行在 DeepSeek Harness 上的可引用 RAG 插件。它把本地 Markdown
技术文档构建成混合检索索引，通过运行时工具完成检索和上下文补读，并在
证据不足时拒答。

[English](README.en.md) | 中文

## 功能

- 按 Markdown 标题结构切块，保留文档 ID 和真实行号。
- 使用 BGE-M3 做语义检索，使用 BM25 做关键词检索，再通过 RRF 融合排名。
- 向 Agent 提供 `kb_search`、`kb_read` 和 `kb_list_sources` 三个工具。
- 支持单跳检索、多跳问题拆分、相邻片段读取和查询改写。
- 每个用户回合最多进行 4 次证据工具调用，限制在运行时执行。
- 回答引用 `[doc_id#Lstart-Lend]`，无证据时明确拒答。
- 提供 60 题检索与回答评测，包含 No RAG、Dense、Hybrid 和 Agentic 四组结果。

## 工作流程

```text
Markdown 文档
  -> 文档清单与 SHA-256
  -> 结构感知切块
  -> BGE-M3 向量索引 + BM25 索引
  -> DSH 检索工具
  -> 证据充分性检查
  -> 带引用回答或拒答
```

更完整的组件说明见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

要求 Node.js 18 或更高版本，并且当前 DSH profile 已包含配套的
`@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` bundle。

```powershell
git clone https://github.com/GRS-YK/dsh-evidence-agent.git
cd dsh-evidence-agent
dsh plugin --profile web add .
```

复制环境变量模板并填写 Embedding 服务配置：

```powershell
Copy-Item .env.example .env
notepad .env
```

构建索引：

```powershell
npm.cmd run embeddings:build
npm.cmd run bm25:build
```

检查索引是否与当前文档一致：

```powershell
npm.cmd run embeddings:check
npm.cmd run bm25:check
```

启动 DSH Web：

```powershell
dsh web
```

示例问题和预期行为见 [docs/examples.md](docs/examples.md)。

## 检索工具

| 工具 | 用途 |
| --- | --- |
| `dsh-evidence-agent_kb_search` | 执行 Hybrid、Dense 或 BM25 检索 |
| `dsh-evidence-agent_kb_read` | 读取命中片段前后的上下文 |
| `dsh-evidence-agent_kb_list_sources` | 列出知识库文档和 chunk 数量 |

检索结果包含文档 ID、chunk ID、标题、真实行号、分数和正文。Dense 索引、
Embedding Key 或网络不可用时，Hybrid 检索会降级为 BM25。

## 评测

测试集位于 [eval/questions.jsonl](eval/questions.jsonl)，包括 35 道单跳题、
15 道多跳题和 10 道不可回答题。

检索结果：

| 方案 | Recall@5 | HitRate@5 | MRR@5 |
| --- | ---: | ---: | ---: |
| Hybrid + 用户原问题 | 0.9100 | 0.9400 | 0.7290 |
| BM25 | 0.9100 | 1.0000 | 0.9367 |
| Dense | 0.8900 | 0.9800 | 0.9207 |
| Hybrid + 检索查询 | 0.9300 | 1.0000 | 0.9433 |
| 多查询 Hybrid | 0.9400 | 0.9800 | 0.9307 |

端到端回答结果：

| 方案 | 正确率 | Faithfulness | 不可回答拒答率 | 可回答误拒率 | P95 延迟 | 平均 token |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No RAG | 0.6800 | N/A | 1.0000 | 0.2400 | 14.334 s | 1176.45 |
| Dense | 0.8800 | 0.9800 | 1.0000 | 0.1000 | 5.674 s | 2309.70 |
| Hybrid | 0.9200 | 0.9800 | 1.0000 | 0.1000 | 5.573 s | 2413.23 |
| Agentic | 0.9800 | 0.9800 | 1.0000 | 0.0000 | 18.289 s | 8559.27 |

本轮中 Agentic 平均调用 2.15 次证据工具，最高 4 次。相对于 Hybrid，它使用约
3.5 倍 token 和 3.2 倍平均延迟。

正确率和 Faithfulness 来自 DeepSeek Flash 独立评分会话，是自动标签，尚未经过
完整人工复核。当前语料只有 8 篇文档和 78 个 chunks，结果适合验证工程链路，
不足以作为生产规模结论。

运行离线 BM25 评测：

```powershell
npm.cmd run eval:retrieval:lexical
```

运行完整检索评测需要有效的 Embedding 配置和向量索引：

```powershell
npm.cmd run eval:retrieval
```

详细结果见 [docs/benchmark.md](docs/benchmark.md)、
[docs/evaluation.md](docs/evaluation.md) 和 [docs/answer-evaluation.md](docs/answer-evaluation.md)。

## 测试

```powershell
npm.cmd test
npm.cmd run test:coverage
```

当前测试覆盖切块、BM25、向量索引、RRF、工具预算、错误处理、评测计算和
Skill 约束。GitHub Actions 会在 Node.js 18、20、22 和 24 上运行测试。

## 目录

```text
index.js                 插件入口
lib/                     检索、索引、工具和评测逻辑
skills/                  Agent 运行时策略
eval/                    测试集、回答、评分和报告
knowledge/canonical/     用于检索的规范化文档
docs/                    架构与评测说明
tests/                   node:test 单元和集成测试
```

## 已知限制

- 当前语料规模很小，向量检索使用 JSONL 全量余弦计算，没有接入 ANN 索引。
- 尚未加入 reranker。
- 答案评分以自动标签为主，需要人工抽查。
- Agentic 检索的成本明显高于一次性 Hybrid。
- Prompt Injection 防护依赖工具边界和运行时策略，尚未经过系统化对抗测试。

## 数据与许可

知识库来源及其许可证见 [docs/source-shortlist.md](docs/source-shortlist.md)。
项目代码使用 MIT License，见 [LICENSE](LICENSE)。
