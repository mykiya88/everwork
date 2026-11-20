/**
 * Cloudflare Pages Functions - GAS 프록시
 *
 * /api/data         → 메인 대시보드 데이터 (엣지캐시 120초)
 * /api/mytasks      → 점검원 내 할 일   (엣지캐시 300초, name별)
 * /api/writer       → 작가 현황         (엣지캐시 300초, name별)
 * /api/inspresult   → 점검결과 뷰어     (엣지캐시 600초, biz별)
 *
 * refresh=1 또는 fresh=1 이면 엣지캐시 우회(no-store) + GAS에도 캐시무시 전달
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycby_BDCLS8YJ_FW7WgnTcfKxeBKj9boBuTOBbOTNdgzY-W6Tm4qKR9iquQc0uFyqU1jFmA/exec';

/* ── GAS 비밀 키 (쇼핑몰 점검앱과 같은 방식) ──
   Cloudflare Pages 환경 변수 GAS_KEY(비밀) ↔ GAS 스크립트 속성 EW_GAS_KEY.
   워커가 GAS 를 부를 때마다 k=키 를 붙이고, GAS(EwGate.gs)는 키 없는 api 요청을 거절합니다.
   GAS 주소가 화면이나 캡처로 새어나가도 직접 불러서는 아무것도 받을 수 없습니다.
   환경 변수가 없으면 키 없이 부릅니다(예전과 같음). */
let GAS_K = '';
function gasUrlQ(q) {
  const parts = [];
  if (q) parts.push(q);
  if (GAS_K) parts.push('k=' + encodeURIComponent(GAS_K));
  return GAS_URL + (parts.length ? '?' + parts.join('&') : '');
}

// 엔드포인트별 엣지캐시 시간(초)
// GAS 콜드스타트가 ~7초라 캐시 만료 직후 첫 호출이 느림.
// 워밍 트리거(4시간)와 프리페치로 채우므로 길게 잡아 만료 노출을 줄임.
// 데이터 갱신은 새로고침 버튼(fresh=1)이 즉시 우회하므로 길어도 안전.
const TTL = {
  data: 300,        // 10분 (메인 지표)
  mytasks: 300,     // 10분 (재확인 처리 등 상태변경 빠른 반영)
  myrequests: 600,  // 10분 (재확인 요청 - 작성자 관점)
  writer: 3600,     // 1시간
  reviewer: 3600,   // 1시간
  inspected: 300,  // 1시간 (내 점검 결과)
  complist: 600,   // 1시간 (업체 검색 목록)
  inspresult: 600, // 30분 (점검결과는 자주 안 바뀜)
  aftercare: 1800,  // 30분 (사후 개선 추적)

  // ── 경비(복리후생비 / 출장식비) ──
  // 잔액·한도는 항상 최신이어야 하므로 엣지캐시 0 (매번 GAS 조회)
  wf_config: 600,
  wf_my: 120,
  wf_all: 120,
  wf_delete: 0,
  wf_submit: 0,
  tf_config: 600,
  tf_my: 120,
  tf_day: 20,
  tf_all: 120,
  tf_delete: 0,
  tf_submit: 0,
  tf_submit_shared: 0,
  rb_config: 600,
  rb_my: 120,
  rb_all: 120,
  rb_delete: 0,
  rb_submit: 0,
  td_list: 90,
  td_add: 0,
  td_update: 0,
  td_delete: 0,
  st_month: 300,
  st_detail: 120,
  st_export: 0,
  at_month: 180,
  at_all: 180,
  at_set: 0,
  at_remove: 0,
  at_decide: 0,
  tf_ex_list: 30,
  tf_ex_apply: 0,
  tf_ex_decide: 0,
  tf_ex_cancel: 0,
  exp_login: 0,
  exp_me: 0,

  // ── 공지 / 주간계획 ──
  wk_preview: 0,
  wk_send: 0,
  nt_write: 0,
  nt_edit: 0,
  nt_remove: 0,
  nt_pin: 0,
  nt_list: 300,
  nt_recent: 300,
  pe_get: 30,
  pe_unlock: 0,
  pe_save: 0,

  // ── 숙박 신청 ──
  sl_list: 60,
  sl_add: 0,
  sl_edit: 0,
  sl_remove: 0,
  sl_book: 0,

  // 근태 이관 (일회성)
  at_import: 0,

  // 아침 브리핑 · 출장 준비 (GAS 가 부릅니다)
  brief: 0,
};

// POST(제출) 허용 엔드포인트 — 영수증 base64 업로드
const POST_APIS = new Set(['wf_submit', 'tf_submit', 'tf_submit_shared', 'exp_login', 'pe_save', 'tf_ex_apply', 'tf_ex_decide', 'tf_ex_cancel', 'rb_submit', 'at_set', 'at_remove', 'at_decide', 'st_export', 'td_add', 'td_update', 'td_delete', 'nt_write', 'nt_edit', 'nt_remove', 'nt_pin', 'wk_send', 'sl_add', 'sl_edit', 'sl_remove', 'sl_book', 'at_import', 'pf_target', 'lv_cancel', 'lv_decide', 'fin_import', 'fin_cat', 'fin_undo', 'pay_import', 'pay_del']);

/* 사람이 달라도 내용이 같은 응답들.

   캐시 열쇠를 요청 URL 통째로 만들었는데 토큰이 그 URL 안에 있습니다.
   토큰은 로그인할 때마다 새로 발급되니, 열쇠가 사람마다·로그인할 때마다
   달라져서 사실상 매번 캐시 미스가 났습니다. 다섯 사람이 똑같은 메인 지표를
   각자 GAS 까지 갔다 받아오고 있었다는 뜻입니다.

   아래 API 는 토큰을 빼고 열쇠를 만듭니다. 한 사람이 받아두면 나머지는
   엣지에서 즉시 받습니다. 개인별 응답(경비·주간계획 등)은 토큰으로 사람을
   가리므로 절대 넣으면 안 됩니다. */
const SHARED_APIS = new Set([
  'data', 'complist', 'inspresult', 'writer', 'reviewer', 'aftercare',
  'nt_list', 'nt_recent',
]);

/* 토큰이 있어야 받을 수 있는 조회입니다.

   이 조회들은 화면이 토큰 없이 부르고 있었고, 위 SHARED_APIS 는 캐시 열쇠에서
   토큰을 빼기 때문에 한 사람이 받아둔 응답을 주소만 아는 누구에게나 내줬습니다.
   업체 목록(사업자번호 포함)·점검결과·실적이 로그인 없이 보였다는 뜻입니다.
   이제 워커가 먼저 토큰을 확인하고, 통과한 경우에만 캐시나 GAS 로 갑니다. */
const TOKEN_REQUIRED = new Set([
  'data', 'complist', 'inspresult', 'writer', 'reviewer', 'aftercare',
  'mytasks', 'myrequests', 'inspected',
]);

function cacheKeyFor(url, api) {
  if (!SHARED_APIS.has(api)) return new Request(url.toString(), { method: 'GET' });
  const u = new URL(url.toString());
  u.searchParams.delete('token');
  return new Request(u.toString(), { method: 'GET' });
}

// GAS 로 그대로 넘길 쿼리 파라미터 화이트리스트
const PASS_PARAMS = ['name', 'biz', 'year', 'ym', 'date', 'id', 'token', 'limit', 'q', 'n', 'weekKey', 'team', 'region', 'scope', 'status', 'from', 'to'];

/* ── 응답 공통: 허용한 곳에서만 부를 수 있게(CORS) + 보안 헤더 ──
   예전에는 모든 응답에 Access-Control-Allow-Origin: * 를 달아
   아무 사이트에서나 이 API 를 부를 수 있었습니다. */
const ALLOWED_ORIGINS = [
  'https://evergrow-dash.pages.dev',
  'https://evergrow-insp.pages.dev',
];
function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.indexOf(origin) >= 0) return true;
  // Cloudflare 미리보기 배포 (xxxx.evergrow-dash.pages.dev)
  return /^https:\/\/[a-z0-9-]+\.evergrow-dash\.pages\.dev$/.test(origin);
}
function secure(res, request) {
  const out = new Response(res.body, res);       // 캐시 응답은 헤더를 못 고치므로 새로 만듭니다
  const h = out.headers;
  const origin = request.headers.get('Origin') || '';
  h.delete('Access-Control-Allow-Origin');
  if (originAllowed(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.append('Vary', 'Origin');
  }
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'same-origin');          // 주소의 토큰이 다른 사이트로 새지 않게
  h.set('X-Frame-Options', 'DENY');                 // 다른 사이트가 화면을 몰래 감싸지 못하게
  h.set('Strict-Transport-Security', 'max-age=31536000');
  return out;
}

export default {
  async fetch(request, env, ctx) {
    GAS_K = String(env.GAS_KEY || '').trim();
    return secure(await route(request, env, ctx), request);
  },
};

async function route(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const api = url.pathname.slice('/api/'.length);   // data / mytasks / writer / inspresult

      // CORS 프리플라이트
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      /* D1 로 옮긴 것은 Cloudflare 안에서 바로 처리합니다.
         GAS 를 안 거쳐 콜드 스타트가 없습니다. */
      if (api === 'd1_check') return d1Check(request, env, url);
      if (api === 'brief' && env.DB) {
        /* 2026-11-10 대표 요청으로 아침 9시 브리핑 중단.
           GAS(brief_morning)는 자료를 못 받으면 아무것도 보내지 않고 끝납니다.
           17시 「내일 출장 준비」(day=tomorrow)는 그대로 둡니다.
           다시 켜려면 아래 두 줄만 지우세요. */
        if (String(url.searchParams.get('day') || 'today') !== 'tomorrow') {
          return jsonResponse({ ok: false, error: '아침 브리핑 중단됨 (2026-11-10)' });
        }
        return jsonResponse(await d1Brief(env, url));
      }
      if (api === 'cfg_warm' && env.DB) {
        /* 열쇠 없이 부르면 사람 수만큼 GAS 를 두드리게 할 수 있었습니다 */
        if (!(await serverKeyOk(env, 'cfg_warm', url.searchParams.get('key')))) {
          return jsonResponse({ ok: false, error: '열쇠가 맞지 않습니다.' }, 403);
        }
        return jsonResponse(await d1CfgWarm(env, url));
      }
      if (api === 'warm') return gasWarm(ctx);

      /* 로그인 시도 제한 — PIN 이 4자리라 막지 않으면 금방 맞춰집니다 */
      if (api === 'exp_login' && request.method === 'POST' && env.DB) {
        return loginGuarded(request, env, api);
      }

      if (TOKEN_REQUIRED.has(api)) {
        const au = await d1Verify(url.searchParams.get('token') || '', env);
        if (!au.ok) {
          return jsonResponse({ ok: false, error: au.expired ? au.error : '로그인이 필요합니다.',
                                needLogin: true, expired: !!au.expired }, 401);
        }
      }

      /* clone 을 넘깁니다.
         D1 이 본문을 읽고 나면 원본 request 의 본문은 두 번 못 읽습니다.
         폴백으로 GAS 에 넘길 때 본문이 비어버리는 것을 막습니다. */
      if (D1_APIS.has(api) && env.DB) {
        const d1res = await handleD1(request.clone(), env, ctx, api, url);
        if (d1res) return d1res;        // null 이면 아래 GAS 경로로 진행
      }

      // 제출(POST) — 캐시 없이 GAS 로 그대로 전달
      if (request.method === 'POST') {
        if (!POST_APIS.has(api)) {
          return jsonResponse({ ok: false, error: 'POST 미허용 엔드포인트' }, 405);
        }
        return handlePost(request, api);
      }

      if (TTL.hasOwnProperty(api)) {
        return handleApi(request, ctx, api, url, env);
      }
      return jsonResponse({ ok: false, error: '알 수 없는 요청' }, 404);
    }

    return env.ASSETS.fetch(request);
}

/* ── 서버끼리 부를 때 쓰는 열쇠 ──
   GAS 가 TOKEN_SECRET 으로 「이름|오늘날짜」 를 서명해 key 로 보냅니다.
   열쇠 자체는 오가지 않고, 하루가 지나면 그 서명은 못 씁니다. */
async function serverKeyOk(env, label, key) {
  const secret = String(env.TOKEN_SECRET || '').trim();
  if (!secret || !key) return false;
  const want = sigNorm(await hmacB64u(secret, label + '|' + todayStr()));
  return sigNorm(key) === want;
}

/* ── GAS 깨우기 (로그인 화면에서 부릅니다) ──
   자료는 돌려주지 않습니다. 1분에 한 번만 실제로 두드립니다. */
async function gasWarm(ctx) {
  const cache = caches.default;
  const mark = new Request('https://warm.everwork/mark');
  if (!(await cache.match(mark))) {
    ctx.waitUntil((async () => {
      try { await fetch(gasUrlQ('api=exp_me'), { redirect: 'follow' }); } catch (e) {}
    })());
    ctx.waitUntil(cache.put(mark, new Response('1', {
      headers: { 'Cache-Control': 'public, max-age=60' } })));
  }
  return jsonResponse({ ok: true });
}

/* ── 로그인 시도 제한 ──
   같은 아이디로 15분 안에 5번 틀리면 15분 동안 막습니다.
   같은 접속 주소(IP)에서 15분 안에 20번 틀려도 막습니다.
   맞게 들어오면 그 아이디의 실패 기록은 지웁니다. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ID = 5;
const LOGIN_MAX_IP = 20;

async function loginGuarded(request, env, api) {
  let raw = '';
  try { raw = await request.clone().text(); } catch (e) {}
  let empNo = '';
  try { empNo = String(JSON.parse(raw || '{}').empNo || '').trim().toLowerCase().slice(0, 40); } catch (e) {}
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const since = Date.now() - LOGIN_WINDOW_MS;

  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS login_fail (k TEXT, at INTEGER)').run();
    const q = k => env.DB.prepare(
      'SELECT COUNT(*) AS n FROM login_fail WHERE k = ? AND at > ?').bind(k, since).first();
    const [a, b] = await Promise.all([q('id:' + empNo), q('ip:' + ip)]);
    if ((a && a.n >= LOGIN_MAX_ID) || (b && b.n >= LOGIN_MAX_IP)) {
      return jsonResponse({ ok: false,
        error: '로그인을 여러 번 실패해 잠시 막았습니다. 15분 뒤에 다시 시도하거나 대표에게 문의하세요.' }, 429);
    }
  } catch (e) { /* 기록 실패로 로그인 자체를 막지는 않습니다 */ }

  const res = await handlePost(request, api);
  let ok = false;
  try { ok = !!(JSON.parse(await res.clone().text()) || {}).ok; } catch (e) {}

  try {
    if (ok) {
      await env.DB.prepare('DELETE FROM login_fail WHERE k = ?').bind('id:' + empNo).run();
    } else if (res.status === 200) {          // GAS 가 아니라고 답한 경우만 셉니다 (접속 오류 제외)
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO login_fail (k, at) VALUES (?, ?)').bind('id:' + empNo, now),
        env.DB.prepare('INSERT INTO login_fail (k, at) VALUES (?, ?)').bind('ip:' + ip, now),
        env.DB.prepare('DELETE FROM login_fail WHERE at < ?').bind(now - 24 * 3600e3),
      ]);
    }
  } catch (e) {}
  return res;
}

