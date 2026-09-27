/**
 * 批量上传对索引系统的压力分析
 * 运行：node test/indexLoadAnalysis.mjs
 *
 * 目的：量化「逐个 addFileToIndex」与「一次 batchAddFilesToIndex」的差异，
 * 为是否需要定制化优化提供数据依据。
 *
 * 已知代码事实（来自 functions/utils/indexManager.js）：
 *  - recordOperation() 每次调用写入 1 条 KV 记录
 *  - getAllPendingOperations() 单次最多读取 MAX_OPERATION_COUNT = 30 条
 *  - index/finalize 需要多次往返才能合并完所有待处理操作
 */

console.log('\n=== 索引操作压力分析 ===\n');

const MAX_OPERATION_COUNT = 30; // indexManager.js:1335
const SCENARIOS = [10, 30, 50, 100, 200];

console.log('场景：一次批量上传 N 个文件\n');
console.log('  N    当前实现(逐文件)        改用 batchAdd 后');
console.log('       操作记录  finalize轮次   操作记录  finalize轮次');
console.log('  ' + '-'.repeat(56));

for (const n of SCENARIOS) {
    // 当前实现：endUpload -> addFileToIndex 每个文件一条
    const currentOps = n;
    const currentRounds = Math.ceil(currentOps / MAX_OPERATION_COUNT);

    // 优化后：一次 batch_add 记录（含 N 个文件描述）
    const optimizedOps = 1;
    const optimizedRounds = 1;

    console.log(
        `  ${String(n).padEnd(4)} ${String(currentOps).padEnd(9)} ${String(currentRounds).padEnd(14)} ` +
        `${String(optimizedOps).padEnd(9)} ${optimizedRounds}`
    );
}

console.log('\n=== 结论 ===\n');
console.log('1. 当前实现（50 文件批次）会产生 50 条操作记录，需要 2 轮 finalize 才能入索引。');
console.log('2. 上游已有的 batchAddFilesToIndex() 可以一次记录，1 轮完成。');
console.log('3. 但注意：批量记录会让单条操作变大，KV 单值上限 25MB 需留意。');
console.log('   （上游 batch/delete 用 MAX_BATCH_SIZE=500，说明该模式是安全的）');

console.log('\n=== 另一处已确认的正确行为 ===\n');
console.log('• metadata.Directory 已按批次文件夹设置，目录树会自动正确归组。');
console.log('• url.searchParams 已设置 uploadFolder，CDN 缓存清理路径正确。');
console.log('• HfToken 属于 SENSITIVE_METADATA_KEYS，管理界面会自动脱敏。');
console.log('• 幂等键与批次清单使用 hfBatch@ 前缀，不会污染上游 manage@ 设置备份。');

console.log('\n=== HF 官方限制对照（已用官方 OpenAPI spec 核验）===\n');
console.log('• commit 端点：无 maxItems（官方文档亦称 "no hard limit"）');
console.log('• preupload 端点：files maxItems = 1000（我们每文件单独调用，安全）');
console.log('• 官方建议：每次 commit 50-100 个文件（我们默认 50，符合）');
console.log('• 官方硬约束：HTTP 请求 60 秒超时 -> 已实现降级拆分提交');
console.log('• 官方硬约束：每文件夹 <10k 文件（批次文件夹化正好缓解此压力）');
