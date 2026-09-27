# 上游同步手册（UPSTREAM-SYNC）

> **这份文档解决一个问题：以后从上游更新代码时，怎样保证自定义功能不丢、不冲突。**

## 一、为什么以前会「合并把内容丢完」

本仓库经历过一次严重事故：从上游同步时，`dev` 分支的自定义内容被清空。原因不是操作失误，而是**分支分叉太深**：

- 自定义分支有 **778** 个上游没有的提交
- 上游有 **1086** 个自定义分支没有的提交
- 共同祖先非常老（`6d67b3a`）

更关键的是，上游做过一次**目录大重构**：

| 内容 | 重构前（旧结构） | 重构后（当前上游） |
| --- | --- | --- |
| 部署脚本 | `server/` | `deploy/server/` |
| 工具模块 | `functions/utils/xxx.js` | `functions/utils/auth/`、`functions/utils/storage/` 等子目录 |
| 前端产物 | `index.html` + `js/` + `css/` | `frontend-dist/` |

当两边的同一个文件都被"改过"，git 的自动合并必须选一边。选错就会把另一边整个抹掉——这就是内容丢失的机制。

**结论：不要再用 `git merge` 去合这两条分叉的历史。改成"以 main 为基线 + 自定义改动集中在新文件"。**

---

## 二、自定义文件的清单（上游不会碰这些）

这些文件是**我们自己新增的**，上游仓库里不存在，因此上游更新时**永远不会与它们冲突**：

| 文件 | 作用 |
| --- | --- |
| `functions/utils/batchUpload/mimeType.js` | MIME 类型推断（修正 Content-Type，避免浏览器误下载） |
| `functions/utils/batchUpload/batchFolder.js` | **批次文件夹规则**：用户指定文件夹名 + 路径安全校验 |
| `functions/utils/batchUpload/huggingfaceBatchAPI.js` | HF 批量提交能力（继承上游类，一次 commit 传多文件） |
| `functions/upload/huggingface/batchCommit.js` | **批量上传 API 路由**（`POST /upload/huggingface/batchCommit`） |
| `functions/api/manage/hfBatchList.js` | **批次清单查询**（`GET /api/manage/hfBatchList`） |
| `test/batchFolder.test.mjs` | 批次文件夹与路径安全的单元测试 |
| `test/huggingfaceBatch.test.mjs` | 批量提交逻辑与 NDJSON 组装测试 |
| `test/batchCommit.e2e.mjs` | 端到端流程测试 |
| `test/batchManifest.test.mjs` | 批次清单与键前缀安全测试 |
| `test/indexLoadAnalysis.mjs` | 索引操作压力分析（设计参考，非断言测试） |

> 设计要点：`huggingfaceBatchAPI.js` 用**继承**而不是改上游类的源码。
> 这样 `functions/utils/storage/huggingfaceAPI.js` 一行都没被改过，上游怎么重构它都不会产生冲突。

### 自定义的 KV 键前缀（不属于上游命名空间）

| 前缀 | 用途 |
| --- | --- |
| `hfBatch@request@<requestId>` | 批量上传的幂等键 |
| `hfBatch@manifest@<batchId>` | 批次清单，记录每批包含哪些文件 |

**为什么不用 `manage@` 前缀**：上游 `functions/api/manage/batch/settings.js`
会把所有 `manage@` 开头的键当作「系统设置」导出到备份中（仅排除 `index*` 与 `session@*`）。
若把自定义键放进该前缀，会让每次批量上传都往备份里塞一条无用记录。
`test/batchManifest.test.mjs` 对此有反向验证（确认旧前缀确实会被导出）。

> 设计取舍与后续可选项见 [docs/CUSTOMIZATION-DESIGN.md](docs/CUSTOMIZATION-DESIGN.md)。

---

## 三、对上游文件的改动（全部为零）

**当前对上游文件没有任何修改。** 这是刻意设计的结果。

新增路由之所以能生效，是因为 `deploy/worker/generate-routes.js` 会自动扫描 `functions/` 目录：

- 发现某个 `.js` 文件导出了 `onRequest*` → 自动注册为路由
- `utils/` 及其子目录被跳过（视为工具模块，不参与路由）

所以 `deploy/worker/index.js`（文件头写明"自动生成，请勿手动编辑"）**不需要手改**，也不会成为冲突点。

---

## 四、上游同步标准流程

每次要跟进上游更新时，照这个顺序做：