/* GAS 호출 — 실패하면 잠깐 쉬었다 다시 시도합니다.
   콜드 스타트는 보통 한 번만 더 두드리면 됩니다. */
async function gasGetRetry(gasUrl, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(gasUrl, { method: 'GET', redirect: 'follow' });
      if (r.ok) return r;
      last = r;
      // 400번대는 다시 해도 같은 결과입니다 (429 제외)
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return r;
    } catch (e) { last = null; }
    if (i < tries - 1) await sleepMs(400 * (i + 1));
  }
  return last;
}

function sleepMs(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/* 캐시에 넣어도 되는 응답인지 봅니다.

   GAS 는 인증 실패도 HTTP 200 에 {ok:false, error:'…'} 로 담아 보냅니다.
   워커는 200 이면 무조건 캐시에 넣고 있었습니다. SHARED_APIS 는 캐시 열쇠에
   토큰이 없으므로, 토큰이 만료된 사람의 요청 하나가 들어오는 순간 그 오류가
   전원에게 10분 동안 내려갑니다. 화면이 통째로 비는 원인이 이것이었습니다.
   JSON 이 아닌 응답(GAS 오류 HTML 등)도 넣지 않습니다. */
function cacheable(text) {
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object') return false;
    if (o.ok === false) return false;
    if (o.error) return false;
    return true;
  } catch (e) { return false; }
}

/* ── 공유 조회 기억 (D1) ──
   메인 지표·업체 목록·점검결과처럼 전원에게 같은 응답은
   Cloudflare 엣지 캐시 대신 D1 에 기억합니다(쇼핑몰 점검앱과 같은 방식).
   엣지 캐시는 지역마다 따로이고 수시로 비워져 GAS 콜드스타트(약 7초)가 자주 드러났습니다.
   D1 은 한 곳에 오래 남으므로 누가 언제 열어도 기억한 것을 바로 줍니다.
   한 칸에 넣을 수 있는 크기를 넘는 응답만 예전처럼 엣지 캐시를 씁니다. */
const GC_MAX = 1800000;
let gcReady = false;
const gcInflight = new Map();

async function gcEnsure(db) {
  if (gcReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS gcache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)').run();
  gcReady = true;
}

function gcKey(api, url) {
  const ps = [];
  for (const key of PASS_PARAMS) {
    if (key === 'token') continue;
    const v = url.searchParams.get(key);
    if (v) ps.push(key + '=' + v);
  }
  return api + '?' + ps.sort().join('&');
}

/* 같은 조회가 동시에 몰리면 GAS 에는 한 번만 갑니다 */
function gcRefresh(env, key, gasUrl) {
  if (gcInflight.has(key)) return gcInflight.get(key);
  const p = (async () => {
    try {
      const r = await gasGetRetry(gasUrl);
      if (!r || !r.ok) return null;
      const t = await r.text();
      if (cacheable(t) && t.length < GC_MAX) {
        await env.DB.prepare('INSERT OR REPLACE INTO gcache (k, v, at) VALUES (?, ?, ?)')
          .bind(key, t, Date.now()).run();
      }
      return t;
    } finally { gcInflight.delete(key); }
  })();
  gcInflight.set(key, p);
  return p;
}

function gcResponse(text, tag, at) {
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Cache': tag,
      'x-cached-at': String(at || Date.now()),
    },
  });
}

async function handleShared(env, ctx, api, url, gasUrl, fresh) {
  await gcEnsure(env.DB);
  const key = gcKey(api, url);
  if (!fresh) {
    const row = await env.DB.prepare('SELECT v, at FROM gcache WHERE k = ?').bind(key).first();
    if (row) {
      const ttl = TTL[api] || 120;
      if (Date.now() - row.at > ttl * 1000) {
        ctx.waitUntil(gcRefresh(env, key, gasUrl).catch(() => {}));
      }
      return gcResponse(row.v, 'HIT', row.at);
    }
  }
  const text = await gcRefresh(env, key, gasUrl);
  if (text === null) return null;                        // 실패 → 아래 예전 경로가 처리
  if (text.length >= GC_MAX) return null;                // 너무 큼 → 엣지 캐시 경로
  return gcResponse(text, fresh ? 'FRESH' : 'MISS');
}

async function handleApi(request, ctx, api, url, env) {
  // TTL 0 인 엔드포인트(경비 등)는 항상 캐시 우회
  const fresh = TTL[api] === 0
    || url.searchParams.get('refresh') === '1'
    || url.searchParams.get('fresh') === '1';

  // GAS로 보낼 쿼리 구성 (api + name/biz + 캐시무시 플래그)
  const qs = new URLSearchParams();
  qs.set('api', api);
  for (const key of PASS_PARAMS) {
    const v = url.searchParams.get(key);
    if (v) qs.set(key, v);
  }
  if (fresh) {
    if (api === 'data') qs.set('refresh', '1');
    else qs.set('fresh', '1');
  }
  const gasUrl = gasUrlQ(qs.toString());

  if (env && env.DB && SHARED_APIS.has(api)) {
    try {
      const r = await handleShared(env, ctx, api, url, gasUrl, fresh);
      if (r) return r;
    } catch (e) { /* D1 이 안 되면 아래 엣지 캐시로 */ }
  }

  // 엣지캐시 (Cloudflare Cache API) — fresh면 우회
  const cache = caches.default;
  const cacheKey = cacheKeyFor(url, api);

  /* 오래된 것을 먼저 주고 뒤에서 갱신합니다 (stale-while-revalidate).
     캐시가 만료됐다고 사용자를 기다리게 하지 않습니다. */
  if (!fresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const age = Number(cached.headers.get('x-cached-at') || 0);
      const ttl = TTL[api] || 120;
      const old = age && (Date.now() - age) > ttl * 1000;
      if (old) {
        // 만료됐어도 일단 돌려주고, 뒤에서 조용히 새로 받아둡니다
        ctx.waitUntil((async () => {
          try {
            const r = await gasGetRetry(gasUrl);
            if (!r || !r.ok) return;
            const t = await r.text();
            if (!cacheable(t)) return;        // 실패 응답으로 덮지 않습니다
            await cache.put(cacheKey, new Response(t, {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=' + (ttl * 6),
                'x-cached-at': String(Date.now()),
              },
            }));
          } catch (e) {}
        })());
      }
      return cached;
    }
  }

  try {
    /* GAS 는 한동안 안 쓰면 잠듭니다. 깨어나는 사이에 들어온 요청은
       실패하거나 그냥 끊깁니다. 로그인 직후처럼 여러 요청이 한꺼번에
       몰릴 때 화면이 통째로 비는 원인이었습니다.
       한 번 더 두드려 보면 대부분 두 번째에 응답합니다. */
    const response = await gasGetRetry(gasUrl);
    if (!response || !response.ok) {
      return jsonResponse({
        error: true,
        message: 'GAS ' + (response ? response.status : '응답 없음'),
        retry: true,
      }, 502);
    }
    const data = await response.text();

    const ttl = TTL[api] || 120;
    const res = new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // 엣지에는 넉넉히 두고, 신선도는 x-cached-at 으로 직접 판단합니다
        'Cache-Control': fresh ? 'no-store' : ('public, max-age=' + (ttl * 6)),
        'x-cached-at': String(Date.now()),
      },
    });

    // 엣지에 저장 (fresh 가 아니고, 성공 응답일 때만)
    if (!fresh && cacheable(data)) {
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    return res;
  } catch (err) {
    return jsonResponse({ error: true, message: err.message }, 500);
  }
}

/**
 * 제출(POST) 프록시
 * 브라우저 → 워커 → GAS(doPost)
 * GAS 는 302 로 googleusercontent 로 넘기므로 redirect: 'follow' 필수.
 * Content-Type 은 text/plain 으로 보내야 GAS 가 postData.contents 를 그대로 받습니다.
 */
async function handlePost(request, api) {
  try {
    const raw = await request.text();

    // 클라이언트가 api 를 안 넣었어도 경로 기준으로 보정
    let payload = raw;
    try {
      const obj = JSON.parse(raw || '{}');
      obj.api = api;
      payload = JSON.stringify(obj);
    } catch (e) {
      return jsonResponse({ ok: false, error: '잘못된 요청 본문' }, 400);
    }

    /* 제출도 GAS 가 자고 있으면 실패합니다.
       로그인(exp_login)이 여기로 오므로 특히 중요합니다. */
    let response = null, text = '';
    for (let i = 0; i < 3; i++) {
      try {
        response = await fetch(gasUrlQ(''), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: payload,
          redirect: 'follow',
        });
        text = await response.text();
        if (response.ok) break;
        // 400번대는 다시 보내도 같습니다 (429 제외)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
      } catch (e) { response = null; }
      if (i < 2) await sleepMs(500 * (i + 1));
    }

    if (!response) {
      return jsonResponse({ ok: false, error: 'GAS 응답 없음', retry: true }, 502);
    }
    if (!response.ok) {
      return jsonResponse({ ok: false, error: 'GAS ' + response.status, retry: true }, 502);
    }

    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      /* D1 응답은 브라우저가 들고 있으면 안 됩니다.
         방금 저장한 것이 목록에 안 보이는 일이 생깁니다. */
      'Cache-Control': 'no-store',
    },
  });
}

/* ============================================================
   D1 — 달력(근태) + 할 일

   GAS 를 거치지 않고 Cloudflare 안에서 바로 처리합니다.
   콜드 스타트가 없어 항상 0.05초 안에 응답합니다.

   공휴일·근무지역·주간계획은 시트에서 계속 관리하고,
   워커가 주기적으로 복사해둔 걸 씁니다.
   ============================================================ */

const D1_APIS = new Set([
  'at_month', 'at_all', 'at_set', 'at_remove', 'at_decide',
  'td_list', 'td_add', 'td_update', 'td_delete',
  'nt_list', 'nt_recent', 'nt_write', 'nt_edit', 'nt_remove', 'nt_pin',
  'sl_list', 'sl_add', 'sl_edit', 'sl_remove', 'sl_book',
  'at_import',
  'pf_year', 'pf_target',
  'lv_list', 'lv_cancel', 'lv_decide',
  'fin_list', 'fin_import', 'fin_cat', 'fin_undo', 'pay_list', 'pay_import', 'pay_del',
]);

/* D1 에만 있는 기능입니다. GAS 로 넘기면 안 됩니다. */
const D1_ONLY = new Set([
  'sl_list', 'sl_add', 'sl_edit', 'sl_remove', 'sl_book',
  'at_import',
  'pf_year', 'pf_target',
  'lv_list', 'lv_cancel', 'lv_decide',
  'fin_list', 'fin_import', 'fin_cat', 'fin_undo', 'pay_list', 'pay_import', 'pay_del',
]);

/* 달력 구분 —— 이모지 대신 한 글자를 씁니다.
   이모지는 기기마다 모양이 다르고, 달력처럼 촘촘한 화면에서는
   색과 모양이 제각각이라 시선을 흩뜨립니다.
   한 글자는 어느 기기에서나 같고 글자 크기에도 잘 붙습니다. */
const AT_TYPES_D1 = [
  { key: '근무',     work: true,  needOk: false, ic: '근', color: '#1366C9', detail: true },
  { key: '월차',     work: false, needOk: true,  ic: '월', color: '#F06325', off: true },
  { key: '공휴일',   work: false, needOk: false, ic: '휴', color: '#D63A2E' },
  { key: '교육',     work: true,  needOk: false, ic: '교', color: '#6D28D9' },
  { key: '재택근무', work: true,  needOk: false, ic: '재', color: '#1B8B45' },
  { key: '병가',     work: false, needOk: false, ic: '병', color: '#0369A1', off: true },
  { key: '경조',     work: false, needOk: false, ic: '경', color: '#475569', off: true },
  { key: '기타',     work: false, needOk: false, ic: '기', color: '#838C9B' },
];
const AT_TASKS_D1 = [
  { key: '현장',   ic: '현', color: '#1366C9' },
  { key: '이행',   ic: '이', color: '#6D28D9' },
  { key: '쇼핑몰', ic: '쇼', color: '#F06325' },
  /* 2026-11 추가 — 서면점검(통신팀, 12월 집중)과 강의 횟수 */
  { key: '서면',   ic: '서', color: '#0F766E' },
  { key: '강의',   ic: '강', color: '#B45309' },
];
const TD_STATES_D1 = ['대기', '진행중', '완료'];
const TD_PRIOS_D1 = [
  { key: '긴급', color: '#D63A2E', rank: 0 },
  { key: '보통', color: '#1366C9', rank: 1 },
  { key: '낮음', color: '#838C9B', rank: 2 },
];

