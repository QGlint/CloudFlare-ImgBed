# CloudFlare-ImgBed API 文档

本文档面向本仓库当前实现（`functions/` 路由）。重点覆盖：上传、读取、公开浏览、管理端，以及新增的 HuggingFace 批量上传接口。

## 1. 基本约定

- 基础地址：`https://<你的域名>`
- 路由来源：Cloudflare Pages Functions（`functions/**`）
- 返回格式：项目内历史接口风格不完全统一（有 JSON / 文本 / 重定向）
- 文件路径：涉及 `/file/<path>` 的接口建议对每个路径段做 URL 编码

## 2. 鉴权说明

### 2.1 普通上传鉴权（用户侧）

以下接口会校验上传权限（`upload`）：

- `POST /upload`
- `POST /api/huggingface/getUploadUrl`
- `POST /api/huggingface/commitUpload`
- `POST /api/huggingface/batch-upload-commit`

支持的认证方式：

1. `Authorization` API Token（支持 `Bearer <token>` 或直接 `<token>`）
2. `authCode`（query/header/cookie）

### 2.2 管理端鉴权（`/api/manage/*`）

- 默认由 `functions/api/manage/_middleware.js` 统一鉴权
- 支持 Basic Auth（管理员账号密码）或 API Token
- Token 权限按接口语义分为：`upload` / `delete` / `list`

## 3. 公共与通用接口

### 3.1 基础信息

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 用户侧登录校验（提交 `authCode`） |
| GET | `/api/userConfig` | 读取前端页面配置 |
| GET | `/api/channels` | 获取可用上传渠道（`includeDisabled=true` 可带禁用渠道） |
| POST | `/api/fetchRes` | 代理抓取远端 URL 内容（请求体：`{ "url": "..." }`） |
| GET | `/api/bing/wallpaper` | 获取 Bing 壁纸数据 |

### 3.2 文件读取与随机图

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/HEAD | `/file/{path}` | 按文件 ID/路径读取文件（支持 Range） |
| GET | `/random` | 随机文件/随机图 API（受系统配置控制） |
| GET | `/api/public/list` | 公开浏览列表（受 `publicBrowse` 配置控制） |

`/random` 常用参数：

- `content`: 内容类型过滤，默认 `image`，可多值逗号分隔
- `orientation`: `landscape` / `portrait` / `square`
- `dir`: 目录过滤
- `type`: `url` / `img`
- `form`: `text`（返回纯文本 URL）

`/api/public/list` 常用参数：

- `dir`: 目录
- `search`: 文件名搜索
- `recursive`: 是否递归
- `type`: `image` / `video` / `audio` / `other`
- `start`, `count`: 分页

### 3.3 WebDAV

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| OPTIONS / PROPFIND / PUT / DELETE / GET / MKCOL | `/dav/{path}` | WebDAV 接口（需在系统设置开启并配置） |

## 4. 上传接口

## 4.1 通用上传（单文件）

### `POST /upload`

请求：`multipart/form-data`

- 必填：`file`
- 可选：`sha256`（给 HuggingFace 用，减少服务端计算）
- `Content-Type` 兜底：服务端会按 `file.type` -> 文件扩展名 自动推断；仅在无法推断时回落 `application/octet-stream`

常用 query 参数：

- `uploadChannel`: `telegram` / `cfr2` / `s3` / `discord` / `huggingface` / `external`
- `channelName`: 指定渠道名
- `uploadFolder`: 上传目录
- `returnFormat`: `default`（`/file/...`）或 `full`（完整 URL）
- `autoRetry`: `false` 关闭失败自动切换渠道重试
- `serverCompress`: `false` 关闭服务器端压缩（部分渠道）

返回（常见）：

```json
[
  {
    "src": "/file/xxxx"
  }
]
```

## 4.2 分块上传（复用 `/upload`）

### 初始化会话

`POST /upload?initChunked=true`

`multipart/form-data` 字段：

- `originalFileName`
- `originalFileType`
- `totalChunks`

### 上传分块

`POST /upload?chunked=true`

`multipart/form-data` 字段：

- `file`（分块）
- `chunkIndex`
- `totalChunks`
- `uploadId`
- `originalFileName`
- `originalFileType`

### 合并分块

`POST /upload?chunked=true&merge=true`

### 清理分块

`POST /upload?cleanup=true&uploadId=...&totalChunks=...`

