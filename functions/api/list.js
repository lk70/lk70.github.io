/**
 * Cloudflare Pages Function: /api/list
 *
 * 列出 R2 桶 udisk 中 comic/ 与 oldbook/ 目录下的文件。
 * 依赖：Pages 项目的 R2 绑定。绑定变量名可为 R2 / BUCKET / UDISK / udisk 等，
 * 建议使用 R2；若你的绑定名不同，请在 RESOLVE_ORDER 中补充。
 *
 * 查询参数：
 *   prefix  comic | oldbook
 *   cursor  R2 分页游标（首次不传）
 *   limit   每页条数，默认 200，最大 1000
 *
 * 返回：{ prefix, objects: [{ key, name, size, uploaded }], truncated, cursor }
 */

const ALLOWED_PREFIXES = new Set(['comic', 'oldbook']);
const BINDING_NAMES = ['R2', 'BUCKET', 'UDISK', 'udisk', 'r2', 'bucket', 'BOOKS', 'R2_BUCKET'];

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

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+|\/+$/g, '');

  if (!ALLOWED_PREFIXES.has(prefix)) {
    return json({ error: '无效的目录，仅支持 comic 或 oldbook' }, 400);
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

  try {
    const listed = await bucket.list({ prefix: prefix + '/', cursor, limit });
    const objects = listed.objects
      .map((o) => ({
        key: o.key,
        name: o.key.slice(prefix.length + 1),
        size: o.size,
        uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
      }))
      .filter((o) => o.name && !o.name.endsWith('/'));

    return json({
      prefix,
      objects,
      truncated: !!listed.truncated,
      cursor: listed.truncated ? listed.cursor || null : null,
    });
  } catch (err) {
    return json({ error: '读取 R2 目录失败：' + (err && err.message ? err.message : String(err)) }, 500);
  }
}