/* ── 진단: /api/d1_check ── */
async function d1Check(request, env, url) {
  const token = url.searchParams.get('token') || '';
  const secret = String(env.TOKEN_SECRET || '');

  /* 열쇠 길이·지문·테이블 건수는 대표 토큰으로만 봅니다.
     예전에는 주소만 알면 누구나 볼 수 있었습니다.
     토큰이 없거나 대표가 아니면 「연결됐는지」와 「이 토큰이 통하는지」만 알려줍니다. */
  const me = token ? await d1Verify(token, env) : { ok: false };
  if (!(me.ok && me.role === 'admin')) {
    return jsonResponse({
      ok: true,
      d1연결: !!env.DB,
      비밀키설정: !!secret,
      GAS키설정: !!GAS_K,
      워커검증: !token ? '토큰 없음' : (me.ok ? 'OK' : (me.error || '실패')),
      안내: '자세한 진단은 대표 계정 토큰으로만 볼 수 있습니다.',
    });
  }
  const out = {
    ok: true,
    d1연결: !!env.DB,
    비밀키설정: !!secret,
    비밀키길이: secret.length,
    비밀키앞뒤공백: secret !== secret.trim(),
    비밀키지문: await keyFingerprint(secret.trim()),
    토큰받음: !!token,
    지금: nowStr(),
  };

  if (token) {
    const diag = {};
    const v = await d1Verify(token, env, diag);
    out.워커검증 = v.ok
      ? ('OK — ' + v.name + ' / ' + v.role + ' / 만료 ' + new Date(v.exp + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '))
      : v.error;
    out.상세 = diag;

    // GAS 도 같은 토큰을 받아보게 해서 어느 쪽 문제인지 가립니다
    try {
      const r = await fetch(gasUrlQ('api=exp_me&token=' + encodeURIComponent(token)),
                            { redirect: 'follow' });
      const t = (await r.text()).slice(0, 300);
      out.GAS검증 = t.replace(/"token"\s*:\s*"[^"]*"/g, '"token":"(가림)"');
    } catch (e) { out.GAS검증 = '호출 실패: ' + e.message; }
  }

  if (env.DB) {
    try {
      const r = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'").all();
      out.테이블 = (r.results || []).map(x => x.name);
      const cnt = {};
      for (const t of ['attend', 'todo', 'notice', 'cfg', 'stay', 'login_fail', 'gcache']) {
        try {
          const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM ' + t).first();
          cnt[t] = c ? c.n : 0;
        } catch (e) { cnt[t] = '없음'; }
      }
      out.건수 = cnt;
    } catch (e) { out.테이블 = '조회 실패: ' + e.message; }
  }
  return jsonResponse(out);
}

/* ── 토큰 검증 (GAS 와 같은 방식) ──
   GAS 쪽 구현이 조금씩 다를 수 있어 아래를 모두 흡수합니다.
   · 서명 대상: 원문(name|role|exp) 또는 base64 로 감싼 본문
   · 서명 표기: base64 / base64url, 패딩(=) 유무
   · 전달 과정: 쿼리스트링에서 '+' 가 공백으로 바뀐 경우
   열쇠가 같으면 어떤 조합이든 통과합니다. */
async function d1Verify(token, env, diag) {
  token = String(token || '').replace(/\s+/g, '');
  if (!token) return { ok: false, error: '로그인이 필요합니다.' };
  const dot = token.lastIndexOf('.');
  if (dot < 1) return { ok: false, error: '토큰 형식 오류' };

  // 붙여넣을 때 앞뒤 공백·줄바꿈이 섞이는 일이 잦습니다
  const secret = String(env.TOKEN_SECRET || '').trim();
  if (!secret) return { ok: false, error: 'TOKEN_SECRET 미설정', fallback: true };

  const bodyPart = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let decoded = null;
  try { decoded = b64urlDecode(bodyPart); } catch (e) {}

  // 본문이 base64 로 감싸져 있을 수도, 원문 그대로일 수도 있습니다
  const claims = (decoded && decoded.split('|').length === 3) ? decoded
               : (bodyPart.split('|').length === 3 ? bodyPart : null);

  /* 서명 대상은 원문 또는 base64 본문, 바이트는 UTF-8 뿐입니다.

     예전에는 한글을 '?' 한 바이트로 뭉갠 버전도 받아줬습니다.
     GAS 가 문자열을 그대로 서명해 그렇게 나왔기 때문인데,
     그 탓에 이름이 다른 사람의 토큰이 같은 서명을 갖게 되어
     이름만 바꿔치기하면 남으로 행세할 수 있었습니다.
     GAS 쪽(expauth_sign_)을 UTF-8 바이트 서명으로 고쳤으므로
     여기서도 그 호환 경로를 없앱니다. */
  const texts = [];
  if (decoded) texts.push(['원문', decoded]);
  if (!decoded || decoded !== bodyPart) texts.push(['base64 본문', bodyPart]);

  const cands = texts.map(([label, t]) => [label + '/UTF-8', utf8Bytes(t)]);

  let hit = -1;
  for (let i = 0; i < cands.length; i++) {
    const mine = await hmacB64uBytes(secret, cands[i][1]);
    if (sigNorm(mine) === sigNorm(sig)) { hit = i; break; }
  }
  if (diag) {
    diag.서명대상 = hit < 0 ? '일치 없음' : cands[hit][0];
    diag.내서명 = sigNorm(await hmacB64uBytes(secret, cands[0][1])).slice(0, 12) + '…';
    diag.받은서명 = sigNorm(sig).slice(0, 12) + '…';
  }
  if (hit < 0) {
    // 열쇠가 GAS 와 다를 수 있습니다. 앱이 멈추지 않게 GAS 로 넘깁니다.
    return { ok: false, error: '유효하지 않은 토큰입니다.', fallback: true };
  }
  if (!claims) return { ok: false, error: '토큰 형식 오류', fallback: true };

  const p = claims.split('|');
  if (Number(p[2]) < Date.now()) {
    return { ok: false, error: '세션이 만료되었습니다. 다시 로그인해주세요.', expired: true };
  }
  return { ok: true, name: p[0], role: p[1] === 'admin' ? 'admin' : 'user', exp: Number(p[2]) };
}

async function hmacB64u(secret, msg) {
  return hmacB64uBytes(secret, utf8Bytes(msg));
}

async function hmacB64uBytes(secret, bytes) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', key, bytes);
  return b64urlFromBytes(new Uint8Array(raw));
}

function utf8Bytes(s) { return new TextEncoder().encode(String(s)); }

// 쿼리스트링을 지나며 '+' 가 공백이 되는 일이 있어 되돌린 뒤 비교합니다
function sigNorm(s) {
  return String(s || '').trim()
    .replace(/ /g, '+')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* 열쇠 자체는 드러내지 않고, 같은 열쇠인지만 확인하는 지문입니다 */
async function keyFingerprint(secret) {
  if (!secret) return '(없음)';
  return (await hmacB64u(secret, 'everwork-key-check')).slice(0, 12);
}

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── 설정 데이터 (시트에서 가져와 D1 에 보관) ── */
/* 시트에서 오는 값들입니다. 자주 바뀌지 않아 넉넉히 잡습니다.
   짧게 잡으면 만료될 때마다 GAS 콜드스타트(약 7초)를 사람이 기다립니다. */
const CFG_TTL = 6 * 60 * 60 * 1000;      // 6시간

/* GAS 를 기다리는 최대 시간. 이 안에 안 오면 없는 채로 그리고
   뒤에서 마저 받아둡니다. 다음 열 때는 이미 채워져 있습니다. */
const CFG_WAIT_MS = 1500;

async function d1Cfg(env, ctx, key, gasApi, params, waitMs) {
  const row = await env.DB.prepare('SELECT v, at FROM cfg WHERE k = ?').bind(key).first();
  const now = Date.now();

  if (row && (now - row.at) < CFG_TTL) {
    const v = safeJson(row.v, null);
    if (v && v.ok !== false) return v;
  }

  const refresh = (async () => {
    try {
      const qs = new URLSearchParams({ api: gasApi, ...(params || {}) });
      const r = await fetch(gasUrlQ(qs.toString()), { redirect: 'follow' });
      if (!r.ok) return null;
      const t = await r.text();
      const parsed = JSON.parse(t);
      /* GAS 가 오류를 돌려준 걸 저장해두면 그 뒤로 계속 그 값을 씁니다.
         성공한 응답만 남깁니다. */
      if (parsed && parsed.ok === false) return null;
      await env.DB.prepare(
        'INSERT INTO cfg (k, v, at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at'
      ).bind(key, t, Date.now()).run();
      return parsed;
    } catch (e) { return null; }
  })();

  // 오래된 값이라도 있으면 그걸 주고 갱신은 뒤로 미룹니다
  if (row) {
    if (ctx) ctx.waitUntil(refresh);
    const v = safeJson(row.v, null);
    if (v && v.ok !== false) return v;
  }

  // 처음이라 아무것도 없을 때만 잠깐 기다립니다
  const wait = waitMs === undefined ? CFG_WAIT_MS : waitMs;
  if (ctx) ctx.waitUntil(refresh);
  if (wait <= 0) return null;
  return await Promise.race([
    refresh,
    new Promise(res => setTimeout(() => res(null), wait)),
  ]);
}

/* 시트 값을 미리 받아 D1 에 채워둡니다.
   GAS 시간 트리거가 30분마다 불러주면 사람이 기다릴 일이 없습니다. */
async function d1CfgWarm(env, url) {
  const ym = String(url.searchParams.get('ym') || '').trim() || thisMonthStr();
  const next = (() => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 1));
    return d.getUTCFullYear() + '-' + pad2n(d.getUTCMonth() + 1);
  })();

  const done = [];
  const load = async (key, api, params) => {
    try {
      const qs = new URLSearchParams({ api, ...(params || {}) });
      const r = await fetch(gasUrlQ(qs.toString()), { redirect: 'follow' });
      if (!r.ok) return;
      const t = await r.text();
      await env.DB.prepare(
        'INSERT INTO cfg (k, v, at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at'
      ).bind(key, t, Date.now()).run();
      done.push(key);
    } catch (e) {}
  };

  await Promise.all([
    load('regions', 'at_cfgRegions', {}),
    load('members', 'at_cfgMembers', {}),
    load('holidays|' + ym, 'at_cfgHolidays', { ym }),
    load('holidays|' + next, 'at_cfgHolidays', { ym: next }),
  ]);

  const members = await d1Members(env, null);
  await Promise.all([].concat(
    members.map(nm => load('plan|' + nm + '|' + ym, 'at_cfgPlan', { name: nm, ym })),
    members.map(nm => load('plan|' + nm + '|' + next, 'at_cfgPlan', { name: nm, ym: next }))
  ));

  return { ok: true, ym, next, 채움: done.length, members: members.length };
}

/* ── 달력 조회 ── */
async function d1AtMonth(env, ctx, au, url) {
  const ym = String(url.searchParams.get('ym') || '').trim() || thisMonthStr();
  const name = (au.role === 'admin' && url.searchParams.get('name'))
    ? String(url.searchParams.get('name')).trim() : au.name;

  const from = ym + '-01';
  const to = ym + '-31';

  // 근태 + 할 일 + 숙박 + 설정을 동시에
  const [rows, todos, stays, cfg] = await Promise.all([
    env.DB.prepare(
      'SELECT * FROM attend WHERE name = ? AND date >= ? AND date <= ? AND status != ? ORDER BY date'
    ).bind(name, from, to, '취소').all(),
    env.DB.prepare(
      'SELECT id, title, prio, status, progress, deadline FROM todo ' +
      'WHERE who = ? AND deleted = 0 AND deadline >= ? AND deadline <= ?'
    ).bind(name, from, to).all(),
    slRowsOfMonth(env, ym, name).catch(() => []),
    d1AtConfig(env, ctx, name, ym),
  ]);

  // 신청 기간을 날짜별로 펼쳐 달력 칸에 배지를 찍습니다
  const stayDays = {};
  stays.forEach(x => { slSpread(x, ym).forEach(ds => { stayDays[ds] = x.status; }); });

  const list = (rows.results || []).map(r => ({
    id: r.id, date: r.date, type: r.type, reason: r.reason || '',
    memo: r.reason || '', status: r.status,
    tasks: safeJson(r.tasks, []),
    at: r.at, decidedAt: r.decided_at || '', decidedBy: r.decided_by || '',
  }));

  const days = {};
  list.forEach(x => { days[x.date] = x; });

  const todoByDate = {};
  const today = todayStr();
  (todos.results || []).forEach(t => {
    (todoByDate[t.deadline] = todoByDate[t.deadline] || []).push({
      id: t.id, title: t.title, prio: t.prio, status: t.status,
      progress: t.progress, overdue: t.status !== '완료' && t.deadline < today,
    });
  });

  const hol = cfg.holidays || {};
  const plan = cfg.plan || {};
  const planLabel = {};
  Object.keys(plan).forEach(d => { planLabel[d] = atPlanLabel(plan[d]); });

  // 계획과 어긋나는 날
  const conflicts = [];
  Object.keys(plan).forEach(d => {
    const rec = days[d];
    if (!rec) return;
    const t = AT_TYPES_D1.find(x => x.key === rec.type);
    if (t && !t.work) {
      const lab = planLabel[d];
      if (lab && lab !== 'OFF') conflicts.push({ date: d, type: rec.type, plan: lab });
    }
  });

  return {
    ok: true, name, ym,
    list, days, todos: todoByDate,
    holidays: hol, plan, planLabel, conflicts,
    stays, stayDays, canBook: slCanBook(au),
    types: AT_TYPES_D1, tasks: AT_TASKS_D1, regions: cfg.regions || [],
    summary: atSummary(ym, list, hol),
  };
}

async function d1AtConfig(env, ctx, name, ym) {
  const [hol, regions, plan] = await Promise.all([
    d1Cfg(env, ctx, 'holidays|' + ym, 'at_cfgHolidays', { ym }),
    d1Cfg(env, ctx, 'regions', 'at_cfgRegions', {}),
    d1Cfg(env, ctx, 'plan|' + name + '|' + ym, 'at_cfgPlan', { name, ym }),
  ]);
  return {
    holidays: (hol && hol.map) || hol || {},
    regions: asList(regions),
    plan: (plan && plan.map) || plan || {},
  };
}

/* ── 팀 전체 ── */
async function d1AtAll(env, ctx, au, url) {
  const ym = String(url.searchParams.get('ym') || '').trim() || thisMonthStr();
  const from = ym + '-01', to = ym + '-31';

  const rows = await env.DB.prepare(
    'SELECT * FROM attend WHERE date >= ? AND date <= ? AND status != ? ORDER BY date'
  ).bind(from, to, '취소').all();

  const members = await d1Members(env, ctx);
  const hol = (await d1Cfg(env, ctx, 'holidays|' + ym, 'at_cfgHolidays', { ym })) || {};
  const holMap = hol.map || hol || {};

  const byDate = {}, byName = {};
  (rows.results || []).forEach(r => {
    /* 팀 달력 칸에도 무슨 일을 했는지 보여주려면 tasks 가 필요합니다.
       예전에는 이름과 구분만 보내서 색 배지 하나로만 나왔습니다. */
    (byDate[r.date] = byDate[r.date] || []).push({
      id: r.id, name: r.name, type: r.type, status: r.status,
      tasks: safeJson(r.tasks, []),
    });
    (byName[r.name] = byName[r.name] || []).push(r);
  });

  // 사람별 계획
  const planByDate = {};
  /* 사람 수만큼 GAS 를 부르게 되므로 여기서는 기다리지 않습니다.
     캐시에 있는 것만 쓰고, 없으면 뒤에서 채워둡니다. */
  await Promise.all(members.map(async nm => {
    const p = await d1Cfg(env, ctx, 'plan|' + nm + '|' + ym, 'at_cfgPlan', { name: nm, ym }, 0);
    const map = (p && p.map) || p || {};
    Object.keys(map).forEach(d => {
      const lab = atPlanLabel(map[d]);
      if (!lab) return;
      (planByDate[d] = planByDate[d] || []).push({
        name: nm, label: lab,
        hyunjang: Number(map[d].hyunjang) || 0,
        ihaeng: Number(map[d].ihaeng) || 0,
        shopping: String(map[d].shopping || ''),
        region: String(map[d].region || ''),
      });
    });
  }));

  const summary = members.map(nm => {
    const list = (byName[nm] || []).map(r => ({
      date: r.date, type: r.type, status: r.status,
    }));
    return { name: nm, ...atSummary(ym, list, holMap) };
  });

  /* 승인 대기 목록에는 휴가 사유 원문이 들어갑니다.
     병가·경조 사유는 건강과 가족사라 전원에게 보낼 값이 아닙니다.
     화면에서도 대표님만 보는 자리이니 서버에서 아예 빼고 보냅니다. */
  const canSeeReason = au.role === 'admin';
  const waiting = (rows.results || [])
    .filter(r => r.status === '대기')
    .map(r => ({
      id: r.id, name: r.name, date: r.date, type: r.type,
      reason: (canSeeReason || r.name === au.name) ? (r.reason || '') : '',
    }));

  const stays = await slRowsOfMonth(env, ym, '').catch(() => []);
  const stayByDate = {};
  stays.forEach(x => {
    slSpread(x, ym).forEach(ds => {
      (stayByDate[ds] = stayByDate[ds] || []).push({ id: x.id, name: x.name, status: x.status });
    });
  });

  return {
    ok: true, ym, members, byDate, planByDate, summary, waiting,
    stays, stayByDate, canBook: slCanBook(au),
    holidays: holMap, types: AT_TYPES_D1, weekdays: countWeekdays(ym, holMap),
  };
}