## 4.3 HuggingFace 大文件直传

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/huggingface/getUploadUrl` | 获取 LFS 预上传信息（直传 S3 所需参数） |
| POST | `/api/huggingface/commitUpload` | 直传后提交 LFS 引用（单文件） |

## 4.4 HuggingFace 批量上传

### `POST /api/huggingface/batch-upload-commit`

用途：一次请求上传多个文件，并在 HuggingFace 侧执行 **一次** `commit/main`。

请求体：

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
      "sha256": "可选"
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

- `files[].mimeType` 可选；未传时服务端会优先从 `contentBase64` 的 data URL 前缀推断，其次按文件名扩展名推断，最后兜底 `application/octet-stream`

返回体：

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

接口特性：

- 批次单次 commit（避免每文件 commit 导致 429）
- `requestId` 幂等（同请求号重复调用返回首次结果）
- 支持中文文件名（返回 `src` 已 URL 编码）
- 每个文件仍单独写 metadata，兼容 `/file/<path>`
- `/file` 读取时会对缺失/无效 MIME 按文件名扩展名做兜底，降低浏览器误下载概率

错误码：

- `INVALID_REQUEST`（400）
- `AUTH_ERROR`（401）
- `CHANNEL_NOT_FOUND`（400）
- `RATE_LIMIT`（429，含 `retryAfterSeconds`）
- `PARTIAL_UPLOAD_NOT_COMMITTED`（502）

可选环境变量（限制批量体积）：

- `HF_BATCH_MAX_FILES`（默认 50）
- `HF_BATCH_MAX_SINGLE_FILE_SIZE`（默认 20MB）
- `HF_BATCH_MAX_TOTAL_SIZE`（默认 80MB）

## 5. 管理端 API（`/api/manage/*`）

> 下列接口默认受管理端鉴权保护。

## 5.1 账号与健康

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| ALL | `/api/manage/check` | 管理端连通性检查，返回 `true` |
| ALL | `/api/manage/login` | 重定向到 `/dashboard` |
| ALL | `/api/manage/logout` | 返回 401（用于前端登出态） |

## 5.2 文件管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/manage/list` | 管理端文件列表/检索/分页（支持索引动作参数） |
| ALL | `/api/manage/delete/{path}` | 删除文件；`folder=true` 可递归删除目录 |
| ALL | `/api/manage/move/{path}` | 移动文件；`dist` 指定目标目录；`folder=true` 支持目录移动 |
| ALL | `/api/manage/block/{path}` | 将文件标记为 `ListType=Block` |
| ALL | `/api/manage/white/{path}` | 将文件标记为 `ListType=White` |

`/api/manage/list` 常见参数：

- 分页：`start`, `count`
- 过滤：`dir`, `search`, `channel`, `channelName`, `listType`, `accessStatus`, `label`, `fileType`
- 标签：`includeTags`, `excludeTags`
- 索引动作：`action=rebuild|merge-operations|delete-operations|index-storage-stats|info`

## 5.3 配额与 Token

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/manage/quota` | 读取容量统计 / 触发重新统计（索引重建） |
| GET/POST/PUT/DELETE | `/api/manage/apiTokens` | API Token 列表、创建、改权限、删除 |

## 5.4 系统设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/manage/sysConfig/upload` | 上传配置 |
| GET/POST | `/api/manage/sysConfig/page` | 页面配置 |
| GET/POST | `/api/manage/sysConfig/security` | 安全配置 |
| GET/POST | `/api/manage/sysConfig/others` | 其他配置（随机图、公开浏览、WebDAV 等） |

## 5.5 自定义策略（IP）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| ALL | `/api/manage/cusConfig/list` | 按上传 IP 聚合统计 |
| ALL | `/api/manage/cusConfig/blockip` | 加入 IP 黑名单（请求体纯文本 IP） |
| ALL | `/api/manage/cusConfig/whiteip` | 从黑名单移除 IP（请求体纯文本 IP） |
| ALL | `/api/manage/cusConfig/blockipList` | 读取黑名单列表 |

## 5.6 标签管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/manage/tags/{fileId}` | 查询/更新单文件标签（`set/add/remove`） |
| POST | `/api/manage/tags/batch` | 批量更新标签 |
| GET | `/api/manage/tags/autocomplete` | 标签联想（`prefix`, `limit`） |

## 5.7 备份恢复与索引批处理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/manage/batch/list` | 分批读取文件数据（支持 `cursor`） |
| GET | `/api/manage/batch/settings` | 分批读取系统设置（用于备份） |
| POST | `/api/manage/batch/restore/chunk` | 分批写回文件/设置数据 |
| GET | `/api/manage/batch/index/config` | 获取索引重建配置（如分块大小） |
| POST | `/api/manage/batch/index/chunk` | 上传索引重建分块 |
| POST | `/api/manage/batch/index/finalize` | 完成索引重建分块组装 |

## 6. 说明与建议

- 该项目有历史兼容负担，接口返回风格并非完全统一。
- 若你要做 SDK，建议优先封装以下最稳定路径：
  - 上传：`/upload`、`/api/huggingface/batch-upload-commit`
  - 读取：`/file/{path}`
  - 管理列表：`/api/manage/list`
- 建议客户端对 429 / 5xx 做指数退避重试，并结合 `requestId` 做幂等。