```bash
# 1. 确保远程最新
git fetch origin

# 2. 确认当前在自定义分支
git branch --show-current        # 应为 dev

# 3. 先看上游到底改了什么，特别关注"依赖接口"那一节列出的文件
git log --oneline HEAD..origin/main
git diff --stat HEAD...origin/main -- functions/utils functions/upload

# 4. 合并（此时你只有新增文件，冲突面应当极小或为零）
git merge origin/main

# 5. 无论有无冲突，都必须验证自定义功能还在
node test/batchFolder.test.mjs
node deploy/worker/generate-routes.js
git diff --stat deploy/worker/index.js   # 应包含 batchCommit 路由

# 6. 确认路由已注册
#    期望看到：/upload/huggingface/batchCommit
grep -n "batchCommit" deploy/worker/index.js
```

**第 5、6 步不要跳过。** 这是唯一能立刻发现"功能被合并抹掉"的检查。

---

## 五、上游重构时最需要留意的依赖接口

如果上游改动下列内容，自定义模块可能需要跟着调整（这是唯一的维护负担）：

| 上游文件 | 使用的导出 | 调用的签名 |
| --- | --- | --- |
| `functions/utils/sysConfig.js` | `fetchUploadConfig`、`fetchSecurityConfig` | `fetchUploadConfig(env)`、`fetchSecurityConfig(env)` |
| `functions/utils/databaseAdapter.js` | `getDatabase` | `getDatabase(env)`、`db.put(key, value, { metadata })` |
| `functions/utils/auth/userAuth.js` | `userAuthCheck` | `userAuthCheck(env, url, request, permission)` |
| `functions/upload/uploadTools.js` | `endUpload`、`getUploadIp`、`getIPAddress`、`moderateContent`、`getImageDimensions` | 见下 |
| `functions/utils/storage/huggingfaceAPI.js` | 类 `HuggingFaceAPI` 及其方法 | 见下 |

`uploadTools.js` 的当前签名：

```js
endUpload(context, fileId, metadata)        // context = { env, waitUntil, uploadConfig, url }
getUploadIp(request)
getIPAddress(env, ip)                       // 注意是 env 在前
moderateContent(env, url)
getImageDimensions(buffer, fileType)
```

`HuggingFaceAPI` 中被继承复用的基础方法（**上游若删改这些，批量功能会失效**）：

```js
sha256(blob)
preupload(filePath, fileSize, fileSample)
lfsBatch(oid, fileSize)
uploadToLFS(uploadAction, file, oid)
createRepoIfNotExists()
getFileURL(filePath)
// 属性：this.token / this.repo / this.isPrivate / this.baseURL
```

> 提示：上游历史上把 `getIPAddress` 的签名从 `(ip)` 改成了 `(env, ip)`。
> 这类签名变化是最容易在合并时"静默通过编译、运行时才报错"的坑，务必用第 5 步的测试兜住。

---

## 六、批量上传 API 说明

**接口**：`POST /upload/huggingface/batchCommit`
**鉴权**：与单文件上传一致，需要 `upload` 权限

请求体：

```json
{
  "folderName": "旅行照片",
  "autoFolder": true,
  "channelName": "可选的渠道名",
  "commitMessage": "可选的提交说明",
  "requestId": "可选的幂等键",
  "files": [
    {
      "name": "a.jpg",
      "contentBase64": "data:image/jpeg;base64,....",
      "mimeType": "image/jpeg",
      "sha256": "可选的预计算哈希"
    }
  ]
}
```

响应体：

```json
{
  "success": true,
  "folder": "旅行照片",
  "commitId": "....",
  "count": 3,
  "files": [
    { "name": "a.jpg", "src": "/file/%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/a.jpg", "fullId": "旅行照片/a.jpg" }
  ]
}
```

### 云端布局（这是重点）

开启批次文件夹后，云端是一个批次一个文件夹：

```
旅行照片/
  ├── a.jpg
  ├── b.jpg
  └── c.jpg
20260210-153012/          ← 未指定文件夹名时自动按时间戳生成
  ├── x.jpg
  └── y.jpg
```

### 环境变量（可选，用于调整限量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HF_BATCH_MAX_FILES` | 50 | 单次最多文件数 |
| `HF_BATCH_MAX_TOTAL_SIZE` | 83886080（80MB） | 单次总大小上限（字节） |
| `HF_BATCH_MAX_SINGLE_FILE_SIZE` | 20971520（20MB） | 单文件大小上限（字节） |

---

## 七、内置的安全措施

`batchFolder.js` 已拦截以下风险，并有单元测试覆盖：

- **目录穿越**：`../`、`..`、`.` 一律拒绝
- **保留前缀**：`manage@` 开头会被拒绝（该前缀被索引/元数据使用）
- **文件名注入**：文件名中带 `/` 或 `\` 会被拒绝
- **同批次重名**：直接报错而不是静默覆盖（静默覆盖等于丢数据）
- **大小写重名**：按不敏感处理，避免不同后端行为不一致
- **Windows 非法字符**：`: * ? " < > |` 会被替换为 `_`
- **层级与长度**：文件夹最多 6 层、每段最多 64 字符