/* D1 은 쿼리 하나에 넘길 수 있는 값이 100개까지입니다.
   넘기면 쿼리가 통째로 실패하는데, 예전에는 그 실패를 빈 catch 가 삼켜서
   중복 확인이나 짝 맞추기가 조용히 꺼진 채로 진행됐습니다.
   나눠서 물어보고, 실패는 숨기지 않고 호출부로 올립니다. */
async function d1Chunked(env, items, perChunk, build) {
  const out = [];
  for (let i = 0; i < items.length; i += perChunk) {
    const part = items.slice(i, i + perChunk);
    const q = build(part);
    const r = await env.DB.prepare(q.sql).bind(...q.args).all();
    out.push(...(r.results || []));
  }
  return out;
}

/* 무엇이 오든 배열로 만들어 돌려줍니다.
   여기서 배열이 아닌 게 새어나가면 뒤에서 map 이 터집니다. */
function asList(c) {
  if (Array.isArray(c)) return c;
  if (c && Array.isArray(c.list)) return c.list;
  if (c && Array.isArray(c.members)) return c.members;
  return [];
}

async function d1Members(env, ctx) {
  return asList(await d1Cfg(env, ctx, 'members', 'at_cfgMembers', {}));
}

/* 담당자 고르는 칸에 쓰는 순서입니다.
   여기 적힌 사람이 먼저 나오고, 나머지는 시트 순서를 따릅니다.
   새로 들어온 사람은 시트에만 추가하면 자동으로 목록에 붙습니다. */
const TD_MEMBER_ORDER = ['장봉기', '신정임', '양준영', '김태현', '박승원'];

async function d1MembersOrdered(env, ctx) {
  const list = await d1Members(env, ctx);
  const rank = nm => {
    const i = TD_MEMBER_ORDER.indexOf(nm);
    return i < 0 ? TD_MEMBER_ORDER.length : i;
  };
  return list.slice().sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : list.indexOf(a) - list.indexOf(b);
  });
}

/* ── 달력 저장 ── */
async function d1AtSet(env, ctx, au, body) {
  const dates = (body.dates || []).map(x => String(x).trim()).filter(Boolean);
  const type = String(body.type || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 200);
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];

  if (!dates.length) return { ok: false, error: '날짜를 선택하세요.' };
  /* 날짜 형식을 봅니다. 엉뚱한 값이 한 번 들어가면 달력·브리핑·정산이
     모두 date 범위로 조회하기 때문에 어디에도 안 나오면서 DB 에만 남습니다. */
  if (dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
    return { ok: false, error: '날짜 형식이 올바르지 않습니다.' };
  }
  if (dates.length > 62) return { ok: false, error: '한 번에 62일까지만 등록할 수 있습니다.' };
  const t = AT_TYPES_D1.find(x => x.key === type);
  if (!t) return { ok: false, error: '구분을 확인하세요.' };
  if (type === '기타' && !reason) return { ok: false, error: '기타는 내용을 적어주세요.' };

  const clean = tasks
    .slice(0, 20)
    .map(x => ({
      kind: String(x.kind || '').trim(),
      region: String(x.region || '').trim().slice(0, 40),
      count: Math.max(0, Math.min(99, Number(x.count) || 0)),
    }))
    .filter(x => x.count > 0 && AT_TASKS_D1.some(k => k.key === x.kind));

  const status = t.needOk && au.role !== 'admin' ? '대기' : '확정';
  const now = nowStr();

  /* 같은 날 기록은 덮어씁니다. 그런데 월차를 근무로 덮으면
     신청이 조용히 사라져 승인하신 분은 모르고 지나갑니다.
     지워지는 휴가가 있으면 취소로 알립니다. */
  let replaced = [];
  if (!atIsOff(type)) {
    try {
      const prev = await d1Chunked(env, dates, 80, part => ({
        sql: 'SELECT date, type FROM attend WHERE name = ? AND date IN ('
           + part.map(() => '?').join(',') + ')',
        args: [au.name, ...part],
      }));
      replaced = prev.filter(r => atIsOff(r.type));
    } catch (e) { replaced = []; }
  }

  const stmts = [];

  for (const d of dates) {
    // 같은 날 기존 기록은 지웁니다 (덮어쓰기)
    stmts.push(env.DB.prepare('DELETE FROM attend WHERE name = ? AND date = ?').bind(au.name, d));
    stmts.push(env.DB.prepare(
      'INSERT INTO attend (id, name, date, type, reason, status, tasks, at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(newId('AT'), au.name, d, type, reason, status,
           t.detail ? JSON.stringify(clean) : '', now));
  }
  await env.DB.batch(stmts);

  // 덮어써서 사라진 휴가를 먼저 알립니다
  if (replaced.length) {
    const byType = {};
    replaced.forEach(r => { (byType[r.type] = byType[r.type] || []).push(r.date); });
    Object.keys(byType).forEach(tp => {
      const ds = byType[tp].slice().sort();
      atNotify(env, ctx, '취소', {
        name: au.name, type: tp, reason: '', status: '',
        dates: ds, from: ds[0], to: ds[ds.length - 1],
        count: ds.length, by: au.name,
      });
    });
  }

  // 휴가성 구분만 알립니다 (근무·교육 등은 조용히)
  if (atIsOff(type)) {
    const sorted = dates.slice().sort();
    atNotify(env, ctx, '신청', {
      name: au.name, type, reason, status,
      dates: sorted,
      from: sorted[0], to: sorted[sorted.length - 1],
      count: sorted.length,
      needApproval: status === '대기',
    });
  }

  return {
    ok: true, count: dates.length, type,
    needApproval: status === '대기',
  };
}

async function d1AtRemove(env, ctx, au, body) {
  const id = String(body.id || '').trim();
  if (!id) return { ok: false, error: 'ID가 없습니다.' };
  const row = await env.DB.prepare('SELECT * FROM attend WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: '기록을 찾을 수 없습니다.' };
  if (au.role !== 'admin') {
    if (row.name !== au.name) return { ok: false, error: '본인 것만 삭제할 수 있습니다.' };
    if (row.status === '확정' && AT_TYPES_D1.find(x => x.key === row.type && x.needOk)) {
      return { ok: false, error: '승인된 항목은 대표만 삭제할 수 있습니다.' };
    }
  }
  await env.DB.prepare('DELETE FROM attend WHERE id = ?').bind(id).run();

  if (atIsOff(row.type)) {
    atNotify(env, ctx, '취소', {
      name: row.name, type: row.type, reason: row.reason || '',
      status: row.status, dates: [row.date], from: row.date, to: row.date,
      count: 1, by: au.name,
    });
  }

  return { ok: true, id };
}

async function d1AtDecide(env, ctx, au, body) {
  if (au.role !== 'admin') return { ok: false, error: '대표만 승인할 수 있습니다.' };
  const id = String(body.id || '').trim();
  const ok = body.approve !== false;
  const row = await env.DB.prepare('SELECT * FROM attend WHERE id = ?').bind(id).first();
  const status = ok ? '확정' : '취소';
  await env.DB.prepare(
    'UPDATE attend SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?'
  ).bind(status, nowStr(), au.name, id).run();

  // 신청한 사람이 결과를 바로 알 수 있게 알립니다
  if (row && atIsOff(row.type)) {
    atNotify(env, ctx, ok ? '승인' : '반려', {
      name: row.name, type: row.type, reason: row.reason || '',
      status, dates: [row.date], from: row.date, to: row.date,
      count: 1, by: au.name,
    });
  }

  return { ok: true, id, status };
}

/* ── 할 일 ── */
async function d1TdList(env, ctx, au, url) {
  const scope = String(url.searchParams.get('scope') || 'mine');
  const status = String(url.searchParams.get('status') || '');

  /* 할 일 판은 다섯 사람이 함께 쓰는 것이라 '전체' 보기는 그대로 둡니다.
     다만 예전에는 mine·sent 가 아닌 값이 오기만 하면 — 오타든 빈 값이든 —
     사람 조건이 통째로 빠져 전체가 나갔습니다. 모르는 값은 내 것으로 봅니다. */
  const scopeOk = (scope === 'mine' || scope === 'sent' || scope === 'all') ? scope : 'mine';

  let sql = 'SELECT * FROM todo WHERE deleted = 0';
  const args = [];
  if (scopeOk === 'mine') { sql += ' AND who = ?'; args.push(au.name); }
  else if (scopeOk === 'sent') { sql += ' AND by_name = ?'; args.push(au.name); }
  if (status) { sql += ' AND status = ?'; args.push(status); }

  /* 사람별 집계는 건수만 있으면 되는데 예전에는 할 일 전체를 가져와
     워커에서 셌습니다. 세는 일은 DB 가 훨씬 잘합니다.
     목록 쪽도 상한을 둡니다 — 화면에 500건 넘게 뿌릴 일은 없습니다. */
  const today = todayStr();
  sql += ' ORDER BY at DESC LIMIT 500';

  const [rows, agg] = await Promise.all([
    env.DB.prepare(sql).bind(...args).all(),
    env.DB.prepare(
      `SELECT who, status, COUNT(*) AS n,
              SUM(CASE WHEN status != '완료' AND deadline != '' AND deadline < ?
                       THEN 1 ELSE 0 END) AS od
         FROM todo WHERE deleted = 0 GROUP BY who, status`
    ).bind(today).all(),
  ]);
  const list = (rows.results || []).map(r => {
    const dd = r.deadline ? daysBetween(today, r.deadline) : null;
    return {
      id: r.id, at: r.at, by: r.by_name, who: r.who,
      title: r.title, body: r.body || '', deadline: r.deadline || '',
      prio: r.prio, status: r.status, progress: r.progress,
      doneAt: r.done_at || '', memo: r.memo || '',
      dday: dd, overdue: r.status !== '완료' && dd !== null && dd < 0,
      mine: r.who === au.name,
      canEdit: au.role === 'admin' || r.who === au.name || r.by_name === au.name,
    };
  });

  list.sort((a, b) => {
    if ((a.status === '완료') !== (b.status === '완료')) return a.status === '완료' ? 1 : -1;
    if (a.dday === null && b.dday !== null) return 1;
    if (b.dday === null && a.dday !== null) return -1;
    if (a.dday !== b.dday && a.dday !== null) return a.dday - b.dday;
    const ra = TD_PRIOS_D1.findIndex(p => p.key === a.prio);
    const rb = TD_PRIOS_D1.findIndex(p => p.key === b.prio);
    return ra - rb;
  });

  const byPerson = {};
  (agg.results || []).forEach(r => {
    const k = r.who || '(미배정)';
    const p = byPerson[k] = byPerson[k] || { wait: 0, doing: 0, done: 0, overdue: 0 };
    const n = Number(r.n) || 0;
    if (r.status === '완료') p.done += n;
    else if (r.status === '진행중') p.doing += n;
    else p.wait += n;
    p.overdue += Number(r.od) || 0;
  });

  /* 숙박에서 생긴 할 일에는 진행률이 의미 없습니다.
     화면이 예약완료·반려 단추로 바꿔 그릴 수 있게 원본을 붙여줍니다. */
  try {
    /* 숙박에서 생긴 할 일은 제목이 정해져 있습니다.
       그런 게 하나도 없으면 조회할 필요가 없습니다. */
    const ids = list.filter(x => x.title && x.title.indexOf('숙박 예약 ·') === 0)
                    .map(x => x.id);
    if (ids.length) {
      const st = await d1Chunked(env, ids, 90, part => ({
        sql: 'SELECT * FROM stay WHERE deleted = 0 AND todo_id IN ('
           + part.map(() => '?').join(',') + ')',
        args: part,
      }));
      const byTodo = {};
      st.forEach(r => { byTodo[r.todo_id] = slRow(r); });
      list.forEach(x => { if (byTodo[x.id]) x.stay = byTodo[x.id]; });
    }
  } catch (e) {}

  return {
    ok: true, scope, status, list, total: list.length, byPerson,
    canBook: slCanBook(au),
    members: await d1MembersOrdered(env, ctx),
    states: TD_STATES_D1, prios: TD_PRIOS_D1,
  };
}

async function d1TdAdd(env, ctx, au, body) {
  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) return { ok: false, error: '할 일 제목을 입력하세요.' };
  const who = String(body.who || '').trim() || au.name;
  const prio = TD_PRIOS_D1.some(p => p.key === body.prio) ? body.prio : '보통';
  const id = newId('TD');

  await env.DB.prepare(
    'INSERT INTO todo (id, by_name, who, title, body, deadline, prio, status, progress, at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, au.name, who, title, String(body.body || '').slice(0, 500),
         String(body.deadline || ''), prio, '대기', 0, nowStr()).run();

  const assigned = who !== au.name;

  /* 남에게 요청한 것만 알립니다.
     내 할 일을 내가 적은 것까지 알리면 소음이 됩니다.
     숙박 신청과 마찬가지로 D1 은 텔레그램을 직접 못 부르므로
     GAS 로 넘깁니다. */
  if (assigned) {
    tdNotify(env, ctx, '요청', {
      by: au.name, who, title,
      body: String(body.body || '').slice(0, 500),
      deadline: String(body.deadline || ''),
      prio, at: nowStr(),
    });
  }

  return { ok: true, id, by: au.name, who, title, prio, assigned };
}

/* 할 일 알림 — 응답을 붙잡지 않도록 뒤로 넘깁니다 */
function tdNotify(env, ctx, action, todo) {
  const job = (async () => {
    try {
      await fetch(gasUrlQ(''), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ api: 'td_notify', action, todo }),
        redirect: 'follow',
      });
    } catch (e) {}
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
}

