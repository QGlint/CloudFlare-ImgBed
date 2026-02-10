# CloudFlare-ImgBed HuggingFace 批量 Commit 改造说明

## 1. 背景与目标

当前调用方对 CloudFlare-ImgBed 的上传通常是逐文件调用 `/upload`。当上传通道为 HuggingFace 时，服务端实现会对每个文件执行一次 `commit`，很容易触发 HuggingFace 的 commit 频率限制（例如 128 commit/小时）。

目标：

- **不改变现有 `/upload` 单文件能力（兼容历史调用）**；
- 为 HuggingFace 增加“**一批文件仅一次 commit**”能力；
- 调用方在批量上传一个业务批次时，走新的批量提交接口。

---

## 2. 现状确认（为什么会触发 429）

根据 CloudFlare-ImgBed 当前实现逻辑：

1. `functions/upload/index.js` 使用 `formdata.get('file')`，一次只处理一个文件；
2. HuggingFace 分支调用 `HuggingFaceAPI.uploadFile(...)`；
3. `functions/utils/huggingfaceAPI.js` 的 `uploadFile()` 内部每个文件都会执行：
   - `preupload` -> `lfsBatch` -> `uploadToLFS` -> `commitLfsFile`（或 `commitDirectFile`）；
4. 因此是“**每文件 1 次 commit**”的行为。

结论：只要文件数较多，就会快速耗尽 commit 配额并出现 `429`。

---

## 3. 改造原则

- **原则1：commit 粒度改为“批次级别”而不是“文件级别”**。
- **原则2：上传数据与提交引用分离**（先上传对象，再一次性 commit）。
- **原则3：接口向后兼容**（保留 `/upload` 供旧客户端使用）。
- **原则4：失败可恢复**（批量操作要有任务 ID 和幂等设计）。

---

## 4. 推荐实现方案（服务端）

## 4.1 新增批量上传提交接口（推荐）

建议新增 1 个批量接口（路径可调整）：

- `POST /api/huggingface/batch-upload-commit`

请求体建议：

```json
{
  "uploadFolder": "BF45136",
  "channelName": "HF_img",
  "files": [
    {
      "name": "主图-01.jpg",
      "mimeType": "image/jpeg",
      "contentBase64": "..."
    },
    {
      "name": "info.txt",
      "mimeType": "text/plain; charset=utf-8",
      "contentBase64": "..."
    }
  ],
  "commitMessage": "Upload BF45136 assets"
}
```

返回体建议：

```json
{
  "success": true,
  "commitId": "<sha>",
  "files": [
    { "name": "主图-01.jpg", "src": "/file/BF45136/主图-01.jpg" },
    { "name": "info.txt", "src": "/file/BF45136/info.txt" }
  ]
}
```

> 说明：如果考虑请求体大小，可改为“先拿每个文件的预签名 URL 上传，再调用 batch commit 提交引用”。

## 4.2 批量 commit 的核心逻辑

对 HuggingFace 来说，关键是最终 `commit/main` 请求只发一次，且包含多个 operation：

- 对 LFS 文件：追加多条 `lfsFile` operation；
- 对小文本文件（如 `info.txt`）：可用 `file` operation（base64）；
- 最终 NDJSON body 结构为：
  - 1 行 header
  - N 行 file/lfsFile

伪代码：

```js
const operations = [];
for (const file of files) {
  const pathInRepo = `${uploadFolder}/${file.name}`;

  if (needsLfs(file)) {
    const { oid, size } = await preuploadAndLfsUpload(file, pathInRepo);
    operations.push({ key: 'lfsFile', value: { path: pathInRepo, algo: 'sha256', oid, size } });
  } else {
    operations.push({ key: 'file', value: { path: pathInRepo, content: base64(file), encoding: 'base64' } });
  }
}

await commitMainOnce({
  summary: commitMessage,
  operations
});
```

---

## 5. 细节建议

### 5.1 幂等与恢复

- 建议加 `requestId`（客户端生成）避免重复提交；
- 如果 commit 失败，返回明确的错误分类：
  - `RATE_LIMIT`
  - `AUTH_ERROR`
  - `CHANNEL_NOT_FOUND`
  - `PARTIAL_UPLOAD_NOT_COMMITTED`

### 5.2 限流与退避

- 若 HuggingFace 返回 429：
  - 服务端返回 `retryAfterSeconds`（可从响应或策略计算）；
  - 不要再对该批次做逐文件重试 commit。

