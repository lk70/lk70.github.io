/**
 * Cloudflare Pages Function: /api/visits
 *
 * 站点访问量统计：每次调用按天（Asia/Shanghai）累加一次访问，
 * 并返回最近 30 天的访问量合计。
 *
 * 依赖：Pages 项目的 KV 绑定，名称必须为 VISITS。
 * 计数按天分桶存储，键形如 d:2026-10-17，自动过期（90 天）。
 */

const DAY_MS = 86400000;
const TIMEZONE = 'Asia/Shanghai';

/** 生成 N 天前（offsetDays=0 表示今天）的日期键，受时区影响使用本地日历日 */
function dayKey(offsetDays) {
  const d = new Date(Date.now() - offsetDays * DAY_MS);
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d); // en-CA 输出 YYYY-MM-DD
  return 'd:' + ymd;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** 汇总最近 30 天（含今天）的访问量 */
async function sumLast30Days(env) {
  const keys = [];
  for (let i = 0; i < 30; i++) keys.push(dayKey(i));
  const values = await Promise.all(keys.map((k) => env.VISITS.get(k)));
  return values.reduce((total, v) => total + (parseInt(v || '0', 10) || 0), 0);
}

export async function onRequestPost(context) {
  const { env } = context;
  const key = dayKey(0);
  try {
    const current = parseInt((await env.VISITS.get(key)) || '0', 10) || 0;
    await env.VISITS.put(key, String(current + 1), { expirationTtl: 90 * 24 * 3600 });
  } catch (err) {
    // 计数写入失败不应影响页面展示
  }
  return json({ days: 30, count: await sumLast30Days(env) });
}

export async function onRequestGet(context) {
  return json({ days: 30, count: await sumLast30Days(context.env) });
}
