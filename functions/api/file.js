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

/** 解析单段 Range 请求；返回 { start, end } 或 null（非法/多段） */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '') {
    if (m[2] === '') return null;
    const suffix = parseInt(m[2], 10);
    if (!suffix) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
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
    if (rangeHeader || headOnly) {
      const meta = await bucket.head(key);
      if (!meta) return text('文件不存在', 404);

      let range = null;
      if (rangeHeader) {
        range = parseRange(rangeHeader, meta.size);
        if (!range) {
          return new Response('Range 无法满足', {
            status: 416,
            headers: { 'Content-Range': 'bytes */' + meta.size },
          });
        }
      }

      const headers = buildHeaders(meta, key);
      if (range) {
        headers.set('Content-Length', String(range.end - range.start + 1));
        headers.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + meta.size);
      } else {
        headers.set('Content-Length', String(meta.size));
      }

      if (headOnly) {
        return new Response(null, { status: range ? 206 : 200, headers });
      }

      const obj = await bucket.get(key, {
        range: { offset: range.start, length: range.end - range.start + 1 },
      });
      if (!obj) return text('文件不存在', 404);
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
