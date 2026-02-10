import { HuggingFaceAPI } from '../../utils/huggingfaceAPI.js';
import { fetchUploadConfig, fetchSecurityConfig } from '../../utils/sysConfig.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import {
    endUpload,
    getUploadIp,
    getIPAddress,
    moderateContent,
    getImageDimensions
} from '../../upload/uploadTools.js';
import { userAuthCheck } from '../../utils/userAuth.js';

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_TOTAL_SIZE = 80 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_FILE_SIZE = 20 * 1024 * 1024;

function createApiError(code, message, status = 500, extra = {}) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    Object.assign(error, extra);
    return error;
}

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

function normalizeUploadFolder(uploadFolder) {
    if (uploadFolder === null || uploadFolder === undefined) {
        return '';
    }

    const normalized = String(uploadFolder)
        .trim()
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/{2,}/g, '/');

    if (!normalized) {
        return '';
    }

    const segments = normalized.split('/');
    for (const segment of segments) {
        if (!segment || segment === '.' || segment === '..') {
            throw createApiError('INVALID_REQUEST', 'Invalid uploadFolder: contains illegal path segment', 400);
        }
        if (segment.startsWith('manage@')) {
            throw createApiError('INVALID_REQUEST', 'Invalid uploadFolder: reserved segment name', 400);
        }
    }

    return normalized;
}

function normalizeFileName(name) {
    if (typeof name !== 'string') {
        throw createApiError('INVALID_REQUEST', 'File name must be a string', 400);
    }

    const trimmed = name.trim();
    if (!trimmed) {
        throw createApiError('INVALID_REQUEST', 'File name cannot be empty', 400);
    }
    if (trimmed.length > 255) {
        throw createApiError('INVALID_REQUEST', 'File name is too long', 400);
    }
    if (trimmed === '.' || trimmed === '..') {
        throw createApiError('INVALID_REQUEST', 'File name cannot be . or ..', 400);
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        throw createApiError('INVALID_REQUEST', 'File name cannot contain path separators', 400);
    }
    if (trimmed.startsWith('manage@')) {
        throw createApiError('INVALID_REQUEST', 'File name cannot use reserved prefix', 400);
    }

    return trimmed;
}

function normalizeMimeType(mimeType) {
    if (typeof mimeType !== 'string' || !mimeType.trim()) {
        return 'application/octet-stream';
    }
    return mimeType.trim();
}

