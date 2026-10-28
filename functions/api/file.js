/**
 * Cloudflare Pages Function: /api/file
 *
 * 从 R2 桶读取文件并流式返回，支持 Range 请求（PDF 阅读器按需分段加载）。
 *
 * 查询参数：
 *   key     完整对象键，如 comic/三国演义/01.pdf
 *   bucket  可选，upload 时读取网页上传使用的 upload 桶
 * 依赖：Pages 项目的 R2 绑定（udisk2 / UPLOAD）。
 */

const ALLOWED_PREFIXES = ['comic/', 'oldbook/'];
const BINDING_NAMES = ['udisk2', 'UDISK2', 'R2', 'BUCKET', 'UDISK', 'udisk', 'r2', 'bucket', 'BOOKS', 'R2_BUCKET'];
const UPLOAD_BINDING_NAMES = ['UPLOAD', 'upload', 'UPLOAD_BUCKET', 'upload_bucket', 'UPLOADS', 'R2_UPLOAD'];

// 边缘缓存：大于该体积的对象只回源、不写入边缘缓存，避免占用过多内存
const EDGE_CACHE_MAX = 64 * 1024 * 1024;
// 浏览器缓存 1 天，Cloudflare 边缘缓存 30 天
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400';
// 上传桶内容可能被同名覆盖，缓存时间短一些
const UPLOAD_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=600';

function cacheControlFor(isUpload) {
  return isUpload ? UPLOAD_CACHE_CONTROL : CACHE_CONTROL;
}

const EDGE_CACHE = typeof caches !== 'undefined' && caches.default ? caches.default : null;

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

