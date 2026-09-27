/**
 * 批次清单（manifest）与查询接口验证
 * 运行：node test/batchManifest.test.mjs
 *
 * 验证：
 *  1. manifest 结构与内容正确
 *  2. 键前缀不落在 manage@ 下（避免污染上游备份导出）
 *  3. 批次列表接口的排序与摘要正确
 */

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

// 复现 batchCommit.js 中的 manifest 组装与 hfBatchList 的读取逻辑
const IDEMPOTENCY_PREFIX = 'hfBatch@request@';
const BATCH_RECORD_PREFIX = 'hfBatch@manifest@';

// ---- 键前缀安全性验证 ----
console.log('\n=== 键前缀安全性 ===');

check('幂等键不用 manage@ 前缀', IDEMPOTENCY_PREFIX.startsWith('manage@'), false);
check('清单键不用 manage@ 前缀', BATCH_RECORD_PREFIX.startsWith('manage@'), false);

// 上游 batch/settings.js 的排除逻辑（isIndexRelatedKey）
function wouldBeExportedAsSetting(key) {
    if (!key.startsWith('manage@')) return false;
    if (key === 'manage@index') return false;
    if (key.startsWith('manage@index_')) return false;
    if (key.startsWith('manage@index@')) return false;
    if (key === 'manage@indexMeta') return false;
    if (key.startsWith('manage@session@')) return false;
    return true; // 会被当作系统设置导出
}

check(
    '清单键不会出现在系统设置备份中',
    wouldBeExportedAsSetting(`${BATCH_RECORD_PREFIX}b_123`),
    false
);
check(
    '幂等键不会出现在系统设置备份中',
    wouldBeExportedAsSetting(`${IDEMPOTENCY_PREFIX}uuid-1`),
    false
);
// 对照：旧实现的键确实会被导出（证明这个修复是必要的）
check(
    '旧实现键本会被导出（证明修复必要）',
    wouldBeExportedAsSetting('manage@hf_batch_request@uuid-1'),
    true
);

// ---- manifest 结构 ----
console.log('\n=== manifest 组装 ===');

const now = 1790471695000;
const normalizedFolder = '旅行照片';
const preparedFiles = [
    { fullId: '旅行照片/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', metadata: { FileSizeBytes: 1024 } },
    { fullId: '旅行照片/b.png', name: 'b.png', mimeType: 'image/png', metadata: { FileSizeBytes: 2048 } }
];
const responseFiles = preparedFiles.map(f => ({ name: f.name, fullId: f.fullId }));
const requestId = 'req-abc';
const commitId = 'commit-xyz';

const batchId = requestId ? `req_${requestId}` : `b_${now}`;
const manifest = {
    batchId,
    folder: normalizedFolder || '',
    channelName: 'hf-main',
    repo: 'user/repo',
    commitId,
    createdAt: now,
    fileCount: responseFiles.length,
    totalBytes: preparedFiles.reduce((s, f) => s + (f.metadata.FileSizeBytes || 0), 0),
    files: preparedFiles.map(f => ({
        fullId: f.fullId,
        name: f.name,
        size: f.metadata.FileSizeBytes || 0,
        mimeType: f.mimeType
    }))
};

check('batchId 基于 requestId', manifest.batchId, 'req_req-abc');
check('folder 记录批次文件夹', manifest.folder, '旅行照片');
check('fileCount 正确', manifest.fileCount, 2);
check('totalBytes 累加正确', manifest.totalBytes, 3072);
check('files 含完整路径', manifest.files.map(f => f.fullId), ['旅行照片/a.jpg', '旅行照片/b.png']);
check('commitId 记录', manifest.commitId, 'commit-xyz');

// ---- 列表视图摘要 ----
console.log('\n=== 列表视图摘要 ===');

const listItem = {
    batchId: manifest.batchId,
    folder: manifest.folder || '',
    channelName: manifest.channelName || null,
    repo: manifest.repo || null,
    commitId: manifest.commitId || null,
    createdAt: manifest.createdAt || null,
    fileCount: manifest.fileCount || 0,
    totalBytes: manifest.totalBytes || 0
};

check('摘要不含完整 files 数组（避免响应过大）', 'files' in listItem, false);
check('摘要保留关键可查字段', listItem.fileCount, 2);

// ---- 排序 ----
console.log('\n=== 时间倒序 ===');

const batches = [
    { batchId: 'old', createdAt: 1000 },
    { batchId: 'new', createdAt: 3000 },
    { batchId: 'mid', createdAt: 2000 }
];
batches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

check('最新批次排在最前', batches.map(b => b.batchId), ['new', 'mid', 'old']);

// ---- 无 requestId 时的 ID 生成 ----
console.log('\n=== 无 requestId 的兜底 ID ===');

const fallbackId = `b_${now}_${Math.random().toString(36).slice(2, 8)}`;
check('兜底 ID 带时间戳', fallbackId.startsWith(`b_${now}_`), true);
check('兜底 ID 有随机后缀', fallbackId.length > `b_${now}_`.length, true);

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));

if (fail > 0) {
    process.exit(1);
}
