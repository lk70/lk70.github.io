/**
 * Cloudflare Pages Function: /api/guestbook
 *
 * 留言板：
 *   GET  /api/guestbook?limit=10  读取留言（顶层留言 + 其回复）
 *   POST /api/guestbook            发表留言 / 回复（JSON 或 multipart/form-data）
 *
 * POST 字段：name、content、parentId、image（可选图片文件）
 * 图片存入 R2：_guestbook/images/<留言id>.<ext>，单张上限 800 KB。
 * 浏览器端会在图片超过 800 KB 时先压缩为 JPG 再提交。
 *
 * 存储：R2 桶中 _guestbook/messages.json（单文件 JSON，最多 300 条）。
 * 每条记录：id、name、content、image、ip、createdAt、parentId
 */

const BINDING_NAMES = ['udisk2', 'UDISK2', 'R2', 'BUCKET', 'UDISK', 'udisk', 'r2', 'bucket', 'BOOKS', 'R2_BUCKET'];
const STORE_KEY = '_guestbook/messages.json';
const IMAGE_PREFIX = '_guestbook/images/';
const MAX_MESSAGES = 300;
const NAME_MAX = 20;
const CONTENT_MAX = 500;
const RATE_WINDOW_MS = 15000;
const IMAGE_MAX = 800 * 1024;
const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control':
        status === 200 ? 'public, max-age=20, stale-while-revalidate=60' : 'no-store',
    },
  });
}

function resolveBucket(env) {
  for (const name of BINDING_NAMES) {
    if (env[name]) return env[name];
  }
  return null;
}

/** 清洗文本：去掉控制字符，按需合并空白，并限制长度 */
function cleanText(value, max, singleLine) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (singleLine) text = text.replace(/\s+/g, ' ');
  return text.slice(0, max);
}

async function loadDoc(bucket) {
  try {
    const obj = await bucket.get(STORE_KEY);
    if (obj) {
      const doc = JSON.parse(await obj.text());
      if (doc && Array.isArray(doc.messages)) return doc;
    }
  } catch (err) {
    // 存储损坏时按空文档处理，避免接口整体报错
  }
  return { messages: [] };
}

/** 只向客户端暴露公开字段，IP 仅保留在存储中 */
function publicMessage(m) {
  const item = { id: m.id, name: m.name, content: m.content, createdAt: m.createdAt };
  if (m.image) item.image = '/api/file?key=' + encodeURIComponent(m.image);
  return item;
}

