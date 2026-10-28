/**
 * Cloudflare Pages Function: /api/list
 *
 * 按目录层级列出 R2 桶中的子文件夹和文件。
 * comic / oldbook 读取 udisk2 桶；upload 读取网页上传使用的 upload 桶根目录。
 * 依赖：Pages 项目的 R2 绑定（udisk2 / UPLOAD）。
 *
 * 查询参数：
 *   prefix  comic | oldbook | upload
 *   path    相对 prefix 的子目录（不带首尾斜杠），如 三国演义/第1集
 *   cursor  R2 分页游标（首次不传）
 *   limit   每页文件条数，默认 200，最大 1000
 *
 * 返回：{ prefix, path, folders: [{ name, path }], objects: [...], truncated, cursor }
 */

const ALLOWED_PREFIXES = new Set(['comic', 'oldbook', 'upload']);
const BINDING_NAMES = ['udisk2', 'UDISK2', 'R2', 'BUCKET', 'UDISK', 'udisk', 'r2', 'bucket', 'BOOKS', 'R2_BUCKET'];
const UPLOAD_BINDING_NAMES = ['UPLOAD', 'upload', 'UPLOAD_BUCKET', 'upload_bucket', 'UPLOADS', 'R2_UPLOAD'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control':
        status === 200 ? 'public, max-age=60, stale-while-revalidate=300' : 'no-store',
    },
  });
}

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

/** 规范化子目录路径；非法（含 . / .. / 空段）返回 null */
function normalizePath(raw) {
  const trimmed = (raw || '').replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+|\/+$/g, '');

  // 边缘缓存：同一目录的重复请求直接命中 Cloudflare 缓存，避免再次访问 R2
  // upload 目录不缓存，保证刚上传的文件立刻可见
  const cache =
    prefix !== 'upload' && typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = cache ? new Request(url.toString(), { method: 'GET' }) : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  if (!ALLOWED_PREFIXES.has(prefix)) {
    return json({ error: '无效的目录，仅支持 comic、oldbook 或 upload' }, 400);
  }

  const path = normalizePath(url.searchParams.get('path'));
  if (path === null) {
    return json({ error: '无效的目录路径' }, 400);
  }

  const isUpload = prefix === 'upload';
  const bucket = isUpload ? resolveUploadBucket(env) : resolveBucket(env);
  if (!bucket) {
    return json(
      { error: isUpload ? '上传桶未绑定（变量名需为 UPLOAD）' : 'R2 绑定未配置（变量名需为 R2）' },
      503
    );
  }

  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1),
    1000
  );

  const basePrefix = isUpload
    ? path
      ? path + '/'
      : ''
    : prefix + '/' + (path ? path + '/' : '');

  try {
    const listed = await bucket.list({ prefix: basePrefix, delimiter: '/', cursor, limit });

    const folders = (listed.delimitedPrefixes || []).map((dp) => {
      // 文件夹 path 始终相对于 prefix 根目录，供前端逐层拼接查询
      const rel = isUpload
        ? dp.replace(/\/$/, '')
        : dp.slice(prefix.length + 1).replace(/\/$/, '');
      return { name: rel.split('/').pop(), path: rel };
    });

    const objects = listed.objects
      .filter((o) => o.key !== basePrefix && !o.key.endsWith('/'))
      .map((o) => ({
        key: o.key,
        name: o.key.slice(basePrefix.length),
        size: o.size,
        uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
        url: isUpload
          ? '/api/file?bucket=upload&key=' + encodeURIComponent(o.key)
          : null,
      }));

    const response = json({
      prefix,
      path,
      folders,
      objects,
      truncated: !!listed.truncated,
      cursor: listed.truncated ? listed.cursor || null : null,
    });

    if (cache) {
      context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
    }
    return response;
  } catch (err) {
    return json({ error: '读取 R2 目录失败：' + (err && err.message ? err.message : String(err)) }, 500);
  }
}
