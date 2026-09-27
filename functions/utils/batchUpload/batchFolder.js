/**
 * ============================================================================
 * 自定义文件：批量上传的「批次文件夹」规则
 * ============================================================================
 *
 * 【上游同步说明】
 * 本文件为自定义新增模块，上游更新时不会被覆盖。
 *
 * 【这个文件解决什么问题】
 * 默认批量上传会把所有图片平铺在同一个目录里，云端布局很乱、事后难以整理。
 * 本模块负责把「一次批量上传」归拢到一个专属文件夹中，并保证：
 *   1. 文件夹名安全（阻止 ../ 越权、阻止保留前缀、阻止非法字符）
 *   2. 同一批次内文件名不冲突
 *   3. 云端目录结构为 <批次文件夹>/<文件名>
 *
 * 【两种模式】
 * - 用户指定：前端传入 folderName（例如「旅行照片」），直接用。
 * - 自动生成：未指定时按时间戳生成，例如 20260210-153012，
 *   保证「每次上传都是独立文件夹」，不会和既有内容混在一起。
 * ============================================================================
 */

const RESERVED_PREFIX = 'manage@';
const MAX_FOLDER_SEGMENT_LENGTH = 64;
const MAX_FOLDER_SEGMENTS = 6;

/**
 * 构造统一的 API 错误（带 HTTP 状态码，便于上层直接返回）
 */
function invalidRequest(message) {
    const error = new Error(message);
    error.code = 'INVALID_REQUEST';
    error.status = 400;
    return error;
}

/**
 * 生成默认批次文件夹名：YYYYMMDD-HHmmss
 * 使用 UTC+8（与项目其他时间展示保持一致）
 */
export function buildDefaultBatchFolder(date = new Date()) {
    const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);

    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    const hour = String(shifted.getUTCHours()).padStart(2, '0');
    const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
    const second = String(shifted.getUTCSeconds()).padStart(2, '0');

    return `${year}${month}${day}-${hour}${minute}${second}`;
}

/**
 * 校验并清洗单个文件夹层级名
 */
function sanitizeFolderSegment(segment, index) {
    if (!segment) {
        throw invalidRequest(`批次文件夹第 ${index + 1} 段为空`);
    }

    if (segment === '.' || segment === '..') {
        throw invalidRequest('批次文件夹不能包含 . 或 .. 路径段');
    }

    if (segment.startsWith(RESERVED_PREFIX)) {
        throw invalidRequest(`批次文件夹不能使用保留前缀 ${RESERVED_PREFIX}`);
    }

    // 去掉 Windows / 类 Unix 下都不安全的字符
    const cleaned = segment
        .replace(/[\\:*?"<>|]/g, '_')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim();

    if (!cleaned) {
        throw invalidRequest(`批次文件夹第 ${index + 1} 段清洗后为空`);
    }

    if (cleaned.length > MAX_FOLDER_SEGMENT_LENGTH) {
        throw invalidRequest(
            `批次文件夹第 ${index + 1} 段过长（上限 ${MAX_FOLDER_SEGMENT_LENGTH} 字符）`
        );
    }

    return cleaned;
}

/**
 * 校验并规范化批次文件夹路径
 *
 * @param {string|null} folderName 用户指定的文件夹名，可为空
 * @param {object} options
 * @param {boolean} options.autoGenerateWhenEmpty 为空时是否自动生成时间戳文件夹
 * @returns {string} 规范化后的文件夹路径（不含首尾斜杠）；为空字符串表示放在根目录
 */
export function normalizeBatchFolder(folderName, options = {}) {
    const { autoGenerateWhenEmpty = false } = options;

    let raw = folderName;

    if (raw === null || raw === undefined || String(raw).trim() === '') {
        if (!autoGenerateWhenEmpty) {
            return '';
        }
        raw = buildDefaultBatchFolder();
    }

    if (typeof raw !== 'string' && typeof raw !== 'number') {
        throw invalidRequest('批次文件夹名必须是字符串');
    }

    const normalized = String(raw)
        .trim()
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/{2,}/g, '/');

    if (!normalized) {
        return autoGenerateWhenEmpty ? buildDefaultBatchFolder() : '';
    }

    const segments = normalized.split('/');
    if (segments.length > MAX_FOLDER_SEGMENTS) {
        throw invalidRequest(`批次文件夹层级过深（上限 ${MAX_FOLDER_SEGMENTS} 层）`);
    }

    const sanitizedSegments = segments.map((segment, index) =>
        sanitizeFolderSegment(segment, index)
    );

    return sanitizedSegments.join('/');
}

/**
 * 把批次文件夹 + 文件名拼成云端完整路径
 * 同时拦住文件名里的目录穿越和保留前缀。
 */
export function buildBatchFilePath(folder, fileName) {
    if (typeof fileName !== 'string') {
        throw invalidRequest('文件名必须是字符串');
    }

    const trimmed = fileName.trim();
    if (!trimmed) {
        throw invalidRequest('文件名不能为空');
    }

    if (trimmed.length > 255) {
        throw invalidRequest('文件名过长（上限 255 字符）');
    }

    if (trimmed === '.' || trimmed === '..') {
        throw invalidRequest('文件名不能是 . 或 ..');
    }

    if (trimmed.includes('/') || trimmed.includes('\\')) {
        throw invalidRequest('文件名不能包含路径分隔符');
    }

    if (trimmed.startsWith(RESERVED_PREFIX)) {
        throw invalidRequest(`文件名不能使用保留前缀 ${RESERVED_PREFIX}`);
    }

    const cleanedName = trimmed
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim();

    if (!cleanedName) {
        throw invalidRequest('文件名清洗后为空');
    }

    if (cleanedName.startsWith(RESERVED_PREFIX)) {
        throw invalidRequest(`文件名不能使用保留前缀 ${RESERVED_PREFIX}`);
    }

    const fullPath = folder ? `${folder}/${cleanedName}` : cleanedName;

    if (fullPath.startsWith(RESERVED_PREFIX)) {
        throw invalidRequest('完整路径不能以保留前缀开头');
    }

    return { fileName: cleanedName, fullPath };
}

/**
 * 检测同一批次内是否有重名文件
 * 重名会让后一个覆盖前一个，属于静默数据丢失，必须直接报错。
 */
export function assertNoDuplicatePaths(fullPaths) {
    const seen = new Set();
    const duplicates = [];

    for (const path of fullPaths) {
        // 大小写不敏感：不同存储后端对大小写处理不一致，统一按不敏感处理更安全
        const key = path.toLowerCase();
        if (seen.has(key)) {
            duplicates.push(path);
            continue;
        }
        seen.add(key);
    }

    if (duplicates.length > 0) {
        throw invalidRequest(
            `同一批次存在重复文件路径：${duplicates.slice(0, 5).join('、')}`
        );
    }
}
