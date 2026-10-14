/**
 * 로흐 · 손들의 은하 (Galaxy of Hands) — 관람객이 함께 그리는 작품의 서버 부분
 * -----------------------------------------------------------
 * 방문자가 Pi로 로그인해 하루에 한 획을 남기면, 그 획이 입자가 되어
 * 모두가 함께 보는 하나의 우주에 영원히 쌓입니다.
 *
 * 저장: 기존 낙서 데이터와 섞이지 않도록 별도 Blob 파일(dibutades-cosmos.json)에 저장합니다.
 * 공개: 획의 모양·색·시각만 내보내고, 누가 그렸는지(Pi 아이디)는 밖으로 내보내지 않습니다.
 * 관리: Vercel 환경변수 COSMOS_ADMIN 에 로흐의 Pi 아이디를 넣으면, 그 계정만 획을 지울 수 있습니다.
 *
 * server.js 에서 이렇게 한 줄로 연결합니다 (app.listen 바로 위):
 *   require('./cosmos')(app, { put, get, verifyUser, kstDateString, LOGIN_EXPIRED });
 */

const COSMOS_BLOB_NAME = 'dibutades-cosmos.json';
const MAX_STROKES = 4000;      // 우주에 담을 수 있는 최대 획 수
const MAX_POINTS = 140;        // 한 획에 담을 수 있는 최대 점 수
const WORLD = 1000;            // 좌표 범위 0~1000 (정사각형 우주)
const PALETTE_SIZE = 6;        // 프론트의 색 팔레트 개수와 같아야 함

module.exports = function mountCosmos(app, deps){
  const { put, get, verifyUser, kstDateString, LOGIN_EXPIRED } = deps;

  async function load(){
    try{
      const response = await get(COSMOS_BLOB_NAME, { access: 'private' });
      const c = JSON.parse(await new Response(response.stream).text());
      c.strokes = c.strokes || [];
      c.last = c.last || {};
      return c;
    }catch(e){
      if(!(e && (e.name === 'BlobNotFoundError' || /not.*found/i.test(e.message || '')))) console.error('cosmos load error:', e);
      return { strokes: [], last: {} };
    }
  }
  async function save(c){
    await put(COSMOS_BLOB_NAME, JSON.stringify(c), {
      access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true
    });
  }

  // 같은 사람은 늘 같은 색 (아이디에서 색 번호를 뽑음)
  function hueOf(name){
    let h = 2166136261;
    for(const ch of name) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h % PALETTE_SIZE;
  }
  function isAdmin(name){
    const admin = String(process.env.COSMOS_ADMIN || '').trim().toLowerCase();
    return !!admin && name.toLowerCase() === admin;
  }
  function publicView(c){
    const hands = new Set(c.strokes.map(s => s.a)).size;
    return {
      hands,
      strokes: c.strokes.map(s => ({ id: s.id, h: s.h, p: s.p, t: s.t }))
    };
  }
  // 점 목록 검사: [x,y,x,y,...] 정수 0~1000, 2점 이상
  function cleanPoints(p){
    if(!Array.isArray(p) || p.length < 4 || p.length % 2) return null;
    if(p.length > MAX_POINTS * 2) return null;
    const out = [];
    for(const v of p){
      const n = Math.round(Number(v));
      if(!Number.isFinite(n) || n < 0 || n > WORLD) return null;
      out.push(n);
    }
    // 너무 짧은 점 하나짜리 획은 거절
    let len = 0;
    for(let i = 2; i < out.length; i += 2) len += Math.hypot(out[i] - out[i-2], out[i+1] - out[i-1]);
    return len >= 12 ? out : null;
  }

  // 우주 전체 보기 (로그인 없이 누구나)
  app.get('/api/cosmos', async (req, res) => {
    try{ res.json(publicView(await load())); }
    catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });

  // 내 상태: 오늘 이미 그렸는지, 관리자인지
  app.post('/api/cosmos/me', async (req, res) => {
    const name = await verifyUser((req.body || {}).accessToken);
    if(!name) return res.status(401).json(LOGIN_EXPIRED);
    try{
      const c = await load();
      const key = name.trim().toLowerCase();
      res.json({ drewToday: c.last[key] === kstDateString(Date.now()), admin: isAdmin(name), h: hueOf(key) });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });

  // 한 획 남기기 (하루에 한 번)
  app.post('/api/cosmos', async (req, res) => {
    const { accessToken, p } = req.body || {};
    const name = await verifyUser(accessToken);
    if(!name) return res.status(401).json(LOGIN_EXPIRED);
    const pts = cleanPoints(p);
    if(!pts) return res.status(400).json({ error: 'bad_stroke', message: '획을 읽지 못했어요. 조금 더 길게 그려 주세요.' });
    try{
      const c = await load();
      const key = name.trim().toLowerCase();
      const today = kstDateString(Date.now());
      if(c.last[key] === today && !isAdmin(name)){
        return res.status(429).json({ error: 'once_a_day', message: '오늘의 한 획은 이미 우주에 떠 있어요. 내일 또 만나요.' });
      }
      if(c.strokes.length >= MAX_STROKES){
        return res.status(507).json({ error: 'full', message: '우주가 가득 찼어요.' });
      }
      const stroke = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), a: key, h: hueOf(key), p: pts, t: Date.now() };
      c.strokes.push(stroke);
      c.last[key] = today;
      await save(c);
      res.json({ ok: true, stroke: { id: stroke.id, h: stroke.h, p: stroke.p, t: stroke.t } });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });

  // 획 지우기 (관리자만)
  app.post('/api/cosmos/:id/remove', async (req, res) => {
    const name = await verifyUser((req.body || {}).accessToken);
    if(!name) return res.status(401).json(LOGIN_EXPIRED);
    if(!isAdmin(name)) return res.status(403).json({ error: 'forbidden' });
    try{
      const c = await load();
      const before = c.strokes.length;
      c.strokes = c.strokes.filter(s => s.id !== req.params.id);
      if(c.strokes.length !== before) await save(c);
      res.json({ ok: true, removed: before - c.strokes.length });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });
};
