# 批量上传接口契约（给 PaperTranFlow 对接用）

> **本文档由 CloudFlare-ImgBed（图床）侧提供，供 PaperTranFlow 的 agent 对接使用。**
>
> 目的：把 PaperTranFlow 现在的**逐张上传**改为**一次批量上传 + 指定文件夹名**，
> 使图床网页端（GUI）的目录树按「一篇论文一个文件夹」组织，而不是所有图片平铺在根目录。
>
> 本文档只描述接口。**PaperTranFlow 侧是否需要改、怎么改，由该仓库的 agent 决定。**

---

## 一、为什么要改

### 现状（逐张上传的后果）

PaperTranFlow 现在对 `out_dir/images/` 下的每张图**单独**调 `POST /upload`
（见 `src/ptf_output/image_host.py:50` `upload_one()`，
调用点 `src/ptf_core/pipeline.py:253-258`）。

这会导致两个具体问题：

1. **图床 GUI 目录树很乱**：每张图的 `Directory` 元数据都是空的，
   目录树里**一个文件夹都没有**，所有图片平铺在根目录。
   （这点已在图床侧用 `test/directoryTree.e2e.mjs` 复现验证）
2. **同名文件会互相冲突**：不同论文都有 `fig1.png` 时，
   若都落到根目录，后上传的会覆盖先上传的。

### 目标

改成「一次上传 = 一个文件夹」后，图床 GUI 显示为：

```
Attention_Is_All_You_Need/
  ├── fig1.png
  ├── fig2.png
  └── table1.png
BERT/
  ├── fig1.png
  └── chart.png
```

同名 `fig1.png` 因处于不同文件夹而**互不冲突**。

---

## 二、新接口：`POST /upload/huggingface/batchCommit`

> ⚠️ **前提**：本接口属于图床仓库 `dev` 分支的自定义功能，
> 需图床已部署包含该提交的版本（commit `9fe1bf8` 及之后）。

### 2.1 请求

```
POST {base_url}/upload/huggingface/batchCommit
Authorization: Bearer {token}
Content-Type: application/json
```

请求体（JSON）：

```json
{
  "folderName": "Attention_Is_All_You_Need",
  "channelName": null,
  "commitMessage": "上传论文 Attention_Is_All_You_Need 的 3 张配图",
  "requestId": "paper-attention-20260210-153012",
  "files": [
    {
      "name": "fig1.png",
      "contentBase64": "data:image/png;base64,iVBORw0KGgo...",
      "mimeType": "image/png",
      "sha256": "可选，预计算的 sha256 十六进制"
    },
    {
      "name": "fig2.png",
      "contentBase64": "data:image/png;base64,..."
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `files` | ✅ | 非空数组，每个元素见下表 |
| `folderName` | ➖ | **批次文件夹名**。留空则按时间戳自动生成（见 `autoFolder`） |
| `autoFolder` | ➖ | 默认 `true`。`folderName` 为空时是否自动建时间戳文件夹 |
| `channelName` | ➖ | 指定 HuggingFace 渠道；不传则用默认/负载均衡 |
| `commitMessage` | ➖ | 提交说明，便于在 HF 上辨认 |
| `requestId` | ➖ | **幂等键**。同一 `requestId` 重试会直接返回首次结果，不会重复上传 |

`files[]` 元素：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 文件名。**不能含 `/` 或 `\`**（目录由 `folderName` 决定） |
| `contentBase64` | ✅ | base64 内容。可为 `data:image/png;base64,...` 形式或裸 base64 |
| `mimeType` | ➖ | 不传则服务端按 data URL 前缀 → 扩展名推断 |
| `sha256` | ➖ | 预计算的 sha256，可省服务端计算（大文件建议传） |

### 2.2 响应（成功）

HTTP 200：

```json
{
  "success": true,
  "requestId": "paper-attention-20260210-153012",
  "batchId": "req_paper-attention-20260210-153012",
  "folder": "Attention_Is_All_You_Need",
  "commitId": "a1b2c3d...",
  "channelName": "hf-main",
  "repo": "user/dataset",
  "count": 3,
  "files": [
    {
      "name": "fig1.png",
      "src": "/file/Attention_Is_All_You_Need/fig1.png",
      "fullId": "Attention_Is_All_You_Need/fig1.png"
    }
  ]
}
```

**对接要点 —— 如何得到可用的远程 URL**：

- `files[].src` 是**站内相对路径**（如 `/file/批次名/fig1.png`）。
  PaperTranFlow 现有的 `image_host.py:79-81` 已在处理这种相对路径
  （若不是 `http` 开头则拼 `base_url`），**逻辑可直接复用**。
- 返回的 `files[]` **顺序与请求的 `files[]` 一致**，
  可直接按索引对应回本地文件名，用于 `rewrite_markdown_images()`。

### 2.3 响应（失败）

| HTTP | `code` | 含义 | 建议处理 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 参数错误（空数组/超限/文件名非法/路径穿越） | 修正请求，不要重试 |
| 401 | `AUTH_ERROR` | token 无效或权限不足 | 检查 token |
| 400 | `CHANNEL_NOT_FOUND` | 未配置 HF 渠道 | 检查图床配置 |
| 429 | `RATE_LIMIT` | 被 HF 限流 | 按 `retryAfterSeconds` 等待后重试 |
| 502 | `PARTIAL_UPLOAD_NOT_COMMITTED` | **文件已上传，但 commit 失败** | 见下方说明 |
| 500 | `INTERNAL_ERROR` | 其他错误 | 可重试 |

**关于 502 `PARTIAL_UPLOAD_NOT_COMMITTED`（重要）**：

此时文件**已经在 HuggingFace LFS 存储里**，只是最后的 commit 没成功。
响应会带 `uploadedFiles` 列出已上传的文件：

```json
{
  "success": false,
  "code": "PARTIAL_UPLOAD_NOT_COMMITTED",
  "error": "...",
  "retryAfterSeconds": 30,
  "uploadedFiles": [
    { "name": "fig1.png", "filePath": "批次名/fig1.png" }
  ]
}
```

**重要事实**：HuggingFace 官方保证
「an LFS file that is already committed will never be re-uploaded twice」，
且 LFS 按 SHA256 内容寻址。因此**用同一个 `requestId` 直接重试是安全的**，
服务端不会重复传输相同内容。

> 图床侧已内置：429/5xx 会按 `Retry-After` 自动退避重试；
> 持续失败会把提交拆分为两批以规避 HF 的 60 秒单请求超时。
> 所以 PaperTranFlow 侧只需要处理**最终**返回的错误即可。

---

## 三、PaperTranFlow 侧的改动建议（仅供参考，由该仓库 agent 决定）

### 3.1 最小改动路径

替换 `src/ptf_core/pipeline.py` 的 `_upload_images_to_host()`：
把「循环逐张调 `upload_one()`」改为「一次调用 batchCommit」。

现有代码结构（`pipeline.py:239-262`）：

```python
for img in sorted(images_dir.glob("*")):
    remote = uploader.upload_one(img)
    image_map[f"images/{img.name}"] = remote
