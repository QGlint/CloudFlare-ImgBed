/**
 * HuggingFace 批量提交逻辑自测（不联网，用桩函数验证行为）
 * 运行：node test/huggingfaceBatch.test.mjs
 *
 * 验证重点：
 *  1. commitOperations 是否正确组装 NDJSON（一个 commit 携带多个文件操作）
 *  2. uploadFilesInSingleCommit 是否只发 1 次 commit（而非 N 次）
 *  3. LFS / 非 LFS 两条分支是否都走对
 *  4. commit 失败时是否带出 uploadedFiles（便于安全重试）
 */

import { HuggingFaceBatchAPI } from '../functions/utils/batchUpload/huggingfaceBatchAPI.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        pass++;
        console.log(`  PASS  ${label}`);
    } else {
        fail++;
        console.log(`  FAIL  ${label}`);
        console.log(`        期望: ${JSON.stringify(expected)}`);
        console.log(`        实际: ${JSON.stringify(actual)}`);
    }
}

// ---------- 构造测试替身 ----------
function makeBlob(content, type = 'image/jpeg') {
    return new Blob([new TextEncoder().encode(content)], { type });
}

// 记录所有 fetch 调用，用于断言请求次数与请求体
const fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });

    // preupload：返回非 LFS（直接 base64 提交）
    if (String(url).includes('/preupload/')) {
        return new Response(JSON.stringify({
            files: [{ uploadMode: 'regular' }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // commit 接口
    if (String(url).includes('/commit/')) {
        return new Response(JSON.stringify({
            commit: { oid: 'commit-abc-123' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // repo 存在性检查
    if (String(url).includes('/api/datasets/')) {
        return new Response('{}', { status: 200 });
    }

    return new Response('{}', { status: 200 });
};

// ---------- 测试 ----------
console.log('\n=== commitOperations：NDJSON 组装 ===');
{
    fetchCalls.length = 0;
    const api = new HuggingFaceBatchAPI('tok', 'user/repo');

    await api.commitOperations([
        { key: 'file', value: { path: 'a.jpg', content: 'AAA', encoding: 'base64' } },
        { key: 'file', value: { path: 'b.jpg', content: 'BBB', encoding: 'base64' } }
    ], '一次提交两个文件');

    check('只发起 1 次网络请求', fetchCalls.length, 1);

    const body = fetchCalls[0].init.body;
    const lines = body.split('\n');

    check('NDJSON 行数 = header + 2 文件', lines.length, 3);
    check('第 1 行为 header', JSON.parse(lines[0]).key, 'header');
    check('header 带提交说明', JSON.parse(lines[0]).value.summary, '一次提交两个文件');
    check('第 2 行为文件 a.jpg', JSON.parse(lines[1]).value.path, 'a.jpg');
    check('第 3 行为文件 b.jpg', JSON.parse(lines[2]).value.path, 'b.jpg');
    check('Content-Type 为 ndjson', fetchCalls[0].init.headers['Content-Type'], 'application/x-ndjson');
    check('携带鉴权头', fetchCalls[0].init.headers['Authorization'], 'Bearer tok');
}

console.log('\n=== blobToBase64：分块转换（大文件不炸栈）===');
{
    const api = new HuggingFaceBatchAPI('tok', 'user/repo');
    // 构造 1MB 数据，验证不会 Maximum call stack size exceeded
    const big = new Uint8Array(1024 * 1024).fill(65);
    const b64 = await api.blobToBase64(new Blob([big]));
    check('1MB 转换成功且非空', b64.length > 0, true);
    // base64 长度应为 4 的倍数
    check('base64 长度为 4 的倍数', b64.length % 4, 0);
}

console.log('\n=== uploadFilesInSingleCommit：N 个文件只产生 1 个 commit ===');
{
    fetchCalls.length = 0;
    const api = new HuggingFaceBatchAPI('tok', 'user/repo');

    const result = await api.uploadFilesInSingleCommit([
        { name: 'a.jpg', file: makeBlob('CONTENT_A'), filePath: '批次1/a.jpg' },
        { name: 'b.jpg', file: makeBlob('CONTENT_B'), filePath: '批次1/b.jpg' },
        { name: 'c.jpg', file: makeBlob('CONTENT_C'), filePath: '批次1/c.jpg' }
    ], '批量测试');

    const commitCalls = fetchCalls.filter(c => c.url.includes('/commit/'));
    check('3 个文件只产生 1 次 commit 请求', commitCalls.length, 1);

    const commitLines = commitCalls[0].init.body.split('\n');
    check('commit 体含 3 个文件操作', commitLines.length, 4);
    check('返回 success', result.success, true);
    check('返回文件数', result.files.length, 3);
    check('提取 commitId', result.commitResult.commit.oid, 'commit-abc-123');
    check('文件路径正确', result.files.map(f => f.filePath), ['批次1/a.jpg', '批次1/b.jpg', '批次1/c.jpg']);
}

console.log('\n=== LFS 分支 ===');
{
    fetchCalls.length = 0;
    const api = new HuggingFaceBatchAPI('tok', 'user/repo');

    // 覆盖 preupload 让第一个文件走 LFS
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        fetchCalls.push({ url: String(url), init });

        if (String(url).includes('/preupload/')) {
            return new Response(JSON.stringify({ files: [{ uploadMode: 'lfs' }] }), { status: 200 });
        }
        if (String(url).includes('info/lfs/objects/batch')) {
            return new Response(JSON.stringify({
                objects: [{ actions: { upload: { href: 'https://lfs.example/up' } } }]
            }), { status: 200 });
        }
        if (String(url).includes('/commit/')) {
            return new Response(JSON.stringify({ commit: { oid: 'lfs-commit' } }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    };

    // 预置 sha256，避免真实计算
    const result = await api.uploadFilesInSingleCommit([
        { name: 'big.bin', file: makeBlob('BIG'), filePath: 'x/big.bin', precomputedSha256: 'deadbeef' }
    ], 'LFS 测试');

    globalThis.fetch = origFetch;

    const commitCall = fetchCalls.find(c => c.url.includes('/commit/'));
    const commitOp = JSON.parse(commitCall.init.body.split('\n')[1]);
    check('LFS 分支生成 lfsFile 操作', commitOp.key, 'lfsFile');
    check('LFS 操作带 oid', commitOp.value.oid, 'deadbeef');
    check('返回 needsLfs 标记', result.files[0].needsLfs, true);
}

console.log('\n=== commit 失败时带出 uploadedFiles ===');
{
    fetchCalls.length = 0;
    const api = new HuggingFaceBatchAPI('tok', 'user/repo');

    globalThis.fetch = async (url, init = {}) => {
        fetchCalls.push({ url: String(url), init });
        if (String(url).includes('/preupload/')) {
            return new Response(JSON.stringify({ files: [{ uploadMode: 'regular' }] }), { status: 200 });
        }
        if (String(url).includes('/commit/')) {
            return new Response('server exploded', {
                status: 502,
                headers: { 'retry-after': '30' }
            });
        }
        return new Response('{}', { status: 200 });
    };

    let caught = null;
    try {
        await api.uploadFilesInSingleCommit([
            { name: 'a.jpg', file: makeBlob('A'), filePath: 'f/a.jpg' }
        ], '会失败');
    } catch (error) {
        caught = error;
    }

    check('抛出错误', caught !== null, true);
    check('标记 stage=commit', caught?.stage, 'commit');
    check('带出已上传文件', caught?.uploadedFiles?.length, 1);
    check('解析 retry-after', caught?.retryAfterSeconds, 30);
}

console.log('\n=== 参数校验 ===');
{
    const api = new HuggingFaceBatchAPI('tok', 'user/repo');
    let threw = false;
    try {
        await api.uploadFilesInSingleCommit([], 'empty');
    } catch (_e) {
        threw = true;
    }
    check('空数组抛错', threw, true);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));

if (fail > 0) {
    process.exit(1);
}