async function d1TdUpdate(env, ctx, au, body) {
  const id = String(body.id || '').trim();
  if (!id) return { ok: false, error: 'ID가 없습니다.' };
  const row = await env.DB.prepare('SELECT * FROM todo WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: '할 일을 찾을 수 없습니다.' };
  if (au.role !== 'admin' && row.who !== au.name && row.by_name !== au.name) {
    return { ok: false, error: '담당자와 요청자만 수정할 수 있습니다.' };
  }

  const stGiven = body.status !== undefined;
  const pgGiven = body.progress !== undefined;

  let status = stGiven ? String(body.status) : row.status;
  if (!TD_STATES_D1.includes(status)) status = row.status;
  let prog = pgGiven
    ? Math.max(0, Math.min(100, Number(body.progress) || 0))
    : Number(row.progress) || 0;

  /* 무엇을 바꿨는지에 따라 나머지 하나를 맞춥니다.
     체크를 풀었는데 진행률이 100 이라 다시 완료로 돌아가던 문제를 막습니다. */
  if (stGiven && !pgGiven) {
    // 사람이 상태를 직접 바꿨습니다 — 상태가 우선입니다
    if (status === '완료') prog = 100;
    else if (status === '대기') prog = 0;
    else if (prog >= 100) prog = 90;          // 완료를 되돌리면 90%
  } else if (pgGiven && !stGiven) {
    // 진행률만 움직였습니다 — 상태를 따라오게 합니다
    if (prog >= 100) status = '완료';
    else if (status === '완료') status = prog > 0 ? '진행중' : '대기';
    else if (prog > 0 && status === '대기') status = '진행중';
    else if (prog === 0 && status === '진행중') status = '대기';
  } else if (stGiven && pgGiven) {
    // 둘 다 왔습니다 — 모순만 정리합니다
    if (status === '완료') prog = 100;
    else if (prog >= 100) prog = 90;
  }

  await env.DB.prepare(
    'UPDATE todo SET title=?, body=?, deadline=?, prio=?, status=?, progress=?, memo=?, done_at=? WHERE id=?'
  ).bind(
    body.title !== undefined ? String(body.title).slice(0, 120) : row.title,
    body.body !== undefined ? String(body.body).slice(0, 500) : row.body,
    body.deadline !== undefined ? String(body.deadline) : row.deadline,
    body.prio !== undefined ? String(body.prio) : row.prio,
    status, prog,
    body.memo !== undefined ? String(body.memo).slice(0, 300) : row.memo,
    status === '완료' ? (row.done_at || nowStr()) : '',
    id
  ).run();

  const after = await env.DB.prepare('SELECT * FROM todo WHERE id = ?').bind(id).first();

  /* 요청한 사람에게 완료를 알립니다.
     남에게 부탁한 일이 끝났는지 매번 들여다볼 수는 없으니까요.
     내가 요청하고 내가 끝낸 경우는 알리지 않습니다. */
  if (status === '완료' && row.status !== '완료'
      && after.by_name && after.by_name !== after.who) {
    tdNotify(env, ctx, '완료', {
      by: after.by_name, who: after.who, title: after.title,
      deadline: after.deadline || '', prio: after.prio || '',
      memo: after.memo || '', at: nowStr(),
    });
  }

  return {
    ok: true,
    item: { id, status: after.status, progress: after.progress, memo: after.memo || '',
            by: after.by_name, who: after.who, title: after.title },
  };
}

async function d1TdDelete(env, au, body) {
  const id = String(body.id || '').trim();
  const row = await env.DB.prepare('SELECT * FROM todo WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: '할 일을 찾을 수 없습니다.' };
  if (au.role !== 'admin' && row.who !== au.name && row.by_name !== au.name) {
    return { ok: false, error: '담당자와 요청자만 삭제할 수 있습니다.' };
  }
  await env.DB.prepare('UPDATE todo SET deleted = 1 WHERE id = ?').bind(id).run();
  return { ok: true, id };
}

/* ── 공지사항 ── */
async function d1NtList(env, au, url) {
  const q = String(url.searchParams.get('q') || '').trim();
  const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);

  let sql = 'SELECT * FROM notice WHERE deleted = 0';
  const args = [];
  if (q) {
    sql += ' AND (title LIKE ? OR body LIKE ? OR tags LIKE ?)';
    const like = '%' + q + '%';
    args.push(like, like, like);
  }
  sql += ' ORDER BY pinned DESC, at DESC LIMIT ?';
  args.push(limit);

  const rows = await env.DB.prepare(sql).bind(...args).all();
  return {
    ok: true, q,
    list: (rows.results || []).map(ntRow),
    total: (rows.results || []).length,
  };
}

async function d1NtRecent(env, url) {
  const n = Math.min(20, Number(url.searchParams.get('n')) || 3);
  const rows = await env.DB.prepare(
    'SELECT * FROM notice WHERE deleted = 0 ORDER BY pinned DESC, at DESC LIMIT ?'
  ).bind(n).all();
  return { ok: true, list: (rows.results || []).map(ntRow) };
}

function ntRow(r) {
  return {
    id: r.id, at: r.at, author: r.author,
    title: r.title, body: r.body || '',
    tags: r.tags ? String(r.tags).split(',').map(x => x.trim()).filter(Boolean) : [],
    pinned: !!r.pinned, link: r.link || '',
  };
}

async function d1NtWrite(env, au, body) {
  const title = String(body.title || '').trim().slice(0, 120);
  const text = String(body.body || '').trim().slice(0, 4000);
  if (!title && !text) return { ok: false, error: '제목이나 내용을 입력하세요.' };

  const id = newId('AP');
  await env.DB.prepare(
    'INSERT INTO notice (id, author, title, body, tags, pinned, link, at, deleted) VALUES (?,?,?,?,?,?,?,?,0)'
  ).bind(id, au.name, title || text.split('\n')[0].slice(0, 60), text,
         (body.tags || []).slice(0, 5).join(', '),
         body.pinned ? 1 : 0, '', nowStr()).run();

  return { ok: true, id, title };
}

async function d1NtEdit(env, au, body) {
  const id = String(body.id || '').trim();
  const row = await env.DB.prepare('SELECT * FROM notice WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: '공지를 찾을 수 없습니다.' };
  if (au.role !== 'admin' && row.author !== au.name) {
    return { ok: false, error: '본인이 쓴 공지만 수정할 수 있습니다.' };
  }
  await env.DB.prepare(
    'UPDATE notice SET title=?, body=?, tags=?, pinned=? WHERE id=?'
  ).bind(
    body.title !== undefined ? String(body.title).slice(0, 120) : row.title,
    body.body !== undefined ? String(body.body).slice(0, 4000) : row.body,
    body.tags !== undefined ? (body.tags || []).slice(0, 5).join(', ') : row.tags,
    body.pinned !== undefined ? (body.pinned ? 1 : 0) : row.pinned,
    id
  ).run();
  return { ok: true, id };
}

async function d1NtRemove(env, au, body) {
  const id = String(body.id || '').trim();
  const row = await env.DB.prepare('SELECT * FROM notice WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: '공지를 찾을 수 없습니다.' };
  if (au.role !== 'admin' && row.author !== au.name) {
    return { ok: false, error: '본인이 쓴 공지만 삭제할 수 있습니다.' };
  }
  await env.DB.prepare('UPDATE notice SET deleted = 1 WHERE id = ?').bind(id).run();
  return { ok: true, id };
}

async function d1NtPin(env, au, body) {
  const id = String(body.id || '').trim();
  const row = await env.DB.prepare('SELECT * FROM notice WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: '공지를 찾을 수 없습니다.' };
  if (au.role !== 'admin' && row.author !== au.name) {
    return { ok: false, error: '권한이 없습니다.' };
  }
  await env.DB.prepare('UPDATE notice SET pinned = ? WHERE id = ?')
    .bind(body.pinned ? 1 : 0, id).run();
  return { ok: true, id, pinned: !!body.pinned };
}

/* ── 아침 브리핑 · 출장 준비 ──
   GAS 가 매일 정해진 시각에 불러 텔레그램으로 뿌립니다.
   워커는 D1 에서 그날 자료만 모아 넘기고, 문장 만들기와 발송은 GAS 가 합니다.

   사용자 토큰 없이 서버끼리 부르므로 비밀키로 확인합니다.
   비밀키 자체를 실어 보내지 않고, 날짜를 서명한 값만 주고받습니다. */
async function d1Brief(env, url) {
  const day = String(url.searchParams.get('day') || 'today');
  const key = String(url.searchParams.get('key') || '');

  const base = day === 'tomorrow' ? tomorrowStr() : todayStr();
  const secret = String(env.TOKEN_SECRET || '').trim();
  if (!secret) return { ok: false, error: 'TOKEN_SECRET 미설정' };

  /* GAS 는 한글을 물음표로 바꿔 서명하므로 여기서도 두 방식을 봅니다.
     'brief|날짜' 는 영문·숫자뿐이라 사실 같지만, 규칙을 맞춰둡니다. */
  const msg = 'brief|' + base;
  const mine = sigNorm(await hmacB64u(secret, msg));
  if (!key || sigNorm(key) !== mine) {
    return { ok: false, error: '열쇠가 맞지 않습니다.' };
  }

  const members = await d1Members(env, null);
  const ym = base.slice(0, 7);

  const [att, tds, stays] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM attend WHERE date = ? AND status != '취소'"
    ).bind(base).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      "SELECT * FROM todo WHERE deleted = 0 AND status != '완료' AND deadline != ''"
    ).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      'SELECT * FROM stay WHERE deleted = 0 AND from_date <= ? AND to_date >= ?'
    ).bind(base, base).all().catch(() => ({ results: [] })),
  ]);

  // 주간계획은 근무를 아직 등록하지 않은 사람에게 씁니다
  const planOf = {};
  for (const nm of members) {
    try {
      const row = await env.DB.prepare('SELECT v FROM cfg WHERE k = ?')
        .bind('plan|' + nm + '|' + ym).first();
      if (!row) continue;
      const parsed = safeJson(row.v, {});
      const map = parsed.map || parsed || {};
      if (map[base]) planOf[nm] = map[base];
    } catch (e) {}
  }

  const byName = {};
  members.forEach(nm => {
    byName[nm] = { name: nm, attend: null, plan: planOf[nm] || null,
                   todos: [], stay: null };
  });

  (att.results || []).forEach(r => {
    if (!byName[r.name]) return;
    byName[r.name].attend = {
      type: r.type, reason: r.reason || '',
      status: r.status, tasks: safeJson(r.tasks, []),
    };
  });

  (stays.results || []).forEach(r => {
    if (!byName[r.name]) return;
    const v = slRow(r);
    byName[r.name].stay = {
      from: v.from, to: v.to, nights: v.nights,
      status: v.status, site: v.site, link: v.link,
      bookLink: v.bookLink, rejectMemo: v.rejectMemo,
    };
  });

  /* 할 일은 오늘까지 마감인 것과 이미 지난 것만 보냅니다.
     한참 남은 것까지 매일 보내면 금세 읽지 않게 됩니다. */
  (tds.results || []).forEach(r => {
    if (!byName[r.who]) return;
    if (String(r.deadline) > base) return;
    byName[r.who].todos.push({
      title: r.title, deadline: r.deadline, prio: r.prio,
      by: r.by_name || '', status: r.status,
      overdue: String(r.deadline) < base,
    });
  });

  Object.keys(byName).forEach(nm => {
    byName[nm].todos.sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
  });

  return {
    ok: true, day, date: base,
    list: members.map(nm => byName[nm]),
  };
}

function tomorrowStr() {
  const d = new Date(Date.now() + 9 * 3600e3 + 86400e3);   // KST 기준 내일
  return d.getUTCFullYear() + '-' + pad2n(d.getUTCMonth() + 1) + '-' + pad2n(d.getUTCDate());
}

/* ── 근태 이관 (일회성) ──
   시트에 쌓여 있던 기존 근태를 D1 로 옮깁니다.
   GAS 가 읽어서 여기로 보내면 D1 에 넣습니다.

   같은 사람·같은 날짜가 이미 D1 에 있으면 건드리지 않습니다.
   앱에서 등록한 것이 시트 값으로 덮이면 안 되기 때문입니다. */
async function d1AtImport(env, au, body) {
  if (au.role !== 'admin') {
    return { ok: false, error: '대표만 실행할 수 있습니다.' };
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, error: '보낼 내용이 없습니다.' };
  if (rows.length > 500) return { ok: false, error: '한 번에 500건까지만 보내주세요.' };

  /* 이미 들어 있는 것을 먼저 확인합니다.
     한 줄에 값이 둘씩 들어가므로 40줄씩 나눠 물어봅니다.
     확인에 실패하면 넣지 않고 멈춥니다 — 모르고 넣으면 전원 근태가
     두 벌씩 쌓이는데, 그건 되돌리기가 훨씬 어렵습니다. */
  const keys = rows.map(r => String(r.name || '') + '|' + String(r.date || ''));
  const have = {};
  try {
    const ex = await d1Chunked(env, rows, 40, part => ({
      sql: 'SELECT name, date FROM attend WHERE '
         + part.map(() => '(name = ? AND date = ?)').join(' OR '),
      args: part.flatMap(r => [String(r.name || ''), String(r.date || '')]),
    }));
    ex.forEach(x => { have[x.name + '|' + x.date] = 1; });
  } catch (e) {
    return { ok: false, error: '기존 기록을 확인하지 못해 중단했습니다. 다시 시도해주세요.' };
  }

  const stmts = [];
  let added = 0, skipped = 0, bad = 0;

  rows.forEach((r, i) => {
    const name = String(r.name || '').trim();
    const date = String(r.date || '').trim();
    const type = String(r.type || '').trim();
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !type) { bad++; return; }
    if (have[keys[i]]) { skipped++; return; }

    let tasks = '';
    if (r.tasks) {
      tasks = (typeof r.tasks === 'string') ? r.tasks : JSON.stringify(r.tasks);
      if (tasks === '[]') tasks = '';
    }

    stmts.push(env.DB.prepare(
      'INSERT INTO attend (id, name, date, type, reason, status, tasks, at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(
      String(r.id || '').trim() || newId('AT'),
      name, date, type,
      String(r.reason || '').slice(0, 200),
      String(r.status || '확정').trim() || '확정',
      tasks,
      String(r.at || '').trim() || nowStr()
    ));
    added++;
    have[keys[i]] = 1;          // 같은 묶음 안의 중복도 막습니다
  });

  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, 받음: rows.length, 넣음: added, 건너뜀: skipped, 형식오류: bad };
}

/* ── 숙박 신청 ──
   승인 절차 없이 신청하면 바로 확정입니다.
   실장님이 대신 예약해 주시므로, 등록·수정·취소 때마다 알림을 보냅니다. */

/* 예약을 대신 잡아주시는 분입니다.
   이름이 바뀌면 여기만 고치시면 됩니다. 대표는 항상 가능합니다. */
const SL_BOOKERS = ['신정임'];

function slCanBook(au) {
  if (au.role === 'admin') return true;
  const me = String(au.name || '').replace(/\s*(실장|대표|팀장)$/, '').trim();
  return SL_BOOKERS.some(x => x.replace(/\s*(실장|대표|팀장)$/, '').trim() === me);
}

