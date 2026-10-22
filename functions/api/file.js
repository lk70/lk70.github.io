/**
 * Cloudflare Pages Function: /api/file
 *
 * 从 R2 桶 udisk 读取 comic/ 或 oldbook/ 下的文件并流式返回，
 * 支持 Range 请求（PDF 阅读器按需分段加载）。
 *
 * 查询参数：key  完整对象键，如 comic/三国演义/01.pdf
 * 依赖：Pages 项目的 R2 绑定（变量名 R2 / BUCKET / UDISK / udisk 等）。
 */

const ALLOWED_PREFIXES = ['comic/', 'oldbook/'];
const BINDING_NAMES = ['R2', 'BUCKET', 'UDISK', 'udisk', 'r2', 'bucket', 'BOOKS', 'R2_BUCKET'];

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
};

function resolveBucket(env) {
  for (const name of BINDING_NAMES) {
    if (env[name]) return env[name];
  }
  return null;
}

function guessType(key) {
  const i = key.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return CONTENT_TYPES[key.slice(i + 1).toLowerCase()] || 'application/octet-stream';
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** 解析单段 Range；返回 { start, end } / { suffix } / null（非法或多段） */
function parseRangeHeader(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    return suffix > 0 ? { suffix } : null;
  }
  const start = parseInt(m[1], 10);
  const end = m[2] === '' ? null : parseInt(m[2], 10);
  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

/** 基于 R2 对象的元数据构造响应头 */
function buildHeaders(meta, key) {
  const headers = new Headers();
  if (typeof meta.writeHttpMetadata === 'function') meta.writeHttpMetadata(headers);
  if (!headers.get('Content-Type')) headers.set('Content-Type', guessType(key));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', meta.httpEtag);
  headers.set('Cache-Control', 'public, max-age=86400');
  return headers;
}

async function handle(request, env, headOnly) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!key || key.includes('..') || !ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
    return text('无效的文件路径', 400);
  }

  const bucket = resolveBucket(env);
  if (!bucket) return text('R2 绑定未配置（变量名需为 R2）', 503);

  const rangeHeader = request.headers.get('Range');

  try {
    if (headOnly) {
      const meta = await bucket.head(key);
      if (!meta) return text('文件不存在', 404);
      const headers = buildHeaders(meta, key);
      headers.set('Content-Length', String(meta.size));
      return new Response(null, { status: 200, headers });
    }

    if (rangeHeader) {
      const spec = parseRangeHeader(rangeHeader);
      if (!spec) return new Response('Range 无法满足', { status: 416 });

      let offset;
      let length;
      let total;

      if (spec.suffix !== undefined) {
        // 仅后缀范围（bytes=-N）需要先取对象大小
        const meta = await bucket.head(key);
        if (!meta) return text('文件不存在', 404);
        if (meta.size === 0) return new Response('Range 无法满足', { status: 416 });
        offset = Math.max(meta.size - spec.suffix, 0);
        length = meta.size - offset;
        total = meta.size;
      } else {
        offset = spec.start;
        length = spec.end === null ? undefined : spec.end - spec.start + 1;
      }

      // 常见 Range（bytes=a-b / bytes=a-）直接读取，省去多余的 head 往返
      const obj = await bucket.get(key, {
        range: length === undefined ? { offset } : { offset, length },
      });
      if (!obj) return new Response('Range 无法满足', { status: 416 });

      const size = total !== undefined ? total : obj.size;
      const actualOffset = obj.range ? obj.range.offset : offset;
      const actualLength = obj.range
        ? obj.range.length
        : Math.min(length === undefined ? size - actualOffset : length, size - actualOffset);
      if (!(actualLength > 0)) return new Response('Range 无法满足', { status: 416 });

      const headers = buildHeaders(obj, key);
      headers.set('Content-Length', String(actualLength));
      headers.set('Content-Range', 'bytes ' + actualOffset + '-' + (actualOffset + actualLength - 1) + '/' + size);
      return new Response(obj.body, { status: 206, headers });
    }

    const obj = await bucket.get(key);
    if (!obj) return text('文件不存在', 404);

    const headers = buildHeaders(obj, key);
    headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    return text('读取文件失败：' + (err && err.message ? err.message : String(err)), 500);
  }
}

export async function onRequestGet(context) {
  return handle(context.request, context.env, false);
}

export async function onRequestHead(context) {
  return handle(context.request, context.env, true);
}
