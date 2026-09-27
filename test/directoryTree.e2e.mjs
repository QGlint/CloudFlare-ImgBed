/**
 * GUI 目录树验证：证明批次上传会正确生成文件夹结构
 * 运行：node test/directoryTree.e2e.mjs
 *
 * 背景：用户反馈「网页图床 GUI 显示比较乱」，需要文件夹结构。
 *
 * 关键链路（已从源码确认）：
 *   batchCommit 写入 metadata.Directory = "<批次>/"
 *     -> indexManager.getDirectoryTree() 读取 metadata.Directory
 *     -> buildTree() 按 '/' 逐级构建父子节点
 *     -> /api/directoryTree 返回树 -> GUI 渲染文件夹
 *
 * 本测试直接复用上游的 buildTree 与 extractDirectory 语义，
 * 验证我们的 Directory 写法能被正确解析成层级结构。
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

// ---- 复刻上游语义（functions/utils/indexManager.js:1703, 1732, 2165） ----
function extractDirectory(filePath) {
    const i = filePath.lastIndexOf('/');
    return i === -1 ? '' : filePath.substring(0, i + 1);
}

function buildTree(directories) {
    const root = { name: '/', path: '', children: [] };
    for (const dir of directories) {
        const parts = dir.split('/').filter(Boolean);
        let node = root;
        let currentPath = '';
        for (const part of parts) {
            currentPath += part + '/';
            let child = node.children.find(c => c.name === part);
            if (!child) {
                child = { name: part, path: currentPath, children: [] };
                node.children.push(child);
            }
            node = child;
        }
    }
    return root;
}

// 复刻 getDirectoryTree 的目录收集逻辑
function collectDirectories(files) {
    const set = new Set();
    for (const file of files) {
        const dirPath = file.metadata?.Directory || extractDirectory(file.id);
        if (!dirPath) continue;
        const normalized = dirPath.endsWith('/') ? dirPath : dirPath + '/';
        const parts = normalized.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += part + '/';
            set.add(current);
        }
    }
    return Array.from(set);
}

import { normalizeBatchFolder, buildBatchFilePath } from '../functions/utils/batchUpload/batchFolder.js';

console.log('\n=== 场景 1：过去的问题 —— 图片平铺在根目录 ===');
{
    // 这是 PaperTranFlow 当前逐张上传的效果：所有图片都在根目录
    const oldFiles = [
        { id: 'fig1.png', metadata: { Directory: '' } },
        { id: 'fig2.png', metadata: { Directory: '' } },
        { id: 'fig3.png', metadata: { Directory: '' } },
        { id: 'table1.png', metadata: { Directory: '' } },
        { id: 'chart.png', metadata: { Directory: '' } }
    ];
    const dirs = collectDirectories(oldFiles);
    check('根目录下无任何文件夹（这就是"乱"）', dirs, []);
}

console.log('\n=== 场景 2：批次文件夹 —— 每篇论文一个文件夹 ===');
{
    // 模拟两篇论文的配图，各自归入自己的文件夹
    const batches = [
        { folder: 'Attention_Is_All_You_Need', files: ['fig1.png', 'fig2.png', 'table1.png'] },
        { folder: 'BERT', files: ['fig1.png', 'chart.png'] }
    ];

    const uploaded = [];
    for (const b of batches) {
        const folder = normalizeBatchFolder(b.folder, { autoGenerateWhenEmpty: true });
        for (const name of b.files) {
            const { fullPath, fileName } = buildBatchFilePath(folder, name);
            uploaded.push({
                id: fullPath,
                metadata: {
                    Directory: folder === '' ? '' : `${folder}/`,
                    FileName: fileName
                }
            });
        }
    }

    const dirs = collectDirectories(uploaded);
    check('生成两个顶层文件夹', dirs.sort(), [
        'Attention_Is_All_You_Need/',
        'BERT/'
    ]);

    const tree = buildTree(dirs);
    const topNames = tree.children.map(c => c.name).sort();
    check('目录树顶层节点正确', topNames, ['Attention_Is_All_You_Need', 'BERT']);

    // 验证每篇论文的图片确实归在自己的文件夹下
    const aiyay = uploaded.filter(f => f.id.startsWith('Attention_Is_All_You_Need/'));
    check('论文A 有 3 张图', aiyay.length, 3);
    check('论文A 路径正确', aiyay.map(f => f.id).sort(), [
        'Attention_Is_All_You_Need/fig1.png',
        'Attention_Is_All_You_Need/fig2.png',
        'Attention_Is_All_You_Need/table1.png'
    ]);

    // 关键：两篇论文都有 fig1.png，但互不冲突
    const fig1s = uploaded.filter(f => f.metadata.FileName === 'fig1.png');
    check('同名图在不同文件夹互不冲突', fig1s.map(f => f.id).sort(), [
        'Attention_Is_All_You_Need/fig1.png',
        'BERT/fig1.png'
    ]);
}

console.log('\n=== 场景 3：多层嵌套文件夹 ===');
{
    const folder = normalizeBatchFolder('论文/2026/BERT', { autoGenerateWhenEmpty: true });
    const { fullPath } = buildBatchFilePath(folder, 'fig1.png');

    const dirs = collectDirectories([
        { id: fullPath, metadata: { Directory: `${folder}/` } }
    ]);

    check('逐级生成父目录', dirs.sort(), ['论文/', '论文/2026/', '论文/2026/BERT/']);

    const tree = buildTree(dirs);
    check('树顶层只有一个节点', tree.children.length, 1);
    check('第二层只有一个节点', tree.children[0].children.length, 1);
    check('第三层为 BERT', tree.children[0].children[0].children[0].name, 'BERT');
}

console.log('\n=== 场景 4：未指定文件夹时自动时间戳隔离 ===');
{
    const folder1 = normalizeBatchFolder('', { autoGenerateWhenEmpty: true });
    const folder2 = normalizeBatchFolder('', { autoGenerateWhenEmpty: true });

    // 时间戳精度到秒，两次调用可能同秒；用不同基准时间模拟两次上传
    const { buildDefaultBatchFolder } = await import('../functions/utils/batchUpload/batchFolder.js');
    const f1 = buildDefaultBatchFolder(new Date('2026-02-10T07:30:12Z'));
    const f2 = buildDefaultBatchFolder(new Date('2026-02-10T08:45:30Z'));

    check('两次上传生成不同文件夹', f1 !== f2, true);
    check('时间戳格式 A', f1, '20260210-153012');
    check('时间戳格式 B', f2, '20260210-164530');
    check('自动文件夹也能被目录树识别',
        collectDirectories([{ id: `${f1}/a.png`, metadata: { Directory: `${f1}/` } }]),
        [`${f1}/`]);
}

console.log('\n=== 场景 5：目录树节点结构符合上游约定 ===');
{
    const dirs = collectDirectories([
        { id: '批次A/a.png', metadata: { Directory: '批次A/' } },
        { id: '批次B/b.png', metadata: { Directory: '批次B/' } }
    ]);
    const tree = buildTree(dirs);

    check('根节点 name 为 /', tree.name, '/');
    check('根节点 path 为空', tree.path, '');
    check('子节点含 name/path/children',
        Object.keys(tree.children[0]).sort(),
        ['children', 'name', 'path']);
    check('子节点 path 以 / 结尾', tree.children[0].path.endsWith('/'), true);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));

if (fail > 0) process.exit(1);
