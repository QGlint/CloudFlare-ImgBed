const EXTENSION_MIME_MAP = {
    avif: 'image/avif',
    bmp: 'image/bmp',
    css: 'text/css; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    gif: 'image/gif',
    heic: 'image/heic',
    heif: 'image/heif',
    htm: 'text/html; charset=utf-8',
    html: 'text/html; charset=utf-8',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    mpeg: 'video/mpeg',
    mpg: 'video/mpeg',
    m4a: 'audio/mp4',
    mov: 'video/quicktime',
    pdf: 'application/pdf',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    txt: 'text/plain; charset=utf-8',
    wav: 'audio/wav',
    webm: 'video/webm',
    webp: 'image/webp',
    xml: 'application/xml; charset=utf-8',
    zip: 'application/zip'
};

const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*.+)?$/i;
const OCTET_STREAM_PREFIX = 'application/octet-stream';

function toBaseMimeType(mimeType) {
    if (typeof mimeType !== 'string') {
        return null;
    }

    const trimmed = mimeType.trim();
    if (!trimmed) {
        return null;
    }

    const [baseType] = trimmed.split(';');
    return baseType.trim().toLowerCase() || null;
}

export function normalizeMimeType(mimeType) {
    if (typeof mimeType !== 'string') {
        return null;
    }

    const trimmed = mimeType.trim();
    if (!trimmed || !MIME_PATTERN.test(trimmed)) {
        return null;
    }

    return trimmed;
}

export function isOctetStreamMimeType(mimeType) {
    const baseType = toBaseMimeType(mimeType);
    return baseType === OCTET_STREAM_PREFIX;
}

export function inferMimeTypeFromFileName(fileName) {
    if (typeof fileName !== 'string' || !fileName.trim()) {
        return null;
    }

    const normalizedFileName = fileName.split('?')[0].split('#')[0];
    const baseName = normalizedFileName.split('/').pop();
    if (!baseName) {
        return null;
    }

    const dotIndex = baseName.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex === baseName.length - 1) {
        return null;
    }

    const extension = baseName.slice(dotIndex + 1).toLowerCase();
    return EXTENSION_MIME_MAP[extension] || null;
}

export function extractMimeTypeFromDataUrl(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed.startsWith('data:')) {
        return null;
    }

    const commaIndex = trimmed.indexOf(',');
    if (commaIndex <= 5) {
        return null;
    }

    const mimePart = trimmed.slice(5, commaIndex).split(';')[0].trim();
    return normalizeMimeType(mimePart);
}

export function resolveMimeType(mimeType, fileName, options = {}) {
    const {
        dataUrlValue = null,
        defaultMimeType = 'application/octet-stream'
    } = options;

    const normalizedInput = normalizeMimeType(mimeType);

    if (normalizedInput && !isOctetStreamMimeType(normalizedInput)) {
        return normalizedInput;
    }

    const dataUrlMimeType = extractMimeTypeFromDataUrl(dataUrlValue);
    if (dataUrlMimeType) {
        return dataUrlMimeType;
    }

    const inferredMimeType = inferMimeTypeFromFileName(fileName);
    if (inferredMimeType) {
        return inferredMimeType;
    }

    if (normalizedInput) {
        return normalizedInput;
    }

    return defaultMimeType;
}
