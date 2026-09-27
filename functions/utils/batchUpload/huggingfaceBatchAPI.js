/**
 * ============================================================================
 * 自定义文件：HuggingFace 批量上传能力（子类扩展，不改上游文件）
 * ============================================================================
 *
 * 【上游同步说明】
 * 本文件为自定义新增模块，上游更新时不会被覆盖，也不会与上游冲突。
 * 它通过「继承」上游的 HuggingFaceAPI 来扩展批量能力，因此：
 *   - functions/utils/storage/huggingfaceAPI.js 一行都不需要改
 *   - 上游无论怎么重构这个类，只要 preupload / lfsBatch / uploadToLFS
 *     / sha256 / createRepoIfNotExists / getFileURL 这些基础方法还在，
 *     本模块就能继续工作
 *
 * 【实现原理】
 * HuggingFace 官方没有「一次请求上传多个文件」的 HTTP 接口，但 commit
 * 接口支持 NDJSON：一个请求体里可以带多行操作（header + N 个 file/lfsFile）。
 * 因此批量上传 = 逐个文件 preupload/LFS 上传，最后聚合成「一次 commit」。
 * 这样云端只会产生 1 个 commit，而不是 N 个，既快又不会把仓库历史刷乱。
 * ============================================================================
 */

import { HuggingFaceAPI } from '../storage/huggingfaceAPI.js';

/**
 * 批量提交用的错误构造器
 * 带上 stage 字段，方便上层区分「是上传阶段失败」还是「commit 阶段失败」
 */
function buildBatchRequestError(message, status, detail, extra = {}) {
    const error = new Error(
        detail ? `${message}: ${status} - ${detail}` : `${message}: ${status}`
    );
    error.status = status;
    Object.assign(error, extra);
    return error;
}

