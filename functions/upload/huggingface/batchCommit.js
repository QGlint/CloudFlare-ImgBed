/**
 * ============================================================================
 * 自定义文件：HuggingFace 批量上传 API（含批次文件夹化）
 * ============================================================================
 *
 * 【上游同步说明 —— 请先读这里】
 * 本文件为自定义新增模块，上游更新时不会被覆盖，也不会与上游产生合并冲突。
 *
 * 它依赖的上游文件（上游重构时**只需要关注这几个是否改名/改签名**）：
 *   - functions/utils/sysConfig.js          fetchUploadConfig / fetchSecurityConfig
 *   - functions/utils/databaseAdapter.js    getDatabase
 *   - functions/utils/auth/userAuth.js      userAuthCheck（签名：env, url, request, permission）
 *   - functions/upload/uploadTools.js       endUpload / getUploadIp / getIPAddress
 *                                           / moderateContent / getImageDimensions
 *
 * 本目录下的自有文件（上游不会动）：
 *   - functions/utils/batchUpload/huggingfaceBatchAPI.js  批量 commit 能力
 *   - functions/utils/batchUpload/mimeType.js             MIME 推断
 *   - functions/utils/batchUpload/batchFolder.js          批次文件夹规则
 *
 * 【路由如何注册】
 * 不需要手改任何路由文件。deploy/worker/generate-routes.js 会自动扫描
 * functions/ 目录，发现本文件导出了 onRequestPost 后，自动注册为：
 *     POST /upload/huggingface/batchCommit
 * 重新生成路由：node deploy/worker/generate-routes.js
 *
 * 【核心能力】
 * 1. 一次请求上传多个文件，云端只产生 **1 个 commit**（不是 N 个）
 * 2. 批次文件夹化：所有文件归入同一个文件夹，云端布局清晰
 * 3. requestId 幂等：网络重试不会重复上传
 * ============================================================================
 */

import { fetchUploadConfig, fetchSecurityConfig } from '../../utils/sysConfig.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { userAuthCheck } from '../../utils/auth/userAuth.js';
import {
    endUpload,
    getUploadIp,
    getIPAddress,
    moderateContent,
    getImageDimensions
} from '../uploadTools.js';
import { HuggingFaceBatchAPI } from '../../utils/batchUpload/huggingfaceBatchAPI.js';
import { resolveMimeType } from '../../utils/batchUpload/mimeType.js';
import {
    normalizeBatchFolder,
    buildBatchFilePath,
    assertNoDuplicatePaths,
    buildDefaultBatchFolder
} from '../../utils/batchUpload/batchFolder.js';

// ---- 限额（可用环境变量覆盖） ----
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_TOTAL_SIZE = 80 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_FILE_SIZE = 20 * 1024 * 1024;

// 幂等键与批次记录的前缀。
// 刻意**不使用** `manage@` 前缀：上游 functions/api/manage/batch/settings.js 会把
// 所有 `manage@` 开头的键当作「系统设置」导出到备份中（仅排除 index*/session@*），
// 我们的键若放在该前缀下会污染备份、并随每次上传持续膨胀。
const IDEMPOTENCY_PREFIX = 'hfBatch@request@';
const BATCH_RECORD_PREFIX = 'hfBatch@manifest@';

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, authCode'
        }
    });
}

function parseLimit(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createApiError(code, message, status = 500, extra = {}) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    Object.assign(error, extra);
    return error;
}

/** base64 体积估算（去掉 data URL 前缀和空白） */
function normalizeContentBase64(contentBase64) {
    if (typeof contentBase64 !== 'string' || !contentBase64.trim()) {
        throw createApiError('INVALID_REQUEST', 'contentBase64 不能为空', 400);
    }

    const value = contentBase64.trim();
    const commaIndex = value.indexOf(',');
    const rawBase64 = value.startsWith('data:') && commaIndex !== -1
        ? value.slice(commaIndex + 1)
        : value;

    return rawBase64.replace(/\s+/g, '');
}