function resolveUploadBucket(env) {
  for (const name of UPLOAD_BINDING_NAMES) {
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
function buildHeaders(meta, key, isUpload) {
  const headers = new Headers();
  if (typeof meta.writeHttpMetadata === 'function') meta.writeHttpMetadata(headers);
  if (!headers.get('Content-Type')) headers.set('Content-Type', guessType(key));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', meta.httpEtag);
  headers.set('Cache-Control', cacheControlFor(isUpload));
  return headers;
}

/** If-None-Match 与对象 ETag 是否匹配（支持 W/ 前缀与逗号列表） */
function etagMatches(header, etag) {
  if (!header || !etag) return false;
  return header.split(',').some((raw) => {
    const tag = raw.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

/** 归一化边缘缓存键，忽略用于绕过缓存的随机参数 */
function cacheKeyFor(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const isUpload = url.searchParams.get('bucket') === 'upload';
  return new Request(
    url.origin + '/api/file?key=' + encodeURIComponent(key) + (isUpload ? '&bucket=upload' : '')
  );
}

/** 后台把完整对象写入边缘缓存，供后续 Range / 完整请求命中 */
async function fillEdgeCache(bucket, key, cacheKey, isUpload) {
  try {
    const obj = await bucket.get(key);
    if (!obj || obj.size > EDGE_CACHE_MAX) return;
    const headers = buildHeaders(obj, key, isUpload);
    headers.set('Content-Length', String(obj.size));
    await EDGE_CACHE.put(cacheKey, new Response(obj.body, { status: 200, headers }));
  } catch (err) {
    // 缓存失败不影响正常下载
  }
}

/** 用已缓存的完整对象切出 Range 片段；无法满足时返回 null */
async function sliceCached(cached, spec) {
  const buf = await cached.arrayBuffer();
  const total = buf.byteLength;
  if (!total) return null;

  let start;
  let end;
  if (spec.suffix !== undefined) {
    start = Math.max(total - spec.suffix, 0);
    end = total - 1;
  } else {
    start = spec.start;
    end = spec.end === null ? total - 1 : Math.min(spec.end, total - 1);
  }
  if (start >= total || start > end) return null;

  const headers = new Headers(cached.headers);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
  headers.set('X-Cache', 'HIT');
  return new Response(buf.slice(start, end + 1), { status: 206, headers });
}

async function handle(context, headOnly) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const isUpload = url.searchParams.get('bucket') === 'upload';

  const keyOk = key && !key.includes('..') && !key.startsWith('/');
  if (!keyOk || (!isUpload && !ALLOWED_PREFIXES.some((p) => key.startsWith(p)))) {
    return text('无效的文件路径', 400);
  }

  const bucket = isUpload ? resolveUploadBucket(env) : resolveBucket(env);
  if (!bucket) {
    return text(isUpload ? '上传桶未绑定（变量名需为 UPLOAD）' : 'R2 绑定未配置（变量名需为 R2）', 503);
  }

  const rangeHeader = request.headers.get('Range');
  const cacheKey = EDGE_CACHE ? cacheKeyFor(request) : null;

  try {
    if (headOnly) {
      if (EDGE_CACHE) {
        const hit = await EDGE_CACHE.match(cacheKey);
        if (hit) {
          const headers = new Headers(hit.headers);
          headers.set('X-Cache', 'HIT');
          return new Response(null, { status: 200, headers });
        }
      }
      const meta = await bucket.head(key);
      if (!meta) return text('文件不存在', 404);
      const headers = buildHeaders(meta, key, isUpload);
      headers.set('Content-Length', String(meta.size));
      headers.set('X-Cache', EDGE_CACHE ? 'MISS' : 'BYPASS');
      return new Response(null, { status: 200, headers });
    }

    if (rangeHeader) {
      const spec = parseRangeHeader(rangeHeader);
      if (!spec) return new Response('Range 无法满足', { status: 416 });

      // 命中完整对象缓存时直接切片，不再回源 R2
      if (EDGE_CACHE) {
        const hit = await EDGE_CACHE.match(cacheKey);
        if (hit) {
          const sliced = await sliceCached(hit, spec);
          return sliced || new Response('Range 无法满足', { status: 416 });
        }
      }

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

      const headers = buildHeaders(obj, key, isUpload);
      headers.set('Content-Length', String(actualLength));
      headers.set('Content-Range', 'bytes ' + actualOffset + '-' + (actualOffset + actualLength - 1) + '/' + size);
      headers.set('X-Cache', 'MISS');

      // 首次分段请求后台缓存完整对象，后续分段读取可直接命中
      if (EDGE_CACHE && size <= EDGE_CACHE_MAX) {
        context.waitUntil(fillEdgeCache(bucket, key, cacheKey, isUpload));
      }

      return new Response(obj.body, { status: 206, headers });
    }

    if (EDGE_CACHE) {
      const hit = await EDGE_CACHE.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set('X-Cache', 'HIT');
        if (etagMatches(request.headers.get('If-None-Match'), headers.get('ETag'))) {
          headers.delete('Content-Length');
          return new Response(null, { status: 304, headers });
        }
        return new Response(hit.body, { status: 200, headers });
      }
    }

    const obj = await bucket.get(key);
    if (!obj) return text('文件不存在', 404);

    const headers = buildHeaders(obj, key, isUpload);
    headers.set('Content-Length', String(obj.size));
    headers.set('X-Cache', EDGE_CACHE ? 'MISS' : 'BYPASS');

    if (etagMatches(request.headers.get('If-None-Match'), obj.httpEtag)) {
      if (obj.body && typeof obj.body.cancel === 'function') obj.body.cancel();
      headers.delete('Content-Length');
      return new Response(null, { status: 304, headers });
    }

    const response = new Response(obj.body, { status: 200, headers });
    if (EDGE_CACHE && obj.size <= EDGE_CACHE_MAX) {
      context.waitUntil(EDGE_CACHE.put(cacheKey, response.clone()));
    }
    return response;
  } catch (err) {
    return text('读取文件失败：' + (err && err.message ? err.message : String(err)), 500);
  }
}

export async function onRequestGet(context) {
  return handle(context, false);
}

export async function onRequestHead(context) {
  return handle(context, true);
}
