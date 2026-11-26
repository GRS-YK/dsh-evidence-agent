# 使用示例

启动 DSH Web 并选择 `dsh-evidence-agent` 工作区：

```powershell
dsh web
```

当前 DSH profile 需要已经加载插件 bundle。

## 直接回答

```text
你好
```

普通对话不会调用知识库工具。

## 单跳检索

```text
RRF 如何计算融合分数？请依据知识库回答并给引用。
```

Agent 会调用 `kb_search`，必要时用 `kb_read` 读取相邻内容，最终答案包含
文档 ID 和真实行号。

## 多跳检索

```text
比较 BM25 和 RRF：它们各自解决什么问题、如何配合？请依据知识库回答。
```

Agent 会组合 BM25 和 RRF 的相关证据，并且不会超过四次工具调用。

## 无证据时拒答

```text
知识库有没有这个项目的商业收入或客户数据？
```

当前知识库无法确认这类信息，Agent 应明确说明无法回答，而不是补写数字。

## 检查运行轨迹

在 DSH 的轨迹视图中可以看到：

- Skill 是否加载；
- `kb_search`、`kb_read` 的调用；
- 每次调用后的 `budget_remaining`；
- 最终回答使用的引用。