function normalizeContentBase64(contentBase64) {
    if (typeof contentBase64 !== 'string' || !contentBase64.trim()) {
        throw createApiError('INVALID_REQUEST', 'contentBase64 is required', 400);
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
        throw createApiError('INVALID_REQUEST', 'Invalid base64 content', 400);
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

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

export async function onRequestPost(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);
    context.url = url;

    const maxFiles = parseLimit(env.HF_BATCH_MAX_FILES, DEFAULT_MAX_FILES);
    const maxTotalSize = parseLimit(env.HF_BATCH_MAX_TOTAL_SIZE, DEFAULT_MAX_TOTAL_SIZE);
    const maxSingleFileSize = parseLimit(env.HF_BATCH_MAX_SINGLE_FILE_SIZE, DEFAULT_MAX_SINGLE_FILE_SIZE);

    try {
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
                error: 'Request body must be valid JSON'
            }, 400);
        }

        const {
            uploadFolder = '',
            channelName = null,
            files,
            commitMessage = null,
            requestId = null
        } = body || {};

        if (!Array.isArray(files) || files.length === 0) {
            return jsonResponse({
                success: false,
                code: 'INVALID_REQUEST',
                error: 'files must be a non-empty array'
            }, 400);
        }

        if (files.length > maxFiles) {
            return jsonResponse({
                success: false,
                code: 'INVALID_REQUEST',
                error: `Too many files, max allowed: ${maxFiles}`
            }, 400);
        }

        if (requestId !== null && requestId !== undefined) {
            if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
                return jsonResponse({
                    success: false,
                    code: 'INVALID_REQUEST',
                    error: 'requestId must be a non-empty string up to 128 chars'
                }, 400);
            }
        }

        const normalizedFolder = normalizeUploadFolder(uploadFolder);
        if (normalizedFolder) {
            url.searchParams.set('uploadFolder', normalizedFolder);
        }

        const db = getDatabase(env);
        const idempotencyKey = requestId ? `manage@hf_batch_request@${requestId}` : null;
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

        const uploadConfig = await fetchUploadConfig(env, context);
        const hfSettings = uploadConfig?.huggingface;

        if (!hfSettings || !Array.isArray(hfSettings.channels) || hfSettings.channels.length === 0) {
            return jsonResponse({
                success: false,
                code: 'CHANNEL_NOT_FOUND',
                error: 'No HuggingFace channel configured'
            }, 400);
        }

        const hfChannel = selectHuggingFaceChannel(hfSettings, channelName);
        if (!hfChannel) {
            return jsonResponse({
                success: false,
                code: 'CHANNEL_NOT_FOUND',
                error: channelName
                    ? `HuggingFace channel not found: ${channelName}`
                    : 'No available HuggingFace channel'
            }, 400);
        }

        if (!hfChannel.token || !hfChannel.repo) {
            return jsonResponse({
                success: false,
                code: 'CHANNEL_NOT_FOUND',
                error: 'HuggingFace channel not properly configured'
            }, 400);
        }

        const uploadIp = getUploadIp(request);
        const uploadAddress = await getIPAddress(uploadIp);
        const now = Date.now();

        let totalEstimatedBytes = 0;
        const fullIdSet = new Set();
        const preparedFiles = [];

        for (let i = 0; i < files.length; i++) {
            const fileInput = files[i] || {};
            const fileName = normalizeFileName(fileInput.name);
            const mimeType = normalizeMimeType(fileInput.mimeType);
            const base64Data = normalizeContentBase64(fileInput.contentBase64);
            const estimatedSize = estimateBase64Size(base64Data);

            if (estimatedSize <= 0) {
                throw createApiError('INVALID_REQUEST', `files[${i}] has empty content`, 400);
            }
            if (estimatedSize > maxSingleFileSize) {
                throw createApiError('INVALID_REQUEST', `files[${i}] exceeds max single file size limit (${maxSingleFileSize} bytes)`, 400);
            }

            totalEstimatedBytes += estimatedSize;
            if (totalEstimatedBytes > maxTotalSize) {
                throw createApiError('INVALID_REQUEST', `Total files size exceeds limit (${maxTotalSize} bytes)`, 400);
            }

            const fullId = normalizedFolder ? `${normalizedFolder}/${fileName}` : fileName;
            if (fullId.startsWith('manage@')) {
                throw createApiError('INVALID_REQUEST', `files[${i}] uses reserved path`, 400);
            }
            if (fullIdSet.has(fullId)) {
                throw createApiError('INVALID_REQUEST', `Duplicate target path in files: ${fullId}`, 400);
            }
            fullIdSet.add(fullId);

            const bytes = decodeBase64ToUint8Array(base64Data);
            const fileBlob = new Blob([bytes], { type: mimeType });

            let imageDimensions = null;
            if (mimeType.startsWith('image/')) {
                try {
                    const headerArray = bytes.length > 65536 ? bytes.slice(0, 65536) : bytes;
                    imageDimensions = getImageDimensions(headerArray.buffer, mimeType);
                } catch (error) {
                    console.warn(`Failed to parse image dimensions for ${fileName}:`, error.message);
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
                Directory: normalizedFolder === '' ? '' : `${normalizedFolder}/`,
                Tags: []
            };

            if (imageDimensions) {
                metadata.Width = imageDimensions.width;
                metadata.Height = imageDimensions.height;
            }

            preparedFiles.push({
                name: fileName,
                fullId,
                filePath: fullId,
                mimeType,
                fileBlob,
                contentBase64: base64Data,
                precomputedSha256: typeof fileInput.sha256 === 'string' && fileInput.sha256.trim()
                    ? fileInput.sha256.trim()
                    : null,
                metadata
            });
        }

        const huggingfaceAPI = new HuggingFaceAPI(hfChannel.token, hfChannel.repo, hfChannel.isPrivate || false);
        const commitSummary = typeof commitMessage === 'string' && commitMessage.trim()
            ? commitMessage.trim()
            : `Batch upload ${preparedFiles.length} files`;

        const uploadResult = await huggingfaceAPI.uploadFilesInSingleCommit(
            preparedFiles.map(file => ({
                name: file.name,
                file: file.fileBlob,
                filePath: file.filePath,
                precomputedSha256: file.precomputedSha256,
                contentBase64: file.contentBase64
            })),
            commitSummary
        );

        const securityConfig = await fetchSecurityConfig(env);
        const moderateEnabled = securityConfig?.upload?.moderate?.enabled === true;

        const responseFiles = [];
        for (const file of preparedFiles) {
            const metadata = file.metadata;
            metadata.Channel = 'HuggingFace';
            metadata.ChannelName = hfChannel.name || 'HuggingFace_env';
            metadata.HfRepo = hfChannel.repo;
            metadata.HfFilePath = file.filePath;
            metadata.HfToken = hfChannel.token;
            metadata.HfIsPrivate = hfChannel.isPrivate || false;
            metadata.HfFileUrl = huggingfaceAPI.getFileURL(file.filePath);

            await db.put(file.fullId, '', { metadata });

            if (moderateEnabled) {
                try {
                    if (!hfChannel.isPrivate) {
                        metadata.Label = await moderateContent(env, metadata.HfFileUrl);
                    } else {
                        const encodedFileId = encodeFileIdForUrl(file.fullId);
                        const moderateUrl = `https://${url.hostname}/file/${encodedFileId}`;
                        metadata.Label = await moderateContent(env, moderateUrl);
                    }
                    await db.put(file.fullId, '', { metadata });
                } catch (error) {
                    console.warn(`Moderation failed for ${file.fullId}:`, error.message);
                }
            }

            waitUntil(endUpload(context, file.fullId, metadata));

            responseFiles.push({
                name: file.name,
                src: `/file/${encodeFileIdForUrl(file.fullId)}`,
                fullId: file.fullId
            });
        }

        const payload = {
            success: true,
            requestId: requestId || null,
            commitId: extractCommitId(uploadResult.commitResult),
            channelName: hfChannel.name || null,
            repo: hfChannel.repo,
            files: responseFiles
        };

        if (idempotencyKey) {
            await db.put(idempotencyKey, JSON.stringify(payload));
        }

        return jsonResponse(payload, 200);
    } catch (error) {
        console.error('batch-upload-commit error:', error.message);
        return toErrorResponse(error);
    }
}
