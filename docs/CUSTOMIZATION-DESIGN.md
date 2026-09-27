# 定制化功能设计评估

> **本文回答一个问题：基于 HF 的真实限制、管理图片的实际需求和上游的现有机制，
> 我们的批量上传还需要补哪些定制化功能？**
>
> **资料来源说明**：本次评估的依据是
> ① **HF 官方文档原文**（hub/storage-limits、hub/rate-limits、hub/xet/*、
> huggingface_hub/guides/upload）与 **官方 OpenAPI spec**、**SDK 源码**
> （`_commit_api.py` / `lfs.py`）；
> ② **huggingface_hub 官方 issue 与 PR**（#4331、#4362、#918、#3325 等）；
> ③ **本仓库代码的实证**；
> ④ **本地 PaperTranFlow 源码**（真实使用场景）。
>
> 关键数值均标注出处。凡官方未公布或未取得证据的，明确标注「未取得官方数值」，
> 不做推测、不编造。
>
> ⚠️ **联网注意事项**：本机 DNS 对 `huggingface.co` / `github.com` 存在污染
> （huggingface.co 被解析到 `199.59.149.235`，实为 Twitter 的备用 IP），
> `web_fetch` 直连会失败。**需通过本机代理 `http://127.0.0.1:7897` 访问**
> （已实测可用）。`web_search` 因缺 API key 完全不可用。

---

## 零、HF 官方限制（实测取得，这是设计依据）

### 0.1 单次 commit 的文件数 —— 我们的核心约束

来自 [HF 官方 Storage limits 文档](https://huggingface.co/docs/hub/storage-limits)
（原文见 `.hf_research/storage-limits.md:70-79`）：

| 项目 | 官方推荐值 | 原文 |
| --- | --- | --- |
| **Commit 大小** | **<100 个文件** | "Commit size: **<100 files**" |
| 手工提交时的建议 | **每次 50–100 个文件** | "If you commit manually, **keep around 50-100 files per commit**" |
| 每文件夹条目数 | **<10k** | "Entries per folder: <10k" |
| 单文件大小 | <200GB 推荐，500GB 硬上限 | "no single file will exceed 500GB" |
| 每仓库文件数 | <100k | "Files per repo: <100k" |
| Commit 总数 | 无硬限制，但数千后体验下降 | "user experience starts to degrade after a few thousand commits" |

**结论**：我们默认的 `HF_BATCH_MAX_FILES = 50` **正好落在官方建议区间**，无需调整。

**更重要的官方态度**（`storage-limits.md:76-77`）：
> "Commits per repo: upload **multiple files per commit** and/or squash history"

即官方**明确推荐**「一次 commit 传多个文件」——我们的"N 文件 → 1 commit"设计方向正确。

#### 已用官方 OpenAPI spec 逐条核验（一手证据）

我们把官方 spec（`https://huggingface.co/.well-known/openapi.json`，1.1MB）拉下来
做了程序化提取，结果如下：

| 端点 | `maxItems` | 我们是否受影响 |
| --- | --- | --- |
| `/api/datasets/{ns}/{repo}/**preupload**/{rev}` 的 `files` | **1000**（书面硬上限） | ✅ 安全：我们**每文件单独 preupload**，每次 1 个 |
| `/api/datasets/{ns}/{repo}/**commit**/{rev}` | **无任何 maxItems** | ✅ 与官方文档「no hard limit」一致 |
| `/api/*/paths-info/{rev}` 的 `paths` | 2000 | 本次未使用 |

**这意味着**：
- 「一次 commit 能带多少操作」**没有书面硬上限**，真正的约束是
  ① 官方建议的 50–100 文件 ② HTTP 60 秒超时 ③ 429 限流
- `preupload` 的 1000 上限**不构成风险**，因为我们的实现逐文件 preupload

> 复现方式：下载 spec 后搜索 `preupload` 与 `commit` 端点的 `maxItems` 即可验证。

### 0.2 HTTP 60 秒超时 —— 我们最大的未处理风险

`storage-limits.md:111-116` 原文：
> "When pushing data through HTTP, **a timeout of 60s is set on the request**,
> meaning that if the process takes more time, an error is raised."

**含义**：单个 commit 请求必须在 60 秒内完成，否则报错。
我们当前实现把「所有文件的 LFS 上传 + 一次 commit」都放在**同一个 Worker 请求**里，
批量较大时会逼近甚至超过这个限制。

### 0.3 官方是怎么处理这个问题的（关键参考）

来自 [huggingface_hub issue #4331](https://github.com/huggingface/huggingface_hub/issues/4331)
——官方 `upload_folder` 的重写方案：

| 官方做法 | 具体数值 | 我们的现状 |
| --- | --- | --- |
| 每批文件数 | 初始 **256**，动态调节 **[64..1024]** | 固定 50 |
| **调节依据** | **单次 commit 耗时 <40 秒** | ❌ 未控制耗时 |
| 提交失败处理 | **缩小批量 + 拆分 + 重试** | ❌ 无自动降级 |
| preupload 每次 | 256 个文件 | 逐文件 |
| 429 处理 | `http_backoff` + `Retry-After` | ✅ 已解析 `retry-after` |
| 断点续传 | 靠 preupload 的 `remote_oid` 跳过已提交文件 | ⚠️ 部分（仅返回清单） |

**核心洞察**：官方是按**耗时**（<40s 目标）动态调节批量大小，而不是固定文件数。
这比"设一个固定上限"稳健得多。

### 0.4 429 是真实存在的生产问题

[issue #3312](https://github.com/huggingface/huggingface_hub/issues/3312)
《Production system breaks due to HTTP 429 errors》仍是 **open** 状态。
[issue #4362](https://github.com/huggingface/huggingface_hub/issues/4362)
进一步指出应「**batch by file size, not file count**」（按字节而非文件数分批）。

官方速率限制（`rate-limits.md:58-76`，2025 年 9 月数据，**5 分钟固定窗口**）：

| 账户类型 | API | Resolvers | Pages |
| --- | --- | --- | --- |
| 匿名（按 IP） | 500 | 3,000 | 100 |
| **免费用户** | **1,000** | 5,000 | 200 |
| PRO | 2,500 | 12,000 | 400 |

⚠️ **未取得官方数值**：文档明确说明「**repo commits** 属于额外的细粒度限制，
但**不公开具体数值**」（`rate-limits.md:100-110`）。因此无法给出"每小时能提交多少次"的确定答案。

### 0.5 Xet 存储迁移

HF 正在迁移到 Xet（`storage-limits.md` 与多份 Xet 文档）。关键影响：
「**All Hub repos are xet-backed**」（issue #4331），官方新流程在 Xet 可用时
**完全跳过 LFS batch 端点**。但**旧 LFS 路径仍受支持**（我们的实现依赖它）。

**未取得明确结论**：LFS batch 端点的弃用时间表。我们的实现依赖
`preupload` + `lfsBatch` + `uploadToLFS`，与上游 `HuggingFaceAPI` 保持一致，
即便未来需要迁移，也只需改上游类，我们的子类会自动继承新行为。

---

## 一、结论速览

| # | 问题 | 严重度 | 建议 |
| --- | --- | --- | --- |
| 1 | 单请求可能超过 HF 的 60 秒 commit 超时 | **高** | ✅ **已实现**：按耗时降级拆分提交 |
| 2 | 429 限流（官方明确会限流） | **高** | ✅ **已实现**：按 `retry-after` 退避重试 |
| 3 | 索引操作记录数 = 文件数，大批量需多轮 finalize | **中** | 改用上游已有的 `batchAddFilesToIndex` |
| 4 | 幂等键污染备份导出 | ✅ **已修复** | 换独立前缀 |
| 5 | 批次清单（manifest），事后可回溯"这批传了什么" | ✅ **已实现** | 新增 manifest + 查询接口 |
| 6 | 重复文件（相同 sha256）无去重提示 | **低** | 提交前做轻量查重 |
| 7 | commit 失败后无补交接口（需整批重传） | **中** | 已有 `uploadedFiles` 基础，加补交接口 |
| 8 | 批次文件夹重名会混在一起 | **低** | 已有时间戳兜底，可加冲突策略 |
| 9 | 单请求全量 base64，内存压力大 | **中** | 与第 1 条合并解决（分批） |
| 10 | **PaperTranFlow 逐张上传，无批次概念** | **中** | 改用批量接口 + 传批次文件夹名 |

---

## 一点五、真实使用场景：PaperTranFlow（这决定了设计重点）

**这一节是本次评估中最重要的上下文**，它来自对本地
`C:\Project_Repository\winproject\PaperTranFlow` 源码的实际阅读
（该仓库尚未推送到 GitHub，远程是空占位仓库，**不能以远程状态判断其内容**）。

### 实际工作流

```
PDF → MinerU → Markdown + images/
     → 翻译
     → 上传 out_dir/images/* 到图床
     → 把 markdown 里的 images/xxx.jpg 重写为远程 URL
```

证据：
- `src/ptf_core/pipeline.py:239-262` `_upload_images_to_host()`：
  遍历 `out_dir/images/`，**逐张**调 `uploader.upload_one(img)`，收集
  `image_map["images/<name>"] = remote`，最后 `rewrite_markdown_images()` 回写。
- `src/ptf_output/image_host.py:41-81`：接口约定为
  `POST {base_url}/upload`，multipart 字段名 `file`，
  `Authorization: Bearer {token}`，返回 `[{"src": ...}]`。
- `src/ptf_config/models.py:65-70`：配置存放于
  `config/user/CfImage.json` → `{"base_url": "...", "token": "..."}`，默认关闭。

### 这如何改变设计重点

| 原来以为 | 实际情况 |
| --- | --- |
| 用户在网页点按钮选多张图 | **程序化调用**，一次上传一整篇论文的配图 |
| 需要复杂的网页 UI | 首要是**稳定的批量 HTTP 接口** |
| 批次文件夹可选 | **必须有**——否则每篇论文的图混在一起，正是"云端很乱"的根因 |

### 由此得出的两个具体需求

**需求 A：PaperTranFlow 侧要从「逐张上传」改为「一次批量上传」**

当前逐张上传会产生两个问题：
1. HF 上产生 N 个 commit（官方明确：git 不适合当高频写数据库，数千 commit 后体验下降）
2. 无法表达"这批图属于同一篇论文"

**需求 B：批次文件夹名应可推导自论文标识**

建议 PaperTranFlow 传 `folderName = <论文名或 job id>`，
使云端形成 `论文A/fig1.png, 论文A/fig2.png …` 的清晰布局。
`batchFolder.js` 已支持该参数，且已拦截路径穿越与非法字符
（论文标题常含 `:`、`?`、`/` 等字符，会被自动清洗为 `_`）。

### 与 PaperTranFlow 现有设计的呼应

值得注意，PaperTranFlow 自身已有两个成熟模式，与本图床设计**方向一致**：

- **`.PaperTranFlow/jobs/<job>/` 每次任务独立工作目录**
  （README 第 60 行）——这与我们「一次上传 = 一个批次文件夹」是同一思路。
- **Checkpoint + resume**（`src/ptf_translation/checkpoint.py`）：
  `state.json` 记录 `done_chunk_ids`，`chunks/<id>.json` 逐条落盘，
  resume 时校验 `source_hash` 跳过已完成项。
  ——这与我们 manifest 的"可回溯、可续传"目标一致，**可作为客户端侧续传的实现参考**。

---

## 二、逐项分析

### 1. 索引操作记录数 = 文件数 【中】

**代码事实**（`functions/utils/indexManager.js`）：

- `recordOperation()` 每次调用写入 **1 条** KV 记录（键前缀 `manage@index@operation_`）
- `getAllPendingOperations()` 单次最多读取 **30 条**（`MAX_OPERATION_COUNT = 30`，第 1335 行）
- `endUpload()` → `addFileToIndex()` 是**逐文件**调用（`functions/upload/uploadTools.js:398`）

**实测数据**（`test/indexLoadAnalysis.mjs`）：

| 批次文件数 | 当前实现操作记录 | 需 finalize 轮次 |
| --- | --- | --- |
| 10 | 10 | 1 |
| 30 | 30 | 1 |
| **50（当前默认上限）** | **50** | **2** |
| 100 | 100 | 4 |
| 200 | 200 | 7 |

**上游已有更优模式**：`functions/utils/indexManager.js:100` 的
`batchAddFilesToIndex(context, files, { skipExisting })` —— **一次记录一条批量操作**。
上游自己的批量删除就是这么做的（`functions/api/manage/delete/batch.js:40` 调
`batchRemoveFilesFromIndex`），且其 `MAX_BATCH_SIZE = 500`，说明这个模式在大批量下是安全的。

**建议**：把逐文件 `endUpload` 换成收集完所有文件后调用一次 `batchAddFilesToIndex`。
代价是单条操作记录变大（KV 单值上限 25MB，50 个文件的 metadata 远低于此，安全）。

---

### 2. 幂等键污染备份导出 【中】

**代码事实**：

- 我的实现写入 `manage@hf_batch_request@<requestId>`（`functions/upload/huggingface/batchCommit.js`）
- `functions/api/manage/batch/settings.js` 会**列出所有 `manage@` 前缀的键**并导出，
  仅排除 `manage@index*` 和 `manage@session@*`（函数 `isIndexRelatedKey`）

**后果**：每次批量上传都会在「系统设置」里留下一条无用记录，备份文件会持续膨胀。

**建议**（两种，任选）：
- 换成不被 `manage@` 扫描的前缀，例如 `hfBatchReq@<requestId>`；
- 或者给 `isIndexRelatedKey` 式逻辑加一条排除规则——但注意这会**修改上游文件**，
  与"上游零改动"目标冲突，因此**推荐改前缀**。

---

### 3. 缺少批次清单（manifest）【中】

**现状**：一批上传完成后，只有各文件的 metadata，**没有"这一批包含哪些文件"的记录**。
如果事后想核对或回滚某一批，只能靠时间戳猜。

**为什么值得做**：这正是你最初的痛点——"云端布局很乱，我不好处理"。
有了 manifest，每次上传都是一个**可回溯、可列出、可整批操作**的单元。

**建议设计**：上传成功后写入一条批次记录：

```
键：manage@hf_batch@<batchId>
值：{
  batchId, folder, channelName, repo, commitId,
  createdAt, fileCount, totalBytes,
  files: [ { fullId, name, size } ]
}
```

配合一个查询接口 `GET /api/manage/batch/hfBatchList`，就能在管理端按批查看。

> 注意：键名若用 `manage@` 前缀会落入上面第 2 条的备份问题，
> 应统一和幂等键一起换成独立前缀。

---

### 4. 单请求全量 base64 的内存限制 【高】

**现状**：当前实现要求客户端把**所有文件**的 base64 塞进**一个 JSON 请求**，
服务端再整体 `atob` 解码到内存。

**风险点**（Worker 运行时的已知约束，属通用事实）：
- Workers 有内存与 CPU 时间上限，单请求处理 80MB base64（默认上限）会非常吃紧
- base64 编码有 ~33% 膨胀：80MB 原始数据 ≈ 107MB 的 base64 文本
- 一次 `request.json()` 解析这么大的文本，在边缘环境很容易超时

**当前限额**：`HF_BATCH_MAX_FILES=50`、`HF_BATCH_MAX_TOTAL_SIZE=80MB`、
`HF_BATCH_MAX_SINGLE_FILE_SIZE=20MB`。

**建议**：引入**分片提交**——客户端把文件分成小批（例如每批 5–10 个 / 每批 ≤10MB），
依次调用同一接口，用同一个 `batchId` 聚合：

- 各次调用只做「上传 + 暂存操作」，不立即 commit
- 最后一次调用带 `finalize: true`，把累积的操作**合并成一个 commit**

这样既保住"云端只产生 1 个 commit"的核心优势，又避免单请求过大。

> 说明：这需要新增"暂存操作"的存储（可复用 KV）。
> 属于**较大的功能性扩展**，建议在确认实际使用规模后再做。

---

### 5. 重复文件无去重提示 【低】

**现状**：同一批次内重名会被拦（`assertNoDuplicatePaths`），
但**同一个文件内容传到不同文件夹**不会提示。

**可行的轻量做法**：提交前用 `sha256` 查一次 KV 里是否已有相同哈希的文件，
命中则在响应里返回 `duplicates: [...]` 提示，**但不阻止上传**（避免改变用户预期）。

**不建议**做内容寻址存储（CAS）——那会破坏用户可读的目录结构，
与本项目"按批次文件夹化"的设计目标直接冲突。

---

### 6. 断点续传 【中】

**已有基础**：`uploadFilesInSingleCommit` 在 commit 失败时会把 `uploadedFiles`
挂到 error 上，响应码 `PARTIAL_UPLOAD_NOT_COMMITTED`（502）已经返回了已上传清单。

**缺口**：客户端拿到这个响应后，**没有接口能"只补交 commit"**——
因为文件实际已在 LFS 存储里，只需重新 commit 一次，但当前必须整批重传。

**建议**：新增一个 `POST /upload/huggingface/batchCommitFinalize`，
接收已上传文件的 `[{ filePath, oid, size, needsLfs }]`，只做 commit。
这样 502 之后的恢复成本从"重传全部"降到"一次轻量请求"。

---

### 7. 批次文件夹重名 【低】

**现状**：用户指定 `folderName` 后直接使用。若两次都用"旅行照片"，会**混进同一目录**。

**建议**：上传前检查该文件夹是否已存在（`metadata.Directory` 或索引里查），
若存在则返回警告 + 可选参数：
- `onConflict: 'merge'`（默认，允许合并）
- `onConflict: 'rename'`（自动加后缀 `旅行照片-2`）
- `onConflict: 'error'`（直接报错）

未指定文件夹时已有时间戳兜底，不受影响。

---

## 三、优先级建议

**建议现在就做**（改动小、收益明确）：

1. **第 2 条**：幂等键换前缀（几行代码，避免备份长期被污染）
2. **第 1 条**：改用 `batchAddFilesToIndex`（减少索引开销）
3. **第 3 条**：批次 manifest + 列出接口（直接解决"云端乱、难回溯"）

**建议下一轮做**：

4. **第 6 条**：commit 补交接口（把 502 恢复成本降下来）
5. **第 7 条**：文件夹重名策略

**建议先不做**（等有实际规模再说）：

6. **第 4 条**：分片提交（复杂度高，当前限额内够用）
7. **第 5 条**：查重提示（锦上添花）

---

## 四、关于 PaperTranFlow 与外部调研的说明

本次评估**未能取得外部资料**：`web_search` 报告缺少 API key，
`web_fetch` 无法建立连接。因此：

- **没有** PaperTranFlow 的可验证设计细节——我无法确认它的文件组织/去重机制，
  也**不会**凭印象套用它的设计。
- **没有**取得 HF 官方关于单次 commit 文件数上限、速率限制、Xet 迁移的权威数值。

上面所有关于本项目的结论，均来自**本仓库代码的实证**（已标注文件与行号），
这部分是可靠的。若需要外部调研结论，请先恢复 web_search 的 API key
或 `web_fetch` 的网络访问，我可以补齐：
HF commit 的官方限额、速率限制、以及 PaperTranFlow / Chevereto / Lychee / Immich
的目录组织与去重方案对比。