const SL_SITES = [
  { host: 'yanolja',     name: '야놀자' },
  { host: 'goodchoice',  name: '여기어때' },
  { host: 'ykkbg',       name: '여기어때' },
  { host: 'agoda',       name: '아고다' },
  { host: 'booking.com', name: '부킹닷컴' },
  { host: 'airbnb',      name: '에어비앤비' },
  { host: 'hotels.com',  name: '호텔스닷컴' },
  { host: 'naver',       name: '네이버' },
  { host: 'interpark',   name: '인터파크' },
];

function slSite(link) {
  const s = String(link || '').toLowerCase();
  for (const x of SL_SITES) if (s.indexOf(x.host) >= 0) return x.name;
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function slRow(r) {
  const nights = Math.max(1, daysBetween(r.from_date, r.to_date) || 1);
  return {
    id: r.id, name: r.name,
    from: r.from_date, to: r.to_date, nights,
    link: r.link || '', site: slSite(r.link), memo: r.memo || '',
    status: r.status || '예약신청',
    bookLink: r.book_link || '', bookSite: slSite(r.book_link),
    rejectMemo: r.reject_memo || '',
    bookedAt: r.booked_at || '', bookedBy: r.booked_by || '',
    todoId: r.todo_id || '',
    at: r.at, editedAt: r.edited_at || '',
  };
}

/* 신청 기간에 걸친 날짜를 모두 펼칩니다 (달력에 배지를 찍기 위해) */
function slSpread(r, ym) {
  const out = [];
  // 원본 행이든 가공된 값이든 둘 다 받습니다
  const from = r.from || r.from_date;
  const to = r.to || r.to_date;
  if (!from || !to) return out;

  let cur = from;
  for (let i = 0; i < 60; i++) {
    if (cur > to) break;
    if (!ym || cur.slice(0, 7) === ym) out.push(cur);
    const p = cur.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
    cur = d.getUTCFullYear() + '-' + pad2n(d.getUTCMonth() + 1) + '-' + pad2n(d.getUTCDate());
  }
  return out;
}

/* 그 달에 하루라도 걸치는 신청을 찾습니다 (월말~월초 숙박도 놓치지 않게) */
async function slRowsOfMonth(env, ym, name) {
  const from = ym + '-01', to = ym + '-31';
  let sql = 'SELECT * FROM stay WHERE deleted = 0 AND from_date <= ? AND to_date >= ?';
  const args = [to, from];
  if (name) { sql += ' AND name = ?'; args.push(name); }
  sql += ' ORDER BY from_date';
  const rows = await env.DB.prepare(sql).bind(...args).all();
  return (rows.results || []).map(slRow);
}

async function d1SlList(env, au, url) {
  const ym = String(url.searchParams.get('ym') || '').trim();
  /* 숙소 링크·메모·반려 사유가 들어 있어 전원 조회는 막습니다.
     대표님과 예약을 맡으신 분만 전체를 봅니다. 화면에서는 쓰지 않는 값이라
     막아도 달라지는 건 없습니다 (팀 달력의 숙박 표시는 at_all 로 갑니다). */
  const scope = String(url.searchParams.get('scope') || 'mine');
  const name = (scope === 'all' && slCanBook(au)) ? '' : au.name;

  const list = ym
    ? await slRowsOfMonth(env, ym, name)
    : (await (async () => {
        let sql = 'SELECT * FROM stay WHERE deleted = 0';
        const args = [];
        if (name) { sql += ' AND name = ?'; args.push(name); }
        sql += ' ORDER BY from_date DESC LIMIT 100';
        const r = await env.DB.prepare(sql).bind(...args).all();
        return (r.results || []).map(slRow);
      })());

  return { ok: true, ym, scope, list, me: au.name, canBook: slCanBook(au) };
}

function slClean(body) {
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim() || from;
  const link = String(body.link || '').trim().slice(0, 500);
  const memo = String(body.memo || '').trim().slice(0, 500);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return { error: '체크인 날짜를 골라주세요.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: '체크아웃 날짜를 골라주세요.' };
  if (to < from) return { error: '체크아웃이 체크인보다 빠릅니다.' };
  if (daysBetween(from, to) > 30) return { error: '한 번에 30박까지만 신청할 수 있습니다.' };
  if (!link && !memo) return { error: '숙소 링크나 내용 중 하나는 적어주세요.' };
  if (link && !/^https?:\/\//i.test(link)) return { error: '링크는 http 로 시작해야 합니다.' };

  return { from, to, link, memo };
}

async function d1SlAdd(env, ctx, au, body) {
  const c = slClean(body);
  if (c.error) return { ok: false, error: c.error };

  const id = newId('SL');
  await env.DB.prepare(
    'INSERT INTO stay (id, name, from_date, to_date, link, memo, status, at, deleted) ' +
    'VALUES (?,?,?,?,?,?,?,?,0)'
  ).bind(id, au.name, c.from, c.to, c.link, c.memo, '예약신청', nowStr()).run();

  const row = await env.DB.prepare('SELECT * FROM stay WHERE id = ?').bind(id).first();
  const item = slRow(row);

  const todoId = await slTodoAdd(env, item);
  if (todoId) {
    await env.DB.prepare('UPDATE stay SET todo_id = ? WHERE id = ?').bind(todoId, id).run();
    item.todoId = todoId;
  }

  slNotify(env, ctx, '신규', item);
  return { ok: true, id, item, assignedTo: todoId ? SL_BOOKERS[0] : '' };
}

async function d1SlEdit(env, ctx, au, body) {
  const id = String(body.id || '').trim();
  const row = await env.DB.prepare('SELECT * FROM stay WHERE id = ?').bind(id).first();
  if (!row || row.deleted) return { ok: false, error: '신청을 찾을 수 없습니다.' };
  if (au.role !== 'admin' && row.name !== au.name) {
    return { ok: false, error: '본인이 낸 신청만 고칠 수 있습니다.' };
  }
  const c = slClean({
    from: body.from !== undefined ? body.from : row.from_date,
    to:   body.to   !== undefined ? body.to   : row.to_date,
    link: body.link !== undefined ? body.link : row.link,
    memo: body.memo !== undefined ? body.memo : row.memo,
  });
  if (c.error) return { ok: false, error: c.error };

  /* 날짜나 숙소가 바뀌면 잡아둔 예약이 더는 맞지 않습니다.
     상태를 되돌려 실장님이 다시 잡으시게 합니다. */
  const changed = c.from !== row.from_date || c.to !== row.to_date || c.link !== row.link;
  const reset = changed && row.status === '예약완료';

  await env.DB.prepare(
    'UPDATE stay SET from_date=?, to_date=?, link=?, memo=?, edited_at=?' +
    (reset ? ", status='예약신청', book_link='', booked_at='', booked_by=''" : '') +
    ' WHERE id=?'
  ).bind(c.from, c.to, c.link, c.memo, nowStr(), id).run();

  const after = await env.DB.prepare('SELECT * FROM stay WHERE id = ?').bind(id).first();
  const item = slRow(after);
  await slTodoSync(env, after.todo_id, item);
  slNotify(env, ctx, '변경', item, { reset });
  return { ok: true, id, item, reset };
}

async function d1SlRemove(env, ctx, au, body) {
  const id = String(body.id || '').trim();
  const row = await env.DB.prepare('SELECT * FROM stay WHERE id = ?').bind(id).first();
  if (!row || row.deleted) return { ok: false, error: '신청을 찾을 수 없습니다.' };
  if (au.role !== 'admin' && row.name !== au.name) {
    return { ok: false, error: '본인이 낸 신청만 취소할 수 있습니다.' };
  }
  await env.DB.prepare('UPDATE stay SET deleted = 1 WHERE id = ?').bind(id).run();
  await slTodoDrop(env, row.todo_id);
  slNotify(env, ctx, '취소', slRow(row));
  return { ok: true, id };
}

/* 숙박을 신청하면 예약 담당자의 '할 일' 에 자동으로 걸어둡니다.
   말로만 부탁하면 놓치기 쉬우니 목록에 남겨 놓습니다. */
function slTodoTitle(x) {
  return '숙박 예약 · ' + x.name + ' ' + x.from.slice(5).replace('-', '/')
       + '~' + x.to.slice(5).replace('-', '/') + ' (' + x.nights + '박)';
}

function slTodoBody(x) {
  const L = [];
  if (x.site) L.push('예약처: ' + x.site);
  if (x.link) L.push(x.link);
  if (x.memo) L.push(x.memo);
  return L.join('\n').slice(0, 500);
}

async function slTodoAdd(env, x) {
  const who = SL_BOOKERS[0];
  if (!who) return '';
  const id = newId('TD');
  // 체크인이 코앞이면 긴급으로 올립니다
  const left = daysBetween(todayStr(), x.from);
  const prio = left <= 3 ? '긴급' : '보통';
  try {
    await env.DB.prepare(
      'INSERT INTO todo (id, by_name, who, title, body, deadline, prio, status, progress, at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, x.name, who, slTodoTitle(x), slTodoBody(x), x.from, prio, '대기', 0, nowStr()).run();
    return id;
  } catch (e) { return ''; }
}

/* 예약이 잡히면 완료로, 되돌리면 다시 대기로 바꿉니다 */
async function slTodoDone(env, todoId, done, by, memo) {
  if (!todoId) return;
  try {
    if (done) {
      const note = memo || (by ? by + '님이 예약 완료' : '예약 완료');
      await env.DB.prepare(
        "UPDATE todo SET status='완료', progress=100, done_at=?, memo=? WHERE id=?"
      ).bind(nowStr(), note, todoId).run();
    } else {
      await env.DB.prepare(
        "UPDATE todo SET status='대기', progress=0, done_at='', memo='' WHERE id=?"
      ).bind(todoId).run();
    }
  } catch (e) {}
}

async function slTodoSync(env, todoId, x) {
  if (!todoId) return;
  try {
    await env.DB.prepare(
      "UPDATE todo SET title=?, body=?, deadline=?, status='대기', progress=0, done_at='' WHERE id=?"
    ).bind(slTodoTitle(x), slTodoBody(x), x.from, todoId).run();
  } catch (e) {}
}

async function slTodoDrop(env, todoId) {
  if (!todoId) return;
  try {
    await env.DB.prepare('UPDATE todo SET deleted = 1 WHERE id = ?').bind(todoId).run();
  } catch (e) {}
}

/* 예약 링크를 넣으면 예약완료로 넘어갑니다.
   링크를 비우면 다시 예약신청으로 돌아갑니다. */
async function d1SlBook(env, ctx, au, body) {
  if (!slCanBook(au)) {
    return { ok: false, error: '예약 담당자만 등록할 수 있습니다.' };
  }
  const id = String(body.id || '').trim();
  const row = await env.DB.prepare('SELECT * FROM stay WHERE id = ?').bind(id).first();
  if (!row || row.deleted) return { ok: false, error: '신청을 찾을 수 없습니다.' };

  const link = String(body.link || '').trim().slice(0, 500);
  const reject = body.reject === true;
  const reason = String(body.reason || '').trim().slice(0, 300);

  if (link && !/^https?:\/\//i.test(link)) {
    return { ok: false, error: '링크는 http 로 시작해야 합니다.' };
  }

  let action;
  if (reject) {
    if (!reason) return { ok: false, error: '반려 사유를 적어주세요.' };
    await env.DB.prepare(
      "UPDATE stay SET status='반려', reject_memo=?, book_link='', booked_at=?, booked_by=? WHERE id=?"
    ).bind(reason, nowStr(), au.name, id).run();
    action = '반려';
  } else if (link) {
    await env.DB.prepare(
      "UPDATE stay SET book_link=?, status='예약완료', reject_memo='', booked_at=?, booked_by=? WHERE id=?"
    ).bind(link, nowStr(), au.name, id).run();
    action = '예약완료';
  } else {
    await env.DB.prepare(
      "UPDATE stay SET book_link='', status='예약신청', reject_memo='', booked_at='', booked_by='' WHERE id=?"
    ).bind(id).run();
    action = '예약해제';
  }

  const after = await env.DB.prepare('SELECT * FROM stay WHERE id = ?').bind(id).first();
  const item = slRow(after);

  /* 예약을 잡았든 반려했든 실장님이 하실 일은 끝났습니다.
     되돌린 경우에만 다시 대기로 놓습니다. */
  if (action === '예약해제') {
    await slTodoDone(env, after.todo_id, false, au.name);
  } else {
    await slTodoDone(env, after.todo_id, true, au.name,
      action === '반려' ? ('반려 — ' + reason) : '');
  }

  slNotify(env, ctx, action, item);
  return { ok: true, id, item, status: item.status };
}

/* 출장 내용(무엇을 · 어디서 · 몇 건)은 이미 달력에 있습니다.
   신청서에 다시 적게 하지 않고 여기서 끌어옵니다.
   등록된 근무 기록을 먼저 보고, 없으면 주간계획을 씁니다. */
async function slContext(env, name, from, to) {
  const agg = {};
  const put = (kind, region, count) => {
    if (!kind || !count) return;
    const k = kind + '|' + (region || '');
    agg[k] = (agg[k] || 0) + Number(count);
  };

  try {
    const rows = await env.DB.prepare(
      'SELECT date, tasks FROM attend WHERE name = ? AND date >= ? AND date <= ? AND status != ?'
    ).bind(name, from, to, '취소').all();
    (rows.results || []).forEach(r => {
      safeJson(r.tasks, []).forEach(t => put(t.kind, t.region, t.count));
    });
  } catch (e) {}

  // 아직 근무를 등록하지 않았다면 주간계획에서 봅니다
  if (!Object.keys(agg).length) {
    const yms = [from.slice(0, 7)];
    if (to.slice(0, 7) !== yms[0]) yms.push(to.slice(0, 7));
    for (const ym of yms) {
      try {
        const row = await env.DB.prepare('SELECT v FROM cfg WHERE k = ?')
          .bind('plan|' + name + '|' + ym).first();
        if (!row) continue;
        const parsed = safeJson(row.v, {});
        const map = parsed.map || parsed || {};
        Object.keys(map).forEach(ds => {
          if (ds < from || ds > to) return;
          const p = map[ds] || {};
          put('현장', p.region, p.hyunjang);
          put('이행', p.region, p.ihaeng);
          const m = String(p.shopping || '').match(/(\d+)/);
          if (m) put('쇼핑몰', p.region, Number(m[1]));
        });
      } catch (e) {}
    }
  }

  return Object.keys(agg).map(k => {
    const p = k.split('|');
    return { kind: p[0], region: p[1], count: agg[k] };
  });
}

/* 휴가(월차·병가·경조) 알림 — 숙박과 같은 방식으로 GAS 가 보냅니다.
   등록/취소/승인 때만 울리고, 근무 등록처럼 매일 있는 일은 조용히 둡니다. */
function atNotify(env, ctx, action, item) {
  const job = (async () => {
    try {
      await fetch(gasUrlQ(''), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ api: 'at_notify', action, attend: item }),
        redirect: 'follow',
      });
    } catch (e) {}
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
}

function atIsOff(type) {
  const t = AT_TYPES_D1.find(x => x.key === type);
  return !!(t && t.off);
}

/* 알림은 GAS 가 보냅니다. 응답을 붙잡지 않도록 뒤로 넘깁니다. */
function slNotify(env, ctx, action, item, extra) {
  const job = (async () => {
    try {
      const plans = await slContext(env, item.name, item.from, item.to).catch(() => []);
      await fetch(gasUrlQ(''), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign(
          { api: 'sl_notify', action, stay: item, plans }, extra || {})),
        redirect: 'follow',
      });
    } catch (e) {}
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
}



/* ============================================================
   실적 — 달력에 등록한 서면점검·강의를 모읍니다

   통신·쇼핑몰 실적은 시트(포털·점검앱)가 원천이라 여기서 세지 않습니다.
   달력에만 기록이 남는 업무만 여기서 셉니다.
   목표는 대표가 화면에서 적고 cfg 테이블에 연도별로 둡니다.
   ============================================================ */
const PF_KINDS = ['서면', '강의'];

async function pfTargets(env, year) {
  const row = await env.DB.prepare('SELECT v FROM cfg WHERE k = ?').bind('pf_target|' + year).first();
  const v = row ? safeJson(row.v, {}) : {};
  const out = {};
  PF_KINDS.forEach(k => { out[k] = Math.max(0, Number(v[k]) || 0); });
  return out;
}

async function d1PfYear(env, ctx, au, url) {
  const year = /^\d{4}$/.test(String(url.searchParams.get('year') || ''))
    ? String(url.searchParams.get('year')) : todayStr().slice(0, 4);

  const [rows, targets, members] = await Promise.all([
    env.DB.prepare(
      "SELECT name, date, tasks FROM attend WHERE date >= ? AND date <= ? AND status != '취소'"
    ).bind(year + '-01-01', year + '-12-31').all(),
    pfTargets(env, year),
    d1MembersOrdered(env, ctx).catch(() => []),
  ]);

  const totals = {}, byName = {}, daily = {}, recent = {};
  PF_KINDS.forEach(k => { totals[k] = 0; daily[k] = {}; recent[k] = []; });

  (rows.results || []).forEach(r => {
    safeJson(r.tasks, []).forEach(t => {
      const k = String(t.kind || '');
      const n = Number(t.count) || 0;
      if (PF_KINDS.indexOf(k) < 0 || !n) return;
      totals[k] += n;
      daily[k][r.date] = (daily[k][r.date] || 0) + n;
      const p = byName[r.name] = byName[r.name] || {};
      const pk = p[k] = p[k] || { total: 0, months: {} };
      pk.total += n;
      const m = r.date.slice(5, 7);
      pk.months[m] = (pk.months[m] || 0) + n;
      recent[k].push({ date: r.date, name: r.name, region: String(t.region || ''), count: n });
    });
  });
  PF_KINDS.forEach(k => {
    recent[k].sort((a, b) => (a.date < b.date ? 1 : -1));
    recent[k] = recent[k].slice(0, 30);
  });

  // 기록이 있는 사람은 명단에 없어도 넣습니다
  const names = members.slice();
  Object.keys(byName).forEach(nm => { if (names.indexOf(nm) < 0) names.push(nm); });

  return {
    ok: true, year, today: todayStr(), kinds: PF_KINDS,
    targets, totals, byName, names, daily, recent,
    admin: au.role === 'admin',
  };
}

async function d1PfTarget(env, au, body) {
  if (au.role !== 'admin') return { ok: false, error: '목표는 대표만 정할 수 있습니다.' };
  const year = String(body.year || '');
  const kind = String(body.kind || '');
  if (!/^\d{4}$/.test(year)) return { ok: false, error: '연도를 확인하세요.' };
  if (PF_KINDS.indexOf(kind) < 0) return { ok: false, error: '업무 종류를 확인하세요.' };
  const n = Math.max(0, Math.min(100000, Math.round(Number(body.target) || 0)));
  const cur = await pfTargets(env, year);
  cur[kind] = n;
  await env.DB.prepare(
    'INSERT INTO cfg (k, v, at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at'
  ).bind('pf_target|' + year, JSON.stringify(cur), Date.now()).run();
  return { ok: true, year, targets: cur };
}

/* ============================================================
   휴가 신청 (「신청」 메뉴)
   달력에는 하루씩 들어가 있지만, 사람은 「12/3~12/5 월차」 처럼 한 건으로 봅니다.
   이어진 날(주말 건너뜀 포함)·같은 구분·같은 상태·같은 사유를 한 건으로 묶어 돌려주고,
   취소·승인도 한 건 단위로 처리해 알림이 하루마다 따로 가지 않게 합니다.
   ============================================================ */
function lvGroup(rows) {
  const sorted = rows.slice().sort((a, b) =>
    (a.name + a.type + a.date < b.name + b.type + b.date ? -1 : 1));
  const out = [];
  let cur = null;
  for (const r of sorted) {
    const same = cur && cur.name === r.name && cur.type === r.type
      && cur.status === r.status && cur.reason === (r.reason || '')
      && daysBetween(cur.to, r.date) <= 3;        // 금→월 처럼 주말을 사이에 둔 건 이어서 봅니다
    if (same) { cur.to = r.date; cur.ids.push(r.id); cur.dates.push(r.date); continue; }
    cur = { name: r.name, type: r.type, status: r.status, reason: r.reason || '',
            from: r.date, to: r.date, ids: [r.id], dates: [r.date], at: r.at || '' };
    out.push(cur);
  }
  out.forEach(g => { g.days = g.dates.length; g.key = g.ids[0]; });
  return out.sort((a, b) => (a.from < b.from ? 1 : -1));
}

async function d1LvList(env, au, url) {
  const year = /^\d{4}$/.test(String(url.searchParams.get('year') || ''))
    ? String(url.searchParams.get('year')) : todayStr().slice(0, 4);
  const offTypes = AT_TYPES_D1.filter(t => t.off).map(t => t.key);
  const ph = offTypes.map(() => '?').join(',');
  const admin = au.role === 'admin';

  const mine = await env.DB.prepare(
    'SELECT id, name, date, type, status, reason, at FROM attend WHERE name = ? AND type IN (' + ph + ')'
    + ' AND date >= ? AND date <= ? ORDER BY date LIMIT 400'
  ).bind(au.name, ...offTypes, year + '-01-01', year + '-12-31').all();

  let waiting = [];
  if (admin) {
    const w = await env.DB.prepare(
      "SELECT id, name, date, type, status, reason, at FROM attend WHERE status = '대기' ORDER BY date LIMIT 400"
    ).all();
    waiting = lvGroup(w.results || []);
  }

  const types = AT_TYPES_D1.filter(t => t.off).map(t => ({ key: t.key, needOk: !!t.needOk, color: t.color }));
  return { ok: true, year, me: au.name, admin, types, mine: lvGroup(mine.results || []), waiting };
}

async function lvRowsByIds(env, ids) {
  ids = (Array.isArray(ids) ? ids : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 62);
  if (!ids.length) return [];
  const r = await env.DB.prepare(
    'SELECT * FROM attend WHERE id IN (' + ids.map(() => '?').join(',') + ')'
  ).bind(...ids).all();
  return r.results || [];
}

async function d1LvCancel(env, ctx, au, body) {
  const rows = await lvRowsByIds(env, body.ids);
  if (!rows.length) return { ok: false, error: '취소할 신청을 찾지 못했습니다.' };
  const admin = au.role === 'admin';
  for (const r of rows) {
    if (!admin && r.name !== au.name) return { ok: false, error: '본인 신청만 취소할 수 있습니다.' };
    if (!admin && r.status === '확정' && AT_TYPES_D1.find(x => x.key === r.type && x.needOk)) {
      return { ok: false, error: '승인된 월차는 대표만 취소할 수 있습니다. 대표에게 말씀해주세요.' };
    }
  }
  await env.DB.batch(rows.map(r => env.DB.prepare('DELETE FROM attend WHERE id = ?').bind(r.id)));
  const ds = rows.map(r => r.date).sort();
  if (atIsOff(rows[0].type)) {
    atNotify(env, ctx, '취소', {
      name: rows[0].name, type: rows[0].type, reason: rows[0].reason || '', status: rows[0].status,
      dates: ds, from: ds[0], to: ds[ds.length - 1], count: ds.length, by: au.name,
    });
  }
  return { ok: true, count: rows.length };
}

async function d1LvDecide(env, ctx, au, body) {
  if (au.role !== 'admin') return { ok: false, error: '대표만 승인할 수 있습니다.' };
  const rows = await lvRowsByIds(env, body.ids);
  if (!rows.length) return { ok: false, error: '신청을 찾지 못했습니다.' };
  const ok = body.approve !== false;
  const status = ok ? '확정' : '취소';
  const now = nowStr();
  await env.DB.batch(rows.map(r => env.DB.prepare(
    'UPDATE attend SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?'
  ).bind(status, now, au.name, r.id)));
  const ds = rows.map(r => r.date).sort();
  if (atIsOff(rows[0].type)) {
    atNotify(env, ctx, ok ? '승인' : '반려', {
      name: rows[0].name, type: rows[0].type, reason: String(body.memo || rows[0].reason || '').slice(0, 200),
      status, dates: ds, from: ds[0], to: ds[ds.length - 1], count: ds.length, by: au.name,
    });
  }
  return { ok: true, count: rows.length, status };
}

/* ============================================================
   재무 — 법인계좌 내역 · 급여 (2026-11-11)

   권한
   · 계좌 내역, 전원 급여: 대표 + 실장(숙박 예약 담당과 같은 기준 slCanBook)
   · 급여명세서: 본인 것만
   누가 무엇을 봤는지 fin_log 에 남깁니다. 계좌번호·은행 로그인 정보는 저장하지 않습니다.

   계좌 내역은 은행 엑셀을 화면에서 읽어 한 줄씩 보냅니다.
   같은 거래를 두 번 올려도 겹치지 않게 (날짜·시각·금액·잔액·적요) 로 지문을 만듭니다.
   ============================================================ */
const FIN_CATS = ['매출', '급여', '4대보험', '세금·공과', '출장·교통', '식대·복리후생', '임차료',
                  '통신·구독', '수수료', '물품·장비', '대표 입출금', '이체(내 계좌)', '기타 수입', '기타 지출'];
let finReady = false;
async function finEnsure(env) {
  if (finReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS fin_tx (id TEXT PRIMARY KEY, fp TEXT UNIQUE, ym TEXT, date TEXT, time TEXT, ' +
      'descr TEXT, party TEXT, out_amt INTEGER, in_amt INTEGER, bal INTEGER, cat TEXT, memo TEXT, batch TEXT, at INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS fin_tx_ym ON fin_tx (ym)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS fin_rule (k TEXT PRIMARY KEY, cat TEXT, at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS pay (id TEXT PRIMARY KEY, ym TEXT, name TEXT, pay_date TEXT, items TEXT, ' +
      'gross INTEGER, ded INTEGER, net INTEGER, note TEXT, at INTEGER, by_name TEXT)'),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS pay_ym_name ON pay (ym, name)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS fin_log (at INTEGER, who TEXT, action TEXT, detail TEXT)'),
  ]);
  finReady = true;
}
function finAdmin(au) { return slCanBook(au); }
function finLog(env, au, action, detail) {
  return env.DB.prepare('INSERT INTO fin_log (at, who, action, detail) VALUES (?, ?, ?, ?)')
    .bind(Date.now(), au.name, action, String(detail || '').slice(0, 300)).run().catch(() => {});
}
/* 분류 규칙의 열쇠 — 거래처(받는분·보낸분)가 있으면 그것, 없으면 적요 */
function finKey(party, descr) {
  return String(party || descr || '').replace(/\s+/g, '').replace(/[0-9\-()（）]/g, '').slice(0, 30);
}
function finNum(v) { const n = Math.round(Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0); return n; }

async function finList(env, au, url) {
  if (!finAdmin(au)) return { ok: false, error: '대표·실장만 볼 수 있습니다.' };
  await finEnsure(env);
  let ym = String(url.searchParams.get('ym') || '');
  const months = (await env.DB.prepare('SELECT ym, COUNT(*) AS n FROM fin_tx GROUP BY ym ORDER BY ym DESC LIMIT 36').all()).results || [];
  if (!/^\d{4}-\d{2}$/.test(ym)) ym = months.length ? months[0].ym : todayStr().slice(0, 7);
  const rows = (await env.DB.prepare('SELECT * FROM fin_tx WHERE ym = ? ORDER BY date, time, id').bind(ym).all()).results || [];
  const year = ym.slice(0, 4);
  const yearSum = (await env.DB.prepare(
    'SELECT ym, cat, SUM(in_amt) AS inn, SUM(out_amt) AS out FROM fin_tx WHERE ym LIKE ? GROUP BY ym, cat'
  ).bind(year + '-%').all()).results || [];
  await finLog(env, au, 'fin_list', ym);
  return {
    ok: true, ym, months, cats: FIN_CATS, year, yearSum,
    list: rows.map(r => ({ id: r.id, date: r.date, time: r.time, descr: r.descr, party: r.party,
      out: r.out_amt, in: r.in_amt, bal: r.bal, cat: r.cat || '', memo: r.memo || '', batch: r.batch })),
  };
}

async function finImport(env, au, body) {
  if (!finAdmin(au)) return { ok: false, error: '대표·실장만 올릴 수 있습니다.' };
  await finEnsure(env);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 3000) : [];
  if (!rows.length) return { ok: false, error: '올릴 거래가 없습니다.' };
  const rules = {};
  ((await env.DB.prepare('SELECT k, cat FROM fin_rule').all()).results || []).forEach(r => { rules[r.k] = r.cat; });
  const batch = newId('FB');
  const now = Date.now();
  const stmts = [];
  let auto = 0;
  for (const r of rows) {
    const date = String(r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const time = String(r.time || '').slice(0, 8);
    const out = Math.abs(finNum(r.out)), inn = Math.abs(finNum(r.in)), bal = finNum(r.bal);
    if (!out && !inn) continue;
    const descr = String(r.descr || '').trim().slice(0, 100);
    const party = String(r.party || '').trim().slice(0, 100);
    const fp = [date, time, out, inn, bal, descr, party].join('|');
    const k = finKey(party, descr);
    let cat = rules[k] || '';
    if (!cat && /국민연금|건강보험|고용보험|산재|근로복지공단/.test(descr + party)) cat = '4대보험';
    if (!cat && /국세|지방세|세무서|위택스|홈택스|부가세|원천세/.test(descr + party)) cat = '세금·공과';
    if (!cat && /수수료/.test(descr + party)) cat = '수수료';
    if (cat) auto++;
    stmts.push(env.DB.prepare(
      'INSERT OR IGNORE INTO fin_tx (id, fp, ym, date, time, descr, party, out_amt, in_amt, bal, cat, memo, batch, at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(newId('FT'), fp, date.slice(0, 7), date, time, descr, party, out, inn, bal, cat, '', batch, now));
  }
  if (!stmts.length) return { ok: false, error: '날짜·금액을 읽지 못했습니다. 칸 맞추기를 확인해주세요.' };
  let added = 0;
  for (let i = 0; i < stmts.length; i += 80) {
    const res = await env.DB.batch(stmts.slice(i, i + 80));
    res.forEach(x => { added += (x.meta && x.meta.changes) || 0; });
  }
  await finLog(env, au, 'fin_import', batch + ' ' + added + '/' + stmts.length);
  return { ok: true, batch, added, skipped: stmts.length - added, auto };
}

async function finCat(env, au, body) {
  if (!finAdmin(au)) return { ok: false, error: '권한이 없습니다.' };
  await finEnsure(env);
  const id = String(body.id || '');
  const cat = String(body.cat || '');
  const memo = body.memo === undefined ? null : String(body.memo).slice(0, 200);
  if (cat && FIN_CATS.indexOf(cat) < 0) return { ok: false, error: '분류를 확인하세요.' };
  const row = await env.DB.prepare('SELECT * FROM fin_tx WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: '거래를 찾지 못했습니다.' };
  if (memo !== null) {
    await env.DB.prepare('UPDATE fin_tx SET memo = ? WHERE id = ?').bind(memo, id).run();
    return { ok: true };
  }
  await env.DB.prepare('UPDATE fin_tx SET cat = ? WHERE id = ?').bind(cat, id).run();
  let applied = 0;
  /* 다음부터 같은 거래처는 알아서 분류합니다. 아직 분류 안 된 같은 거래처도 같이 맞춥니다. */
  if (cat && body.learn !== false) {
    const k = finKey(row.party, row.descr);
    if (k) {
      await env.DB.prepare('INSERT OR REPLACE INTO fin_rule (k, cat, at) VALUES (?, ?, ?)').bind(k, cat, Date.now()).run();
      const same = (await env.DB.prepare("SELECT id, party, descr FROM fin_tx WHERE (cat = '' OR cat IS NULL) AND id != ?").bind(id).all()).results || [];
      const ids = same.filter(x => finKey(x.party, x.descr) === k).map(x => x.id);
      for (let i = 0; i < ids.length; i += 80) {
        const part = ids.slice(i, i + 80);
        await env.DB.prepare('UPDATE fin_tx SET cat = ? WHERE id IN (' + part.map(() => '?').join(',') + ')').bind(cat, ...part).run();
      }
      applied = ids.length;
    }
  }
  return { ok: true, applied };
}

async function finUndo(env, au, body) {
  if (!finAdmin(au)) return { ok: false, error: '권한이 없습니다.' };
  await finEnsure(env);
  const batch = String(body.batch || '');
  if (!batch) return { ok: false, error: '되돌릴 올리기를 찾지 못했습니다.' };
  const r = await env.DB.prepare('DELETE FROM fin_tx WHERE batch = ?').bind(batch).run();
  await finLog(env, au, 'fin_undo', batch);
  return { ok: true, removed: (r.meta && r.meta.changes) || 0 };
}

/* ── 급여 ── */
async function payList(env, au, url) {
  await finEnsure(env);
  const admin = finAdmin(au);
  const year = /^\d{4}$/.test(String(url.searchParams.get('year') || '')) ? String(url.searchParams.get('year')) : todayStr().slice(0, 4);
  const sql = 'SELECT * FROM pay WHERE ym LIKE ?' + (admin ? '' : ' AND name = ?') + ' ORDER BY ym DESC, name';
  const st = env.DB.prepare(sql);
  const rows = (await (admin ? st.bind(year + '-%') : st.bind(year + '-%', au.name)).all()).results || [];
  await finLog(env, au, 'pay_list', year + (admin ? ' (전체)' : ''));
  return {
    ok: true, year, admin, me: au.name,
    list: rows.map(r => ({ id: r.id, ym: r.ym, name: r.name, payDate: r.pay_date, items: safeJson(r.items, []),
      gross: r.gross, ded: r.ded, net: r.net, note: r.note || '' })),
  };
}

async function payImport(env, au, body) {
  if (!finAdmin(au)) return { ok: false, error: '대표·실장만 올릴 수 있습니다.' };
  await finEnsure(env);
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: '귀속월을 골라주세요.' };
  const payDate = String(body.payDate || '').slice(0, 10);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 100) : [];
  if (!rows.length) return { ok: false, error: '올릴 급여가 없습니다.' };
  const now = Date.now();
  const stmts = rows.filter(r => String(r.name || '').trim()).map(r => {
    const items = (Array.isArray(r.items) ? r.items : []).slice(0, 40).map(x => ({
      k: String(x.k || '').slice(0, 30), v: finNum(x.v), t: x.t === 'ded' ? 'ded' : 'pay' })).filter(x => x.k && x.v);
    const gross = finNum(r.gross) || items.filter(x => x.t === 'pay').reduce((a, x) => a + x.v, 0);
    const ded = finNum(r.ded) || items.filter(x => x.t === 'ded').reduce((a, x) => a + x.v, 0);
    const net = finNum(r.net) || (gross - ded);
    return env.DB.prepare(
      'INSERT INTO pay (id, ym, name, pay_date, items, gross, ded, net, note, at, by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(ym, name) DO UPDATE SET pay_date=excluded.pay_date, items=excluded.items, gross=excluded.gross, ' +
      'ded=excluded.ded, net=excluded.net, note=excluded.note, at=excluded.at, by_name=excluded.by_name'
    ).bind(newId('PY'), ym, String(r.name).trim().slice(0, 20), payDate, JSON.stringify(items), gross, ded, net,
           String(r.note || '').slice(0, 300), now, au.name);
  });
  await env.DB.batch(stmts);
  await finLog(env, au, 'pay_import', ym + ' ' + stmts.length + '명');
  return { ok: true, ym, count: stmts.length };
}

async function payDel(env, au, body) {
  if (!finAdmin(au)) return { ok: false, error: '권한이 없습니다.' };
  await finEnsure(env);
  const ym = String(body.ym || '');
  const name = String(body.name || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: '귀속월을 확인하세요.' };
  const r = name
    ? await env.DB.prepare('DELETE FROM pay WHERE ym = ? AND name = ?').bind(ym, name).run()
    : await env.DB.prepare('DELETE FROM pay WHERE ym = ?').bind(ym).run();
  await finLog(env, au, 'pay_del', ym + ' ' + (name || '전체'));
  return { ok: true, removed: (r.meta && r.meta.changes) || 0 };
}

/* ── 유틸 ── */
function safeJson(s, d) { try { return JSON.parse(s || ''); } catch (e) { return d; } }
function pad2n(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() {
  const d = new Date(Date.now() + 9 * 3600e3);   // KST
  return d.getUTCFullYear() + '-' + pad2n(d.getUTCMonth() + 1) + '-' + pad2n(d.getUTCDate());
}
function thisMonthStr() { return todayStr().slice(0, 7); }
function nowStr() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return todayStr() + ' ' + pad2n(d.getUTCHours()) + ':' + pad2n(d.getUTCMinutes());
}
function newId(p) {
  return p + todayStr().replace(/-/g, '') + Math.floor(Math.random() * 900000 + 100000);
}
function daysBetween(a, b) {
  const pa = a.split('-'), pb = b.split('-');
  const da = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
  const db = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
  return Math.round((db - da) / 86400000);
}
function countWeekdays(ym, hol) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let i = 1; i <= last; i++) {
    const d = new Date(Date.UTC(y, m - 1, i));
    const w = d.getUTCDay();
    if (w === 0 || w === 6) continue;
    const ds = ym + '-' + pad2n(i);
    if (hol && hol[ds]) continue;
    n++;
  }
  return n;
}
function atSummary(ym, list, hol) {
  const weekdays = countWeekdays(ym, hol);
  const byType = {};
  let off = 0, pending = 0;
  list.forEach(x => {
    byType[x.type] = (byType[x.type] || 0) + 1;
    const t = AT_TYPES_D1.find(k => k.key === x.type);
    if (t && !t.work) off++;
    if (x.status === '대기') pending++;
  });
  return { weekdays, workDays: Math.max(0, weekdays - off), offDays: off, pending, byType };
}
/* 달력 칸이 좁아 세 글자로 줄입니다.
   어느 쪽을 남길지는 앞 단어가 무엇이냐에 달렸습니다.

   광역시·특별시 뒤에는 구가 옵니다. 구 이름만 남기면
   "달서" 처럼 어디인지 알기 어려우니 앞쪽을 씁니다.
     대구 달서구 → 대구      부산 금정구 → 부산

   도 뒤에는 시·군이 옵니다. 도 이름보다 시·군이 구체적이라
   이때는 뒤쪽을 씁니다.
     전북 정읍시 → 정읍      경남 거제시 → 거제
     창원       → 창원                            */
const WIDE_CITY_D1 = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종'];

function atShortRegion(region) {
  const parts = String(region || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';

  const strip = x => String(x)
    .replace(/(특별자치시|특별자치도|특별시|광역시|자치시|자치도)$/, '');

  let pick;
  if (parts.length > 1) {
    const head = strip(parts[0]);
    pick = WIDE_CITY_D1.indexOf(head) >= 0 ? head : parts[parts.length - 1];
  } else {
    pick = strip(parts[0]);
  }

  let cut = strip(pick);
  const trimmed = cut.replace(/[시군구]$/, '');
  if (trimmed.length >= 2) cut = trimmed;   // "대구" 가 "대" 가 되지 않게
  if (!cut) cut = pick;

  return cut.substring(0, 3);
}
function atPlanLabel(p) {
  if (!p) return '';
  if (p.workType === '근무OFF') return 'OFF';
  if (p.workType === '재택근무') return '재택';
  if (p.workType === '공휴일') return '공휴일';
  if (p.workType === '연차' || p.workType === '월차') return '월차';
  const parts = [];
  if (p.hyunjang) parts.push('현' + p.hyunjang);
  if (p.ihaeng) parts.push('이' + p.ihaeng);
  if (p.shopping) {
    const m = String(p.shopping).match(/(\d+)\s*건/);
    parts.push('쇼' + (m ? m[1] : ''));
  }
  if (!parts.length) return p.region ? atShortRegion(p.region) : '';
  const body = parts.join('·');
  return p.region ? atShortRegion(p.region) + ' ' + body : body;
}

/* ── 라우팅 ── */
async function handleD1(request, env, ctx, api, url) {
  if (!env.DB) return jsonResponse({ ok: false, error: 'D1 미연결' }, 500);

  let body = {};
  let token = url.searchParams.get('token') || '';
  if (request.method === 'POST') {
    try { body = JSON.parse(await request.text() || '{}'); } catch (e) {}
    token = body.token || token;
  }

  const au = await d1Verify(token, env);
  if (!au.ok) {
    // 만료는 정상적인 재로그인 요구, 그 외(열쇠 불일치 등)는 GAS 로 넘깁니다
    if (au.expired) {
      return jsonResponse({ ok: false, error: au.error, needLogin: true, expired: true });
    }
    /* GAS 에 없는 기능은 넘겨봐야 "unknown action" 만 돌아옵니다.
       원인을 감추지 않도록 여기서 그대로 알려줍니다. */
    if (au.fallback && D1_ONLY.has(api)) {
      return jsonResponse({
        ok: false,
        error: '토큰을 확인하지 못했습니다. Cloudflare 의 TOKEN_SECRET 이 '
             + 'GAS 와 같은 값인지 확인해주세요. (/api/d1_check 로 진단할 수 있습니다)',
      });
    }
    if (au.fallback) return null;      // 호출부가 GAS 경로로 진행합니다
    return jsonResponse({ ok: false, error: au.error, needLogin: true });
  }

  try {
    switch (api) {
      case 'at_month':  return jsonResponse(await d1AtMonth(env, ctx, au, url));
      case 'at_all':    return jsonResponse(await d1AtAll(env, ctx, au, url));
      case 'at_set':    return jsonResponse(await d1AtSet(env, ctx, au, body));
      case 'at_remove': return jsonResponse(await d1AtRemove(env, ctx, au, body));
      case 'at_decide': return jsonResponse(await d1AtDecide(env, ctx, au, body));
      case 'td_list':   return jsonResponse(await d1TdList(env, ctx, au, url));
      case 'td_add':    return jsonResponse(await d1TdAdd(env, ctx, au, body));
      case 'td_update': return jsonResponse(await d1TdUpdate(env, ctx, au, body));
      case 'td_delete': return jsonResponse(await d1TdDelete(env, au, body));
      case 'nt_list':   return jsonResponse(await d1NtList(env, au, url));
      case 'nt_recent': return jsonResponse(await d1NtRecent(env, url));
      case 'nt_write':  return jsonResponse(await d1NtWrite(env, au, body));
      case 'nt_edit':   return jsonResponse(await d1NtEdit(env, au, body));
      case 'nt_remove': return jsonResponse(await d1NtRemove(env, au, body));
      case 'nt_pin':    return jsonResponse(await d1NtPin(env, au, body));
      case 'sl_list':   return jsonResponse(await d1SlList(env, au, url));
      case 'sl_add':    return jsonResponse(await d1SlAdd(env, ctx, au, body));
      case 'sl_edit':   return jsonResponse(await d1SlEdit(env, ctx, au, body));
      case 'sl_remove': return jsonResponse(await d1SlRemove(env, ctx, au, body));
      case 'sl_book':   return jsonResponse(await d1SlBook(env, ctx, au, body));
      case 'at_import': return jsonResponse(await d1AtImport(env, au, body));
      case 'pf_year':   return jsonResponse(await d1PfYear(env, ctx, au, url));
      case 'pf_target': return jsonResponse(await d1PfTarget(env, au, body));
      case 'lv_list':   return jsonResponse(await d1LvList(env, au, url));
      case 'lv_cancel': return jsonResponse(await d1LvCancel(env, ctx, au, body));
      case 'lv_decide': return jsonResponse(await d1LvDecide(env, ctx, au, body));
      case 'fin_list':   return jsonResponse(await finList(env, au, url));
      case 'fin_import': return jsonResponse(await finImport(env, au, body));
      case 'fin_cat':    return jsonResponse(await finCat(env, au, body));
      case 'fin_undo':   return jsonResponse(await finUndo(env, au, body));
      case 'pay_list':   return jsonResponse(await payList(env, au, url));
      case 'pay_import': return jsonResponse(await payImport(env, au, body));
      case 'pay_del':    return jsonResponse(await payDel(env, au, body));
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: 'D1 오류: ' + e.message }, 500);
  }
  return jsonResponse({ ok: false, error: '알 수 없는 요청' }, 404);
}
