/**
 * 提交退避与降级拆分测试
 * 运行：node test/commitBackoff.test.mjs
 *
 * 依据 HF 官方限制：
 *  - commit 请求 60 秒超时（docs/hub/storage-limits）
 *  - 限流返回 429 + Retry-After（docs/hub/rate-limits）
 *  - 官方做法：失败就「缩小批量 + 拆分 + 重试」（huggingface_hub issue #4331）
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

const ops = n => Array.from({ length: n }, (_, i) => ({
    key: 'file',
    value: { path: `f${i}.jpg`, content: 'AAA', encoding: 'base64' }
}));

// 加速测试：把退避延迟压到极小
const FAST = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 };

console.log('\n=== 场景 1：首次即成功，不重试 ===');
{
    let calls = 0;
    const api = new HuggingFaceBatchAPI('tok', 'u/r');
    api.commitOperations = async () => { calls++; return { commit: { oid: 'ok' } }; };

    const r = await api.commitOperationsWithBackoff(ops(3), 'msg', FAST);
    check('只调用 1 次', calls, 1);
    check('返回 commitId', r.commit.oid, 'ok');
    check('未发生拆分', r.splitCommits, undefined);
}

console.log('\n=== 场景 2：429 限流后成功（用 Retry-After）===');
{
    let calls = 0;
    const api = new HuggingFaceBatchAPI('tok', 'u/r');
    api.commitOperations = async () => {
        calls++;
        if (calls === 1) {
            const e = new Error('rate limited');
            e.status = 429;
            e.retryAfterSeconds = 0.01; // 极小等待
            throw e;
        }
        return { commit: { oid: 'after-retry' } };
    };

    const r = await api.commitOperationsWithBackoff(ops(3), 'msg', FAST);
    check('重试后成功', r.commit.oid, 'after-retry');
    check('共调用 2 次', calls, 2);
}

console.log('\n=== 场景 3：持续 5xx，拆分后成功 ===');
{
    const batches = [];
    const api = new HuggingFaceBatchAPI('tok', 'u/r');
    api.commitOperations = async (operations, msg) => {
        batches.push({ count: operations.length, msg });
        // 4 个操作整体提交总是失败；小批量则成功
        if (operations.length > 2) {
            const e = new Error('bad gateway');
            e.status = 502;
            throw e;
        }
        return { commit: { oid: 'split-ok' } };
    };

    const r = await api.commitOperationsWithBackoff(ops(4), 'msg', FAST);
    check('最终成功', r.commit.oid, 'split-ok');
    check('标记发生拆分', r.splitCommits, 2);

    // 验证拆分确实发生：出现了「小批量（≤2）且带 part 后缀」的提交
    const splitAttempts = batches.filter(b => b.count <= 2 && b.msg.includes('(part'));
    check('拆分后按小批量提交', splitAttempts.length > 0, true);
    check('拆分的两批大小合计为 4',
        splitAttempts.filter(b => b.msg.includes('(part 1)')).length +
        splitAttempts.filter(b => b.msg.includes('(part 2)')).length > 0, true);
    check('不再出现大批量(4)成功提交', batches.some(b => b.count === 4 && b.msg === 'msg'), true);
    check('拆分说明带 part 1', batches.some(b => b.msg.includes('(part 1)')), true);
    check('拆分说明带 part 2', batches.some(b => b.msg.includes('(part 2)')), true);
}

console.log('\n=== 场景 4：单个操作持续失败 -> 抛错（不再无限拆） ===');
{
    const api = new HuggingFaceBatchAPI('tok', 'u/r');
    api.commitOperations = async () => {
        const e = new Error('still failing');
        e.status = 502;
        throw e;
    };

    let caught = null;
    try {
        await api.commitOperationsWithBackoff(ops(1), 'msg', FAST);
    } catch (error) {
        caught = error;
    }
    check('抛出错误', caught !== null, true);
    check('错误信息保留', caught?.message, 'still failing');
}

console.log('\n=== 场景 5：不可重试错误（403 存储限制）不重试 ===');
{
    let calls = 0;
    const api = new HuggingFaceBatchAPI('tok', 'u/r');
    api.commitOperations = async () => {
        calls++;
        const e = new Error('storage limit');
        e.status = 403;
        throw e;
    };

    let caught = null;
    try {
        await api.commitOperationsWithBackoff(ops(1), 'msg', FAST);
    } catch (error) {
        caught = error;
    }

    check('403 直接抛出', caught?.message, 'storage limit');
    // 关键：403 是「存储配额被限制」，重试无意义，只应尝试 1 次（不拆分为 1 个操作）
    check('不反复重试无意义请求', calls, 1);
}

console.log('\n=== 场景 6：空操作数组直接报错 ===');
{
    const api = new HuggingFaceBatchAPI('tok', 'u/r');
    let caught = null;
    try {
        await api.commitOperationsWithBackoff([], 'msg', FAST);
    } catch (error) {
        caught = error;
    }
    check('空数组抛错', caught !== null, true);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));

if (fail > 0) {
    process.exit(1);
}