function estimateBase64Size(base64Data) {
    const len = base64Data.length;
    if (len === 0) {
        return 0;
    }
    const padding = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

function decodeBase64ToUint8Array(base64Data) {
    let binary;
    try {
        binary = atob(base64Data);
    } catch (_error) {
        throw createApiError('INVALID_REQUEST', '非法的 base64 内容', 400);
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** 逐段编码，保留 / 作为路径分隔符 */
function encodeFileIdForUrl(fileId) {
    return fileId
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');
}

function extractCommitId(commitResult) {
    return commitResult?.commit?.oid
        || commitResult?.commit?.id
        || commitResult?.commitOid
        || commitResult?.oid
        || null;
}

function selectHuggingFaceChannel(hfSettings, channelName = null) {
    const channels = hfSettings?.channels || [];
    if (channels.length === 0) {
        return null;
    }

    if (channelName) {
        return channels.find(channel => channel.name === channelName) || null;
    }

    return hfSettings.loadBalance?.enabled
        ? channels[Math.floor(Math.random() * channels.length)]
        : channels[0];
}

function toErrorResponse(error, fallbackCode = 'INTERNAL_ERROR') {
    const errorCode = error?.code;
    const status = error?.status;

    if (errorCode === 'INVALID_REQUEST') {
        return jsonResponse({
            success: false,
            code: 'INVALID_REQUEST',
            error: error.message
        }, status || 400);
    }

    if (status === 429) {
        return jsonResponse({
            success: false,
            code: 'RATE_LIMIT',
            error: error.message,
            retryAfterSeconds: error.retryAfterSeconds || null
        }, 429);
    }

    if (status === 401 || status === 403) {
        return jsonResponse({
            success: false,
            code: 'AUTH_ERROR',
            error: error.message
        }, 401);
    }

    // 上传成功但 commit 失败：告知已上传文件，便于安全重试
    if (error?.stage === 'commit') {
        return jsonResponse({
            success: false,
            code: 'PARTIAL_UPLOAD_NOT_COMMITTED',
            error: error.message,
            retryAfterSeconds: error.retryAfterSeconds || null,
            uploadedFiles: (error.uploadedFiles || []).map(item => ({
                name: item.name,
                filePath: item.filePath
            }))
        }, 502);
    }

    return jsonResponse({
        success: false,
        code: fallbackCode,
        error: error?.message || 'Unknown error'
    }, 500);
}

export async function onRequestOptions() {
    return jsonResponse({ success: true }, 200);
}

/**
 * POST /upload/huggingface/batchCommit
 *
 * 请求体：
 * {
 *   "folderName": "旅行照片",        // 可选；批次文件夹。留空则用时间戳自动生成
 *   "autoFolder": true,              // 可选；folderName 为空时是否自动建时间戳文件夹（默认 true）
 *   "channelName": "xxx",            // 可选；指定 HF 渠道
 *   "commitMessage": "...",          // 可选
 *   "requestId": "uuid",             // 可选；幂等键
 *   "files": [
 *     { "name": "a.jpg", "contentBase64": "data:image/jpeg;base64,...", "mimeType": "image/jpeg", "sha256": "..." }
 *   ]
 * }
 */
export async function onRequestPost(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    const maxFiles = parseLimit(env.HF_BATCH_MAX_FILES, DEFAULT_MAX_FILES);
    const maxTotalSize = parseLimit(env.HF_BATCH_MAX_TOTAL_SIZE, DEFAULT_MAX_TOTAL_SIZE);
    const maxSingleFileSize = parseLimit(env.HF_BATCH_MAX_SINGLE_FILE_SIZE, DEFAULT_MAX_SINGLE_FILE_SIZE);

    try {
        // ---- 鉴权：必须与上游保持一致，使用 'upload' 权限 ----
        const requiredPermission = 'upload';
        if (!await userAuthCheck(env, url, request, requiredPermission)) {
            return jsonResponse({
                success: false,
                code: 'AUTH_ERROR',
                error: 'Unauthorized'
            }, 401);
        }

        let body;
        try {
            body = await request.json();
        } catch (_error) {
            return jsonResponse({
                success: false,
                code: 'INVALID_REQUEST',
                error: '请求体必须是合法 JSON'
            }, 400);
        }

        const {
            folderName = '',
            autoFolder = true,
            channelName = null,
            files,
            commitMessage = null,
            requestId = null
        } = body || {};

        if (!Array.isArray(files) || files.length === 0) {
            return jsonResponse({
                success: false,
                code: 'INVALID_REQUEST',
                error: 'files 必须是非空数组'
            }, 400);
        }

        if (files.length > maxFiles) {
            return jsonResponse({
                success: false,
                code: 'INVALID_REQUEST',
                error: `文件数量超限，最多 ${maxFiles} 个`
            }, 400);
        }

        if (requestId !== null && requestId !== undefined) {
            if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
                return jsonResponse({
                    success: false,
                    code: 'INVALID_REQUEST',
                    error: 'requestId 必须是非空且不超过 128 字符的字符串'
                }, 400);
            }
        }

        // ---- 批次文件夹：用户指定优先，否则按时间戳自动生成 ----
        const normalizedFolder = normalizeBatchFolder(folderName, {
            autoGenerateWhenEmpty: autoFolder !== false
        });
        if (normalizedFolder) {
            url.searchParams.set('uploadFolder', normalizedFolder);
        }

        // ---- 幂等：同一 requestId 直接返回首次结果 ----
        const db = getDatabase(env);
        const idempotencyKey = requestId ? `${IDEMPOTENCY_PREFIX}${requestId}` : null;
        if (idempotencyKey) {
            const existing = await db.get(idempotencyKey);
            if (existing) {
                let payload;
                try {
                    payload = JSON.parse(existing);
                } catch (_error) {
                    payload = null;
                }

                if (!payload || typeof payload !== 'object') {
                    await db.delete(idempotencyKey);
                } else {
                    payload.idempotent = true;
                    return jsonResponse(payload, 200);
                }
            }
        }

        // ---- 渠道选择 ----
        const uploadConfig = await fetchUploadConfig(env);
        const hfSettings = uploadConfig?.huggingface;

        if (!hfSettings || !Array.isArray(hfSettings.channels) || hfSettings.channels.length === 0) {
            return jsonResponse({
                success: false,
                code: 'CHANNEL_NOT_FOUND',
                error: '未配置 HuggingFace 渠道'
            }, 400);
        }

        const hfChannel = selectHuggingFaceChannel(hfSettings, channelName);
        if (!hfChannel) {
            return jsonResponse({
                success: false,
                code: 'CHANNEL_NOT_FOUND',
                error: channelName
                    ? `未找到 HuggingFace 渠道：${channelName}`
                    : '没有可用的 HuggingFace 渠道'
            }, 400);
        }

        if (!hfChannel.token || !hfChannel.repo) {
            return jsonResponse({
                success: false,
                code: 'CHANNEL_NOT_FOUND',
                error: 'HuggingFace 渠道配置不完整（缺少 token 或 repo）'
            }, 400);
        }

        // ---- 逐个校验并准备文件 ----
        const uploadIp = getUploadIp(request);
        const uploadAddress = await getIPAddress(env, uploadIp);
        const now = Date.now();

        let totalEstimatedBytes = 0;
        const preparedFiles = [];

        for (let i = 0; i < files.length; i++) {
            const fileInput = files[i] || {};
            const base64Data = normalizeContentBase64(fileInput.contentBase64);
            const estimatedSize = estimateBase64Size(base64Data);

            if (estimatedSize <= 0) {
                throw createApiError('INVALID_REQUEST', `files[${i}] 内容为空`, 400);
            }
            if (estimatedSize > maxSingleFileSize) {
                throw createApiError(
                    'INVALID_REQUEST',
                    `files[${i}] 超过单文件大小上限（${maxSingleFileSize} 字节）`,
                    400
                );
            }

            totalEstimatedBytes += estimatedSize;
            if (totalEstimatedBytes > maxTotalSize) {
                throw createApiError(
                    'INVALID_REQUEST',
                    `文件总大小超过上限（${maxTotalSize} 字节）`,
                    400
                );
            }

            // 路径安全：批次文件夹 + 文件名，含穿越/保留前缀拦截
            const { fileName, fullPath } = buildBatchFilePath(normalizedFolder, fileInput.name);

            const mimeType = resolveMimeType(fileInput.mimeType, fileName, {
                dataUrlValue: fileInput.contentBase64
            });

            const bytes = decodeBase64ToUint8Array(base64Data);
            const fileBlob = new Blob([bytes], { type: mimeType });

            let imageDimensions = null;
            if (mimeType.startsWith('image/')) {
                try {
                    const headerArray = bytes.length > 65536 ? bytes.slice(0, 65536) : bytes;
                    imageDimensions = getImageDimensions(headerArray.buffer, mimeType);
                } catch (error) {
                    console.warn(`解析图片尺寸失败 ${fileName}:`, error.message);
                }
            }

            const fileSizeBytes = fileBlob.size;
            const metadata = {
                FileName: fileName,
                FileType: mimeType,
                FileSize: (fileSizeBytes / 1024 / 1024).toFixed(2),
                FileSizeBytes: fileSizeBytes,
                UploadIP: uploadIp,
                UploadAddress: uploadAddress,
                ListType: 'None',
                TimeStamp: now,
                Label: 'None',
                // 与既有目录字段保持一致，末尾带 /
                Directory: normalizedFolder === '' ? '' : `${normalizedFolder}/`,
                Tags: []
            };

            if (imageDimensions) {
                metadata.Width = imageDimensions.width;
                metadata.Height = imageDimensions.height;
            }

            preparedFiles.push({
                name: fileName,
                fullId: fullPath,
                filePath: fullPath,
                mimeType,
                fileBlob,
                contentBase64: base64Data,
                precomputedSha256: typeof fileInput.sha256 === 'string' && fileInput.sha256.trim()
                    ? fileInput.sha256.trim()
                    : null,
                metadata
            });
        }

        // 同批次重名会静默覆盖，直接报错
        assertNoDuplicatePaths(preparedFiles.map(file => file.fullId));

        // ---- 批量上传：所有文件聚合成 1 个 commit ----
        const huggingfaceBatchAPI = new HuggingFaceBatchAPI(
            hfChannel.token,
            hfChannel.repo,
            hfChannel.isPrivate || false
        );

        const commitSummary = typeof commitMessage === 'string' && commitMessage.trim()
            ? commitMessage.trim()
            : `批量上传 ${preparedFiles.length} 个文件${normalizedFolder ? ` 至 ${normalizedFolder}` : ''}`;

        const uploadResult = await huggingfaceBatchAPI.uploadFilesInSingleCommit(
            preparedFiles.map(file => ({
                name: file.name,
                file: file.fileBlob,
                filePath: file.filePath,
                precomputedSha256: file.precomputedSha256,
                contentBase64: file.contentBase64
            })),
            commitSummary
        );

        // ---- 写 metadata + 索引 ----
        const securityConfig = await fetchSecurityConfig(env);
        const moderateEnabled = securityConfig?.upload?.moderate?.enabled === true;

        const uploadContext = {
            env,
            waitUntil,
            uploadConfig,
            url
        };

        const responseFiles = [];
        for (const file of preparedFiles) {
            const metadata = file.metadata;
            metadata.Channel = 'HuggingFace';
            metadata.ChannelName = hfChannel.name || 'HuggingFace_env';
            metadata.HfRepo = hfChannel.repo;
            metadata.HfFilePath = file.filePath;
            metadata.HfToken = hfChannel.token;
            metadata.HfIsPrivate = hfChannel.isPrivate || false;
            metadata.HfFileUrl = huggingfaceBatchAPI.getFileURL(file.filePath);

            await db.put(file.fullId, '', { metadata });

            // 内容审查（与单文件上传行为保持一致）
            if (moderateEnabled) {
                try {
                    if (!hfChannel.isPrivate) {
                        metadata.Label = await moderateContent(env, metadata.HfFileUrl);
                    } else {
                        const encodedFileId = encodeFileIdForUrl(file.fullId);
                        metadata.Label = await moderateContent(env, `https://${url.hostname}/file/${encodedFileId}`);
                    }
                    await db.put(file.fullId, '', { metadata });
                } catch (error) {
                    console.warn(`内容审查失败 ${file.fullId}:`, error.message);
                }
            }

            waitUntil(endUpload(uploadContext, file.fullId, metadata));

            responseFiles.push({
                name: file.name,
                src: `/file/${encodeFileIdForUrl(file.fullId)}`,
                fullId: file.fullId
            });
        }

        const payload = {
            success: true,
            requestId: requestId || null,
            batchId: null,
            folder: normalizedFolder || null,
            commitId: extractCommitId(uploadResult.commitResult),
            channelName: hfChannel.name || null,
            repo: hfChannel.repo,
            count: responseFiles.length,
            files: responseFiles
        };

        // ---- 写入批次清单（manifest）----
        // 目的：让「一次上传」成为一个可回溯、可列出、可整批操作的单元。
        // 这是解决「云端布局乱、事后难以核对某一批」的关键记录。
        // 与幂等键共用独立前缀，不污染上游的 manage@ 设置导出。
        try {
            const batchId = requestId ? `req_${requestId}` : `b_${now}_${Math.random().toString(36).slice(2, 8)}`;
            const manifest = {
                batchId,
                folder: normalizedFolder || '',
                channelName: hfChannel.name || null,
                repo: hfChannel.repo,
                commitId: payload.commitId,
                createdAt: now,
                fileCount: responseFiles.length,
                totalBytes: preparedFiles.reduce((sum, file) => sum + (file.metadata.FileSizeBytes || 0), 0),
                files: preparedFiles.map(file => ({
                    fullId: file.fullId,
                    name: file.name,
                    size: file.metadata.FileSizeBytes || 0,
                    mimeType: file.mimeType
                }))
            };

            await db.put(`${BATCH_RECORD_PREFIX}${batchId}`, JSON.stringify(manifest));
            payload.batchId = batchId;
        } catch (manifestError) {
            // 清单写入失败不应让整次上传失败——文件已经上传成功。
            console.warn('写入批次清单失败:', manifestError.message);
        }

        if (idempotencyKey) {
            await db.put(idempotencyKey, JSON.stringify(payload));
        }

        return jsonResponse(payload, 200);

    } catch (error) {
        console.error('batch-upload-commit error:', error.message);
        return toErrorResponse(error);
    }
}