/** 组装顶层留言（新→旧）及各自回复（旧→新） */
function buildThreads(doc, limit) {
  const tops = doc.messages
    .filter((m) => !m.parentId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const picked = limit > 0 ? tops.slice(0, limit) : tops;
  return picked.map((m) => {
    const item = publicMessage(m);
    item.replies = doc.messages
      .filter((r) => r.parentId === m.id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(publicMessage);
    return item;
  });
}

/** 超出上限时，从最早的顶层留言开始连同回复一起删除；返回被删除的记录 */
function trimDoc(doc) {
  const removed = [];
  while (doc.messages.length > MAX_MESSAGES) {
    const oldest = doc.messages
      .filter((m) => !m.parentId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!oldest) {
      removed.push(doc.messages.shift());
      continue;
    }
    const drop = doc.messages.filter((m) => m.id === oldest.id || m.parentId === oldest.id);
    removed.push(...drop);
    doc.messages = doc.messages.filter((m) => m.id !== oldest.id && m.parentId !== oldest.id);
  }
  return removed;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const bucket = resolveBucket(env);
  if (!bucket) return json({ error: '存储未绑定（需配置 R2 绑定 udisk2）' }, 503);

  const raw = new URL(request.url).searchParams.get('limit') || '0';
  const limit = Math.min(Math.max(parseInt(raw, 10) || 0, 0), 200);

  try {
    const doc = await loadDoc(bucket);
    const total = doc.messages.filter((m) => !m.parentId).length;
    return json({ total, messages: buildThreads(doc, limit) });
  } catch (err) {
    return json({ error: '读取留言失败' }, 500);
  }
}

/** 解析 JSON 或 multipart/form-data 请求体 */
async function readFields(request) {
  const contentType = request.headers.get('Content-Type') || '';

  if (contentType.indexOf('multipart/form-data') >= 0) {
    const form = await request.formData();
    const file = form.get('image');
    return {
      name: form.get('name'),
      content: form.get('content'),
      parentId: form.get('parentId'),
      image:
        file && typeof file === 'object' && typeof file.size === 'number' && file.name
          ? file
          : null,
    };
  }

  const data = await request.json();
  if (!data || typeof data !== 'object') throw new Error('bad body');
  return { name: data.name, content: data.content, parentId: data.parentId, image: null };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 同源校验，避免被第三方站点跨站提交
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) return json({ error: '跨站请求被拒绝' }, 403);
    } catch (err) {
      return json({ error: '非法来源' }, 403);
    }
  }

  const bucket = resolveBucket(env);
  if (!bucket) return json({ error: '存储未绑定（需配置 R2 绑定 udisk2）' }, 503);

  let fields;
  try {
    fields = await readFields(request);
  } catch (err) {
    return json({ error: '请求格式错误' }, 400);
  }

  const name = cleanText(fields.name, NAME_MAX, true);
  const content = cleanText(fields.content, CONTENT_MAX, false);
  const image = fields.image;

  if (!name) return json({ error: '请填写用户名' }, 400);
  if (!content && !image) return json({ error: '请填写留言内容或选择图片' }, 400);

  let imageExt = '';
  if (image) {
    if (!image.size) return json({ error: '图片为空' }, 400);
    if (image.size > IMAGE_MAX) {
      return json({ error: '图片需小于 800 KB（超过会自动压缩为 JPG）' }, 413);
    }
    imageExt = IMAGE_TYPES[String(image.type || '').toLowerCase()] || '';
    if (!imageExt) return json({ error: '仅支持 JPG、PNG、WebP 或 GIF 图片' }, 400);
  }

  const ip =
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    '';

  try {
    const doc = await loadDoc(bucket);
    const now = Date.now();

    // 同一 IP 15 秒内只能发一条，简单防刷
    const flood = doc.messages.slice(-8).some((m) => {
      const t = Date.parse(m.createdAt);
      return m.ip && ip && m.ip === ip && now - t < RATE_WINDOW_MS;
    });
    if (flood) return json({ error: '发送太频繁，请稍后再试' }, 429);

    // 回复只挂到顶层留言上（回复的回复合并到同一层）
    let parentId = null;
    if (typeof fields.parentId === 'string' && fields.parentId) {
      const parent = doc.messages.find((m) => m.id === fields.parentId);
      if (!parent) return json({ error: '回复的留言不存在' }, 400);
      parentId = parent.parentId || parent.id;
    }

    const message = {
      id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      content,
      ip,
      createdAt: new Date(now).toISOString(),
      parentId,
    };

    if (image) {
      message.image = IMAGE_PREFIX + message.id + '.' + imageExt;
      await bucket.put(message.image, image, {
        httpMetadata: { contentType: String(image.type).toLowerCase() },
        customMetadata: { uploadedAt: message.createdAt, source: 'guestbook' },
      });
    }

    doc.messages.push(message);
    const removed = trimDoc(doc);

    await bucket.put(STORE_KEY, JSON.stringify(doc), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { updatedAt: message.createdAt },
    });

    // 清理被淘汰留言的图片，避免长期占用空间
    const staleImages = removed.filter((m) => m.image).map((m) => m.image);
    if (staleImages.length) {
      try {
        await bucket.delete(staleImages);
      } catch (err) {
        // 清理失败不影响留言发布
      }
    }

    return json({ message: publicMessage(message) }, 201);
  } catch (err) {
    return json({ error: '留言保存失败' }, 500);
  }
}
