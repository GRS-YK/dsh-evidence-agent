# dsh-evidence-agent

A DeepSeek Harness plugin.

Generated with [dsh-plugin-starter](https://github.com/ciceroyang/dsh-plugin-starter).

## 结构

    index.js             宿主插件:工具 + 运行时 skill 注册
    lib/                 纯函数(可单测,不依赖任何 harness 服务)
    skills/dsh-evidence-agent/SKILL.md  技能说明书(模型视角)
    tests/                node:test 单测
    cordis.patch.yml     bundle patch 层
    package.json         dsh.bundle manifest

## 本地开发

    node --test

查看测试覆盖率：

    npm run test:coverage

用 --patch 覆盖层加载(插件路径必须绝对):

    dsh --profile headless --patch ./dev.cordis.yml "任务"

## 知识库清单

根据 `knowledge/sources.json` 重新计算规范文档的大小和 SHA-256：

    npm run knowledge:manifest

检查已提交的 `knowledge/manifest.jsonl` 是否过期：

    npm run knowledge:manifest:check

## Markdown 切分

`lib/chunker.js` 按标题层级切分 Markdown，保留标题路径、真实行号和少量重叠。
每个 chunk 的默认上限是约 600 tokens：

```js
import { chunkMarkdown } from './lib/chunker.js'

const chunks = chunkMarkdown(markdown, {
  docId: 'dsh-first-plugin',
  title: 'Your first plugin',
})
```

## Embedding 索引

复制本地配置模板：

```powershell
Copy-Item .env.example .env
notepad .env
```

只在本机 `.env` 中填写 `EMBEDDING_API_KEY`。不要提交 `.env`。

也可以用隐藏输入自动写入本地配置：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\set-embedding-key.ps1
```

测试 Embedding 接口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-embedding.ps1
```

建立或增量更新向量索引：

```powershell
npm run embeddings:build
```

检查索引是否与当前文档和模型配置一致：

```powershell
npm run embeddings:check
```

强制重新生成全部向量：

```powershell
npm run embeddings:rebuild
```

生成文件位于 `knowledge/index/vectors.jsonl`，该目录不会提交到 Git。

## 安装

    dsh plugin --profile web add <本目录>

## 发布

1. GitHub 建仓库并打 topic:dsh-plugin
2. 给 awesome-deepseek-harness 提收录 PR(中英双语各一条)

## 参考

- 官方插件教程与踩坑记录:https://github.com/ciceroyang/dsh-report-studio/blob/main/docs/tutorial-zh.md
- 完整实例:https://github.com/ciceroyang/dsh-report-studio

## BM25 关键词索引

BM25 索引使用英文单词和中文单字/相邻双字 n-gram，不依赖额外的分词服务。
索引文件 `knowledge/index/bm25.json` 由当前 chunk 确定性生成，不提交到 Git。

建立索引：

```powershell
npm.cmd run bm25:build
```

预期输出：

```text
Wrote knowledge/index/bm25.json (78 chunks, ... terms)
```

检查索引是否与当前文档一致：

```powershell
npm.cmd run bm25:check
```

预期输出：

```text
BM25 index is up to date (78 chunks)
```

查询前 5 个结果：

```powershell
npm.cmd run bm25:search -- "reciprocal rank fusion"
```

限制返回条数：

```powershell
npm.cmd run bm25:search -- "BM25Okapi" --top-k 3
```

BM25 只做关键词匹配，不会翻译中英文。当前资料以英文为主，因此中文查询能否命中取决于语料中是否真的出现相应中文词项；跨语言语义召回将在 Dense + BM25 + RRF 阶段完成。