### 5.3 路径与命名

- 路径建议：`<uploadFolder>/<filename>`（保持与现有 `/file/{path}` 路由一致）；
- 禁止覆盖系统文件名；
- 保留中文文件名（仅做 URL 编码处理）。

### 5.4 安全

- token 仅保留服务端；
- 接口保持现有鉴权机制；
- 限制单次批量文件数、总大小（避免请求体过大）。

---

## 6. 客户端对接建议（通用）

调用方建议改为：

1. 按业务批次收集文件（例如 jpg/jpeg/png/webp/info.txt）；
2. 一次调用 CloudFlare-ImgBed 批量接口；
3. 使用返回的 `src/url` 写入本地或业务侧 `imgbed_manifest.json`（或等价清单）；
4. 若返回 429，立即停止后续批次上传，等待窗口恢复。

---

## 7. 验收标准（必须满足）

- 上传 1 个业务批次的 10 个文件（含 `info.txt`）时：
  - HuggingFace 侧仅产生 **1 次 commit**；
  - 10 个文件均可通过 `/file/<uploadFolder>/<filename>` 访问；
  - 图片 `Content-Type` 正确（image/jpeg/png/webp），`info.txt` 为 `text/plain`。
- 连续上传多个业务批次时，不再出现“每文件一次 commit”导致的快速 429。

---

## 8. 兼容策略

- 保留旧的 `/upload`（单文件）逻辑；
- 新接口上线后，调用方可灰度切换（按配置开关选择新旧路径）；
- 一旦新接口异常，可快速回退到旧接口（但会恢复高 commit 频率风险）。

---

## 9. 已落地实现说明（当前仓库）

### 9.1 新增接口

- 已新增：`POST /api/huggingface/batch-upload-commit`
- 功能：
  - 一次请求可上传多个文件；
  - HuggingFace 侧仅执行 **1 次 `commit/main`**；
  - 每个文件仍写入独立 metadata，保持 `/file/<path>` 访问兼容。

### 9.2 请求体（已实现）

```json
{
  "uploadFolder": "BF45136",
  "channelName": "HF_img",
  "requestId": "bf45136-20260210-001",
  "commitMessage": "Upload BF45136 assets",
  "files": [
    {
      "name": "主图-01.jpg",
      "mimeType": "image/jpeg",
      "contentBase64": "...",
      "sha256": "可选，建议大文件提供"
    },
    {
      "name": "info.txt",
      "mimeType": "text/plain; charset=utf-8",
      "contentBase64": "..."
    }
  ]
}
```

说明：

- `files` 必填且非空；
- `name` 仅允许文件名，不允许 `/`、`\\`、`..` 等路径片段；
- `requestId` 可选，用于幂等（同一 `requestId` 会直接返回首次结果）；
- `contentBase64` 支持纯 base64 或 data URL 形式。

### 9.3 成功返回（已实现）

```json
{
  "success": true,
  "requestId": "bf45136-20260210-001",
  "commitId": "<sha>",
  "channelName": "HF_img",
  "repo": "owner/repo",
  "files": [
    {
      "name": "主图-01.jpg",
      "src": "/file/BF45136/%E4%B8%BB%E5%9B%BE-01.jpg",
      "fullId": "BF45136/主图-01.jpg"
    }
  ]
}
```

### 9.4 错误码（已实现）

- `INVALID_REQUEST`：参数错误（400）
- `AUTH_ERROR`：鉴权失败（401）
- `CHANNEL_NOT_FOUND`：HF 渠道不存在或配置不完整（400）
- `RATE_LIMIT`：HuggingFace 返回 429（429，附带 `retryAfterSeconds`）
- `PARTIAL_UPLOAD_NOT_COMMITTED`：对象已上传但最终 commit 失败（502）

### 9.5 默认限制（可通过环境变量覆盖）

- 最大文件数：`HF_BATCH_MAX_FILES`（默认 50）
- 单文件最大：`HF_BATCH_MAX_SINGLE_FILE_SIZE`（默认 20MB）
- 单次总大小：`HF_BATCH_MAX_TOTAL_SIZE`（默认 80MB）

### 9.6 兼容性确认

- 旧的 `/upload` 单文件上传逻辑未修改，可继续使用；
- 新接口仅新增，不影响现有客户端；
- `/file` 读取链路无需改造。
