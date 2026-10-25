/**
 * Cloudflare Pages Function: /api/guestbook
 *
 * 留言板：
 *   GET  /api/guestbook?limit=10  读取留言（顶层留言 + 其回复）
 *   POST /api/guestbook            发表留言 / 回复（JSON：name、content、parentId）
 *
 * 存储：R2 桶中 _guestbook/messages.json（单文件 JSON，最多 300 条）。
 * 每条记录：id、name、content、ip、createdAt、parentId
 */

const BINDING_NAMES = ['udisk2', 'UDISK2', 'R2', 'BUCKET', 'UDISK', 'udisk', 'r2', 'bucket', 'BOOKS', 'R2_BUCKET'];
const STORE_KEY = '_guestbook/messages.json';
const MAX_MESSAGES = 300;
const NAME_MAX = 20;
const CONTENT_MAX = 500;
const RATE_WINDOW_MS = 15000;

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
  return { id: m.id, name: m.name, content: m.content, createdAt: m.createdAt };
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

/** 超出上限时，从最早的顶层留言开始连同回复一起删除 */
function trimDoc(doc) {
  while (doc.messages.length > MAX_MESSAGES) {
    const oldest = doc.messages
      .filter((m) => !m.parentId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!oldest) {
      doc.messages.shift();
      continue;
    }
    doc.messages = doc.messages.filter((m) => m.id !== oldest.id && m.parentId !== oldest.id);
  }
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

  let data;
  try {
    data = await request.json();
  } catch (err) {
    return json({ error: '请求格式错误' }, 400);
  }
  if (!data || typeof data !== 'object') return json({ error: '请求格式错误' }, 400);

  const name = cleanText(data.name, NAME_MAX, true);
  const content = cleanText(data.content, CONTENT_MAX, false);
  if (!name) return json({ error: '请填写用户名' }, 400);
  if (!content) return json({ error: '请填写留言内容' }, 400);

  const ip =
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    '';

  try {
    const doc = await loadDoc(bucket);

    // 同一 IP 15 秒内只能发一条，简单防刷
    const now = Date.now();
    const flood = doc.messages.slice(-8).some((m) => {
      const t = Date.parse(m.createdAt);
      return m.ip && ip && m.ip === ip && now - t < RATE_WINDOW_MS;
    });
    if (flood) return json({ error: '发送太频繁，请稍后再试' }, 429);

    // 回复只挂到顶层留言上（回复的回复合并到同一层）
    let parentId = null;
    if (typeof data.parentId === 'string' && data.parentId) {
      const parent = doc.messages.find((m) => m.id === data.parentId);
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
    doc.messages.push(message);
    trimDoc(doc);

    await bucket.put(STORE_KEY, JSON.stringify(doc), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { updatedAt: message.createdAt },
    });

    return json({ message: publicMessage(message) }, 201);
  } catch (err) {
    return json({ error: '留言保存失败' }, 500);
  }
}
