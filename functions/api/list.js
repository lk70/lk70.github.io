/**
 * Cloudflare Pages Function: /api/list
 *
 * 按目录层级列出 R2 桶 udisk2 中 comic/ 与 oldbook/ 下的子文件夹和文件。
 * 依赖：Pages 项目的 R2 绑定。绑定变量名可为 udisk2 / UDISK2 / R2 / BUCKET 等。
 *
 * 查询参数：
 *   prefix  comic | oldbook
 *   path    相对 prefix 的子目录（不带首尾斜杠），如 三国演义/第1集
 *   cursor  R2 分页游标（首次不传）
 *   limit   每页文件条数，默认 200，最大 1000
 *
 * 返回：{ prefix, path, folders: [{ name, path }], objects: [...], truncated, cursor }
 */

const ALLOWED_PREFIXES = new Set(['comic', 'oldbook']);
const BINDING_NAMES = ['udisk2', 'UDISK2', 'R2', 'BUCKET', 'UDISK', 'udisk', 'r2', 'bucket', 'BOOKS', 'R2_BUCKET'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function resolveBucket(env) {
  for (const name of BINDING_NAMES) {
    if (env[name]) return env[name];
  }
  return null;
}

/**
 * 可选：R2 桶的公开访问域名（如 https://files.example.com）。
 * 配置后清单返回直链，文件下载不再经过 Pages Function，速度明显更快。
 */
function publicBase(env) {
  const base = env.R2_PUBLIC_BASE || env.PUBLIC_R2_BASE || '';
  return base.replace(/\/+$/, '');
}

/** 规范化子目录路径；非法（含 . / .. / 空段）返回 null */
function normalizePath(raw) {
  const trimmed = (raw || '').replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+|\/+$/g, '');

  if (!ALLOWED_PREFIXES.has(prefix)) {
    return json({ error: '无效的目录，仅支持 comic 或 oldbook' }, 400);
  }

  const path = normalizePath(url.searchParams.get('path'));
  if (path === null) {
    return json({ error: '无效的目录路径' }, 400);
  }

  const bucket = resolveBucket(env);
  if (!bucket) {
    return json({ error: 'R2 绑定未配置（变量名需为 R2）' }, 503);
  }

  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1),
    1000
  );

  const basePrefix = prefix + '/' + (path ? path + '/' : '');

  try {
    const listed = await bucket.list({ prefix: basePrefix, delimiter: '/', cursor, limit });
    const base = publicBase(env);

    const folders = (listed.delimitedPrefixes || []).map((dp) => {
      const rel = dp.slice(prefix.length + 1).replace(/\/$/, '');
      return { name: rel.split('/').pop(), path: rel };
    });

    const objects = listed.objects
      .filter((o) => o.key !== basePrefix && !o.key.endsWith('/'))
      .map((o) => ({
        key: o.key,
        name: o.key.slice(basePrefix.length),
        size: o.size,
        uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
        url: base
          ? base + '/' + o.key.split('/').map((s) => encodeURIComponent(s)).join('/')
          : null,
      }));

    return json({
      prefix,
      path,
      folders,
      objects,
      truncated: !!listed.truncated,
      cursor: listed.truncated ? listed.cursor || null : null,
    });
  } catch (err) {
    return json({ error: '读取 R2 目录失败：' + (err && err.message ? err.message : String(err)) }, 500);
  }
}
