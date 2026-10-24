/**
 * Cloudflare Pages Function: /api/upload
 *
 * 接收网页上传的文件并写入 R2 桶 upload。
 * 依赖：Pages 项目的 R2 绑定，变量名建议为 UPLOAD（也兼容 upload / UPLOAD_BUCKET 等）。
 * 可选：UPLOAD_PUBLIC_BASE 配置后，返回可直接访问的直链。
 *
 * 请求：multipart/form-data
 *   file  可多个
 *   dir   可选目标文件夹，如 comic/2026
 */

const BINDING_NAMES = ['UPLOAD', 'upload', 'UPLOAD_BUCKET', 'upload_bucket', 'UPLOADS', 'R2_UPLOAD'];

// Pages Functions 请求体上限为 100 MB，这里留出表单开销
const MAX_TOTAL_SIZE = 95 * 1024 * 1024;
const MAX_FILE_SIZE = 95 * 1024 * 1024;

const ALLOWED_EXT = new Set([
  'pdf', 'epub', 'mobi', 'azw3', 'cbz', 'cbr',
  'zip', 'rar', '7z',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg',
  'txt', 'md', 'json', 'csv',
  'mp4', 'webm', 'mp3', 'm4a',
]);

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function resolveBucket(env) {
  for (const name of BINDING_NAMES) {
    if (env[name]) return env[name];
  }
  return null;
}

function publicBase(env) {
  const base = env.UPLOAD_PUBLIC_BASE || env.R2_UPLOAD_PUBLIC_BASE || '';
  return base.replace(/\/+$/, '');
}

/** 规范化目标目录；非法返回 null */
function normalizeDir(raw) {
  const trimmed = String(raw || '').replace(/^\/+|\/+$/g, '').trim();
  if (!trimmed) return '';
  if (trimmed.length > 200) return null;
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || /[\\:*?"<>|]/.test(p))) return null;
  return parts.join('/');
}

/** 去掉路径、非法字符并限制长度 */
function safeName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop();
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  return cleaned;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 简单防跨站：浏览器跨域表单提交会被拒绝
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) {
        return json({ error: '跨站请求被拒绝' }, 403);
      }
    } catch (e) {
      return json({ error: '非法来源' }, 403);
    }
  }

  const bucket = resolveBucket(env);
  if (!bucket) {
    return json({ error: '上传桶未绑定（请添加变量 UPLOAD → 桶 upload）' }, 503);
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: '请求需为 multipart/form-data' }, 400);
  }

  const dir = normalizeDir(form.get('dir'));
  if (dir === null) {
    return json({ error: '目标文件夹不合法' }, 400);
  }

  const files = form
    .getAll('file')
    .filter((f) => f && typeof f === 'object' && typeof f.size === 'number' && f.name);

  if (!files.length) {
    return json({ error: '未选择文件' }, 400);
  }

  let total = 0;
  for (const file of files) total += file.size;
  if (total > MAX_TOTAL_SIZE) {
    return json({ error: '单次上传总大小不能超过 95 MB' }, 413);
  }

  const base = publicBase(env);
  const uploaded = [];
  const failed = [];

  for (const file of files) {
    const name = safeName(file.name);
    if (!name) {
      failed.push({ name: file.name, error: '文件名不合法' });
      continue;
    }
    if (file.size === 0) {
      failed.push({ name, error: '空文件' });
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      failed.push({ name, error: '文件超过 95 MB' });
      continue;
    }

    const ext = name.indexOf('.') >= 0 ? name.split('.').pop().toLowerCase() : '';
    if (!ALLOWED_EXT.has(ext)) {
      failed.push({ name, error: ext ? '不支持的文件类型 .' + ext : '缺少文件扩展名' });
      continue;
    }

    const key = dir ? dir + '/' + name : name;
    try {
      await bucket.put(key, file, {
        httpMetadata: {
          contentType:
            file.type && file.type !== 'application/octet-stream'
              ? file.type
              : CONTENT_TYPES[ext] || 'application/octet-stream',
        },
        customMetadata: {
          uploadedAt: new Date().toISOString(),
          source: 'web',
        },
      });
      uploaded.push({
        key,
        name,
        size: file.size,
        url: base ? base + '/' + key.split('/').map((s) => encodeURIComponent(s)).join('/') : null,
      });
    } catch (err) {
      failed.push({ name, error: err && err.message ? err.message : String(err) });
    }
  }

  return json({ uploaded, failed }, uploaded.length ? 200 : 400);
}
