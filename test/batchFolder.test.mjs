/**
 * 批次文件夹规则自测
 * 运行：node test/batchFolder.test.mjs
 */

import {
    normalizeBatchFolder,
    buildBatchFilePath,
    assertNoDuplicatePaths,
    buildDefaultBatchFolder
} from '../functions/utils/batchUpload/batchFolder.js';
import { resolveMimeType } from '../functions/utils/batchUpload/mimeType.js';

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

function checkThrows(label, fn) {
    try {
        fn();
        fail++;
        console.log(`  FAIL  ${label} —— 本该抛错却通过了`);
    } catch (_error) {
        pass++;
        console.log(`  PASS  ${label}`);
    }
}

console.log('\n=== normalizeBatchFolder ===');
check('普通名', normalizeBatchFolder('旅行照片'), '旅行照片');
check('去首尾斜杠', normalizeBatchFolder('/a/b/'), 'a/b');
check('折叠重复斜杠', normalizeBatchFolder('a//b'), 'a/b');
check('空字符串不自动生成', normalizeBatchFolder(''), '');
check('null 不自动生成', normalizeBatchFolder(null), '');
checkThrows('拒绝 .. 穿越', () => normalizeBatchFolder('../etc'));
checkThrows('拒绝中间 .. 穿越', () => normalizeBatchFolder('a/../../b'));
checkThrows('拒绝 . 目录', () => normalizeBatchFolder('a/./b'));
checkThrows('拒绝保留前缀', () => normalizeBatchFolder('manage@hack'));
checkThrows('拒绝过深层级', () => normalizeBatchFolder('a/b/c/d/e/f/g/h'));
check('自动生成时间戳', normalizeBatchFolder('', { autoGenerateWhenEmpty: true }).length, 15);
check('Windows 非法字符被替换', normalizeBatchFolder('a:b*c?'), 'a_b_c_');

console.log('\n=== buildDefaultBatchFolder ===');
const folder = buildDefaultBatchFolder(new Date('2026-02-10T07:30:12Z'));
check('UTC+8 时间戳格式', folder, '20260210-153012');

console.log('\n=== buildBatchFilePath ===');
check('根目录文件', buildBatchFilePath('', 'a.jpg'), { fileName: 'a.jpg', fullPath: 'a.jpg' });
check('带文件夹', buildBatchFilePath('批1', 'a.jpg'), { fileName: 'a.jpg', fullPath: '批1/a.jpg' });
checkThrows('拒绝文件名穿越', () => buildBatchFilePath('批1', '../a.jpg'));
checkThrows('拒绝文件名内斜杠', () => buildBatchFilePath('批1', 'x/a.jpg'));
checkThrows('拒绝空文件名', () => buildBatchFilePath('批1', '   '));
checkThrows('拒绝保留前缀文件名', () => buildBatchFilePath('批1', 'manage@x'));
checkThrows('拒绝残缺 .. 文件名', () => buildBatchFilePath('批1', '..'));

console.log('\n=== assertNoDuplicatePaths ===');
check('无重名通过', assertNoDuplicatePaths(['a.jpg', 'b.jpg']), undefined);
checkThrows('检出重名', () => assertNoDuplicatePaths(['a.jpg', 'a.jpg']));
checkThrows('大小写不敏感重名', () => assertNoDuplicatePaths(['A.jpg', 'a.jpg']));

console.log('\n=== resolveMimeType ===');
check('显式 MIME 优先', resolveMimeType('image/png', 'a.jpg'), 'image/png');
check('octet-stream 时按扩展名', resolveMimeType('application/octet-stream', 'a.jpg'), 'image/jpeg');
check('空 MIME 按扩展名', resolveMimeType('', 'a.webp'), 'image/webp');
check('data URL 推断', resolveMimeType('', 'noext', { dataUrlValue: 'data:image/gif;base64,AAA' }), 'image/gif');
check('无法推断回落 octet', resolveMimeType('', 'noext'), 'application/octet-stream');
check('显式 octet 且无扩展名保留', resolveMimeType('application/octet-stream', 'noext'), 'application/octet-stream');

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));

if (fail > 0) {
    process.exit(1);
}