```

改为：先收集全部图片 → 一次批量上传 → 按顺序取回 URL。

### 3.2 文件夹名怎么定（关键决定）

需要选一个**稳定且唯一**的批次文件夹名，候选：

| 方案 | 示例 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 论文标题 | `Attention_Is_All_You_Need` | **人类可读，GUI 里一眼能认** | 标题可能重复；含特殊字符需清洗 |
| job id | `20260210-153012` | 绝对唯一 | 不可读，仍需额外映射 |
| 标题+短哈希 | `Attention_Is_All_You_Need_a1b2` | 可读且唯一 | 稍长 |

> 图床侧已做安全清洗（`batchFolder.js`）：论文标题里的
> `: * ? " < > |` 会被替换为 `_`，`../` 等穿越会被拒绝，
> 层级上限 6 层、每段上限 64 字符。所以**直接传论文标题是安全的**。

**建议**：首次对接先用「论文标题」跑通，确认 GUI 显示效果满意后再考虑唯一性加固。

### 3.3 需要保留的现有能力

- `image_host.py` 的 `_extract_src()` 与相对路径拼接逻辑可复用；
- `rewrite_markdown_images()` **无需改动**（它只依赖 `{本地路径: 远程URL}` 映射）；
- `ImageHostConfig`（`base_url` + `token`，存 `config/user/CfImage.json`）**无需改动**。

---

## 四、如何验证对接成功

1. **接口连通**：先用少量图（1–3 张）调用，确认返回 200 且 `files[].src` 可访问。
2. **GUI 目录树**：打开图床网页端，确认左侧目录树出现以论文名命名的文件夹，
   且文件夹内的图片数量正确。
3. **同名不冲突**：连续上传两篇都含 `fig1.png` 的论文，
   确认两篇各自文件夹下都有 `fig1.png`，且内容不同（可对比 URL 或图床元数据）。
4. **markdown 重写**：确认输出 markdown 中的图片链接已变为远程 URL 且能正常显示。

---

## 五、相关文件索引（图床侧）

| 文件 | 作用 |
| --- | --- |
| `functions/upload/huggingface/batchCommit.js` | 本接口实现 |
| `functions/utils/batchUpload/batchFolder.js` | 文件夹名清洗与路径安全规则 |
| `functions/utils/batchUpload/huggingfaceBatchAPI.js` | HF 批量提交（含退避与降级） |
| `functions/api/manage/hfBatchList.js` | 批次清单查询（管理端） |
| `test/directoryTree.e2e.mjs` | GUI 目录树链路验证 |
| `docs/CUSTOMIZATION-DESIGN.md` | 设计依据与 HF 官方限制 |
| `UPSTREAM-SYNC.md` | 上游同步流程 |

---

## 六、给 PaperTranFlow agent 的一句话摘要

> 图床已提供 `POST {base_url}/upload/huggingface/batchCommit`，
> 支持一次上传多张图并指定 `folderName`（云端会生成对应文件夹，使 GUI 目录树清晰）；
> 现有逐张上传的 `POST {base_url}/upload` 仍然可用但会导致图片平铺、目录树无文件夹。
> 建议把 `pipeline.py:239-262` 的逐张循环改为一次批量调用，
> `folderName` 建议用论文标题。接口细节与错误处理见本文档第二、三节。
