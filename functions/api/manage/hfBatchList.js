/**
 * ============================================================================
 * 自定义文件：批次清单查询 API
 * ============================================================================
 *
 * 【上游同步说明】
 * 本文件为自定义新增模块，上游更新时不会被覆盖。
 *
 * 【用途】
 * 列出「批量上传」产生的每一批次记录，便于在管理端按批查看/核对/回溯。
 * 配合 functions/upload/huggingface/batchCommit.js 写入的 manifest 使用。
 *
 * 【路由】
 * 由 deploy/worker/generate-routes.js 自动注册为：
 *     GET /api/manage/hfBatchList
 * 鉴权继承 functions/api/manage/_middleware.js（管理端权限）。
 *
 * 【查询参数】
 * - limit  每批返回条数，默认 100，上限 1000
 * - cursor 分页游标
 *
 * 【为什么不复用 manage@ 前缀】
 * 上游 functions/api/manage/batch/settings.js 会把所有 manage@ 键当作系统设置
 * 导出到备份中，批次记录放在那里会污染备份。故使用独立前缀 hfBatch@。
 * ============================================================================
 */

import { getDatabase } from '../../utils/databaseAdapter.js';

const BATCH_RECORD_PREFIX = 'hfBatch@manifest@';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
}

export async function onRequestOptions() {
    return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    try {
        let limit = Number.parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT;
        if (limit > MAX_LIMIT) limit = MAX_LIMIT;
        if (limit < 1) limit = 1;

        const cursor = url.searchParams.get('cursor') || null;

        const db = getDatabase(env);

        const listOptions = {
            prefix: BATCH_RECORD_PREFIX,
            limit
        };
        if (cursor) {
            listOptions.cursor = cursor;
        }

        const listResult = await db.list(listOptions);

        if (!listResult || !Array.isArray(listResult.keys)) {
            return jsonResponse({ success: false, error: '数据库查询失败' }, 500);
        }

        const batches = [];
        for (const item of listResult.keys) {
            let manifest;
            try {
                const raw = await db.get(item.name);
                manifest = raw ? JSON.parse(raw) : null;
            } catch (_error) {
                manifest = null;
            }

            if (!manifest || typeof manifest !== 'object') {
                continue;
            }

            // 列表视图不返回完整文件清单，避免响应过大；用摘要即可
            batches.push({
                batchId: manifest.batchId || item.name.slice(BATCH_RECORD_PREFIX.length),
                folder: manifest.folder || '',
                channelName: manifest.channelName || null,
                repo: manifest.repo || null,
                commitId: manifest.commitId || null,
                createdAt: manifest.createdAt || null,
                fileCount: manifest.fileCount || 0,
                totalBytes: manifest.totalBytes || 0
            });
        }

        // 按时间倒序，最新批次在前
        batches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        return jsonResponse({
            success: true,
            batches,
            nextCursor: listResult.cursor || null,
            total: batches.length
        });

    } catch (error) {
        console.error('hfBatchList error:', error.message);
        return jsonResponse({ success: false, error: error.message }, 500);
    }
}