export class HuggingFaceBatchAPI extends HuggingFaceAPI {
    /**
     * Blob -> base64（分块转换，避免大文件触发调用栈溢出）
     * 注意：不能用 String.fromCharCode(...bytes)，大文件会炸栈。
     */
    async blobToBase64(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const chunkSize = 4096;
        const parts = [];
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
            let chunkString = '';
            for (let j = 0; j < chunk.length; j++) {
                chunkString += String.fromCharCode(chunk[j]);
            }
            parts.push(chunkString);
        }
        return btoa(parts.join(''));
    }

    /**
     * 取文件前 N 字节的 base64 样本（preupload 需要）
     */
    async getBlobSampleBase64(blob, byteCount = 512) {
        const sampleBytes = new Uint8Array(await blob.slice(0, byteCount).arrayBuffer());
        let binary = '';
        for (let i = 0; i < sampleBytes.length; i++) {
            binary += String.fromCharCode(sampleBytes[i]);
        }
        return btoa(binary);
    }

    /**
     * 提交一组 NDJSON 操作（批量能力的核心）
     * 一个 commit 请求携带多个文件操作，云端只产生 1 个 commit。
     */
    async commitOperations(operations, commitMessage = 'Commit files') {
        const url = `${this.baseURL}/api/datasets/${this.repo}/commit/main`;

        if (!Array.isArray(operations) || operations.length === 0) {
            throw new Error('No commit operations provided');
        }

        const body = [
            JSON.stringify({
                key: 'header',
                value: { summary: commitMessage }
            }),
            ...operations.map(operation => JSON.stringify(operation))
        ].join('\n');

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/x-ndjson'
            },
            body
        });

        if (!response.ok) {
            const detail = await response.text();
            const retryAfterHeader = response.headers.get('retry-after');
            const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;
            throw buildBatchRequestError('Commit failed', response.status, detail, {
                retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null
            });
        }

        return await response.json();
    }

    /**
     * 为单个文件准备 commit 操作（LFS 或直接 base64）
     * 不产生 commit，只把「待提交的操作」准备好。
     */
    async prepareUploadOperation(file, filePath, options = {}) {
        const { precomputedSha256 = null, contentBase64 = null } = options;

        const sample = await this.getBlobSampleBase64(file, 512);
        const preuploadResult = await this.preupload(filePath, file.size, sample);
        const fileInfo = preuploadResult.files?.[0];
        const needsLfs = fileInfo?.uploadMode === 'lfs';

        if (needsLfs) {
            let oid;
            if (precomputedSha256) {
                oid = precomputedSha256;
            } else {
                oid = await this.sha256(file);
            }

            const batchResult = await this.lfsBatch(oid, file.size);
            const obj = batchResult.objects?.[0];
            if (obj?.error) {
                throw new Error(`LFS error: ${obj.error.message}`);
            }

            if (obj?.actions?.upload) {
                await this.uploadToLFS(obj.actions.upload, file, oid);
            }

            return {
                oid,
                fileSize: file.size,
                needsLfs: true,
                operation: {
                    key: 'lfsFile',
                    value: {
                        path: filePath,
                        algo: 'sha256',
                        size: file.size,
                        oid
                    }
                }
            };
        }

        const encodedContent = contentBase64 || await this.blobToBase64(file);
        return {
            oid: null,
            fileSize: file.size,
            needsLfs: false,
            operation: {
                key: 'file',
                value: {
                    path: filePath,
                    content: encodedContent,
                    encoding: 'base64'
                }
            }
        };
    }

    /**
     * 批量上传：多个文件聚合成一次 commit
     * @param {Array} files - [{ file, filePath, precomputedSha256, contentBase64, name }]
     * @param {string} commitMessage
     */
    async uploadFilesInSingleCommit(files, commitMessage = 'Batch upload files') {
        if (!Array.isArray(files) || files.length === 0) {
            throw new Error('files must be a non-empty array');
        }

        if (!await this.createRepoIfNotExists()) {
            throw new Error('Failed to create or access repository');
        }

        const operations = [];
        const uploadedFiles = [];

        for (const fileItem of files) {
            const {
                file,
                filePath,
                precomputedSha256 = null,
                contentBase64 = null,
                name = ''
            } = fileItem;

            if (!file || !filePath) {
                throw new Error('Invalid file item: file and filePath are required');
            }

            const prepared = await this.prepareUploadOperation(file, filePath, {
                precomputedSha256,
                contentBase64
            });

            operations.push(prepared.operation);
            uploadedFiles.push({
                name,
                filePath,
                fileSize: prepared.fileSize,
                oid: prepared.oid,
                needsLfs: prepared.needsLfs,
                fileUrl: this.getFileURL(filePath)
            });
        }

        try {
            // 用带重试与降级的提交：HF 对 commit 请求设 60 秒超时，
            // 且会返回 429 限流。官方 huggingface_hub 的做法是
            // 「超时/失败就缩小批量再试」，这里采用同样策略。
            const commitResult = await this.commitOperationsWithBackoff(operations, commitMessage);
            return {
                success: true,
                commitResult,
                files: uploadedFiles
            };
        } catch (error) {
            // 上传已完成、只是 commit 失败：把已上传的文件带回去，便于重试
            error.stage = error.stage || 'commit';
            error.uploadedFiles = uploadedFiles;
            throw error;
        }
    }

    /**
     * 带退避与降级拆分的提交
     *
     * 依据（HF 官方）：
     *  - commit 请求有 60 秒超时（docs/hub/storage-limits）
     *  - 限流返回 429，带 Retry-After
     *  - 官方 huggingface_hub 的做法：提交失败就「缩小批量 + 拆分 + 重试」
     *    （issue #4331，目标单次 commit 耗时 <40 秒）
     *
     * 策略：
     *  1. 429 / 5xx / 超时 → 按 Retry-After 或指数退避等待后重试
     *  2. 重试仍失败且操作数 >1 → 把操作拆成两半分别提交（降低单请求耗时）
     *
     * @returns {Promise<Object>} 与 commitOperations 相同的返回结构
     */
    async commitOperationsWithBackoff(operations, commitMessage, options = {}) {
        const {
            maxRetries = 3,
            baseDelayMs = 1000,
            maxDelayMs = 30000
        } = options;

        if (!Array.isArray(operations) || operations.length === 0) {
            throw new Error('No commit operations provided');
        }

        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.commitOperations(operations, commitMessage);
            } catch (error) {
                lastError = error;

                const status = error?.status;
                // 仅对「可重试」的错误做退避：限流与网关类错误
                const retryable = status === 429 || (status >= 500 && status < 600) || status === undefined;

                if (!retryable || attempt === maxRetries) {
                    break;
                }

                // 优先使用服务端给的 Retry-After
                let delayMs = Number.isFinite(error?.retryAfterSeconds)
                    ? error.retryAfterSeconds * 1000
                    : baseDelayMs * Math.pow(2, attempt);
                delayMs = Math.min(delayMs, maxDelayMs);

                console.warn(
                    `HF commit 第 ${attempt + 1} 次失败（status=${status}），${delayMs}ms 后重试`
                );
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        // 退避重试仍未成功：若操作数 >1，拆成两半分别提交，
        // 以降低「单次 commit 耗时」，规避 60 秒超时。
        if (operations.length > 1) {
            const mid = Math.ceil(operations.length / 2);
            console.warn(
                `HF commit 持续失败，将 ${operations.length} 个操作拆分为 ` +
                `${mid} + ${operations.length - mid} 分批提交`
            );

            const first = await this.commitOperationsWithBackoff(
                operations.slice(0, mid),
                `${commitMessage} (part 1)`,
                { maxRetries, baseDelayMs, maxDelayMs }
            );
            const second = await this.commitOperationsWithBackoff(
                operations.slice(mid),
                `${commitMessage} (part 2)`,
                { maxRetries, baseDelayMs, maxDelayMs }
            );

            // 两次提交都成功：返回后一次的结果（commitId 取后者）
            return {
                ...second,
                splitCommits: 2,
                firstCommitResult: first
            };
        }

        throw lastError;
    }
}
