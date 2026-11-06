/**
 * 로흐 · 파이오니어들의 은하 (Galaxy of Pioneers) — 함께 그리는 작품의 서버 부분
 * -----------------------------------------------------------
 * 파이오니어가 디부타데스에서 낙서·한 끼·로그인 등 무엇이든 할 때마다,
 * 서버가 은하 어딘가에 무작위 획 하나를 저절로 그려 넣습니다 (POST /api/cosmos/auto).
 * 같은 사람의 획은 늘 같은 빛을 띱니다.
 *
 * 작품은 '호'로 나뉩니다. 관리자가 '작품 완성'을 누르면(POST /api/cosmos/complete)
 * 지금 은하가 완성작으로 보관되고(dibutades-cosmos-ed-<호>.json), 다음 호가 빈 은하로 시작됩니다.
 * 완성작 목록: GET /api/cosmos/editions · 완성작 보기: GET /api/cosmos/edition/<호>
 * 예전 '손들의 은하'(호 정보가 없는 데이터)는 처음 불러올 때 백업 후 비우고 제1호로 시작합니다.
 *
 * 저장: 기존 낙서 데이터와 섞이지 않도록 별도 Blob 파일(dibutades-cosmos.json)에 저장합니다.
 * 공개: 획의 모양·색·시각만 내보내고, 누가 그렸는지(Pi 아이디)는 밖으로 내보내지 않습니다.
 * 관리: Vercel 환경변수 COSMOS_ADMIN 에 로흐의 Pi 아이디를 넣으면, 그 계정만 획을 지울 수 있습니다.
 *
 * server.js 에서 이렇게 한 줄로 연결합니다 (app.listen 바로 위):
 *   require('./cosmos')(app, { put, get, verifyUser, kstDateString, LOGIN_EXPIRED });
 */

const COSMOS_BLOB_NAME = 'dibutades-cosmos.json';
const MAX_STROKES = 6000;      // 우주에 담을 수 있는 최대 획 수 (넘치면 가장 오래된 자동 획부터 빛이 사라짐)
const AUTO_GAP_MS = 15 * 1000;  // 같은 사람의 자동 획 사이 최소 간격
const AUTO_PER_DAY = 40;        // 한 사람이 하루에 남길 수 있는 자동 획 수
const MAX_POINTS = 140;        // 한 획에 담을 수 있는 최대 점 수
const WORLD = 1000;            // 좌표 범위 0~1000 (정사각형 우주)
const PALETTE_SIZE = 6;        // 프론트의 색 팔레트 개수와 같아야 함

module.exports = function mountCosmos(app, deps){
  const { put, get, verifyUser, kstDateString, LOGIN_EXPIRED } = deps;

  function freshGalaxy(no){ return { strokes: [], last: {}, edition: { no, startedAt: Date.now() } }; }
  async function load(){
    let c;
    try{
      const response = await get(COSMOS_BLOB_NAME, { access: 'private' });
      c = JSON.parse(await new Response(response.stream).text());
      c.strokes = c.strokes || [];
      c.last = c.last || {};
    }catch(e){
      if(!(e && (e.name === 'BlobNotFoundError' || /not.*found/i.test(e.message || '')))) console.error('cosmos load error:', e);
      return freshGalaxy(1);
    }
    if(!c.edition){
      // 예전 '손들의 은하' 데이터: 백업해 두고 비운 뒤 '파이오니어들의 은하 제1호'로 시작
      if(c.strokes.length){
        const backup = 'dibutades-cosmos-hands-legacy-' + new Date(Date.now() + 9*3600*1000).toISOString().replace(/[-:]/g, '').slice(0, 15) + '.json';
        await put(backup, JSON.stringify(c), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      }
      c = freshGalaxy(1);
      await save(c);
    }
    return c;
  }
  const EDITIONS_BLOB = 'dibutades-cosmos-editions.json';
  async function loadEditions(){
    try{
      const response = await get(EDITIONS_BLOB, { access: 'private' });
      const d = JSON.parse(await new Response(response.stream).text());
      d.list = Array.isArray(d.list) ? d.list : [];
      return d;
    }catch(e){ return { list: [] }; }
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
    // Vercel 환경변수 COSMOS_ADMIN이 있으면 그 값을, 없으면 앱 운영자 로흐의 Pi 아이디를 관리자로 씀
    const admin = String(process.env.COSMOS_ADMIN || 'minkyeungsoon').trim().toLowerCase();
    return !!admin && name.toLowerCase() === admin;
  }
  function publicView(c){
    const hands = new Set(c.strokes.map(s => s.a)).size;
    return {
      hands,
      edition: c.edition ? { no: c.edition.no, startedAt: c.edition.startedAt } : null,
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

  // ---------- 자동 획: 은하 어딘가에 무작위 모양 하나 ----------
  function rnd(a, b){ return a + Math.random() * (b - a); }
  function clampW(v){ return Math.max(0, Math.min(WORLD, Math.round(v))); }
  function randomStroke(){
    // 원반 안 무작위 위치 (가운데가 조금 더 촘촘하게)
    const r0 = Math.sqrt(Math.random()) * 430, a0 = Math.random() * Math.PI * 2;
    const cx = 500 + Math.cos(a0) * r0, cy = 500 + Math.sin(a0) * r0;
    const kind = Math.floor(Math.random() * 4);
    const n = 14 + Math.floor(Math.random() * 14);
    const size = rnd(28, 90), rot = Math.random() * Math.PI * 2, out = [];
    for(let i = 0; i < n; i++){
      const t = i / (n - 1);
      let x, y;
      if(kind === 0){        // 휘어진 호
        const ang = rot + t * rnd(1.2, 2.4); x = Math.cos(ang) * size; y = Math.sin(ang) * size;
      }else if(kind === 1){  // 소용돌이
        const ang = rot + t * Math.PI * 3, rr = size * (0.15 + t * 0.85); x = Math.cos(ang) * rr; y = Math.sin(ang) * rr;
      }else if(kind === 2){  // 물결
        const lx = (t - 0.5) * size * 2.2, ly = Math.sin(t * Math.PI * 3) * size * 0.35;
        x = lx * Math.cos(rot) - ly * Math.sin(rot); y = lx * Math.sin(rot) + ly * Math.cos(rot);
      }else{                 // 고리
        const ang = rot + t * Math.PI * 1.85; x = Math.cos(ang) * size * 0.7; y = Math.sin(ang) * size * 0.45;
      }
      out.push(clampW(cx + x + rnd(-3, 3)), clampW(cy + y + rnd(-3, 3)));
    }
    return out;
  }

  // 자동 획 남기기 (디부타데스에서 버튼을 누를 때마다 앱이 부름, 파이오니어 로그인 필요)
  app.post('/api/cosmos/auto', async (req, res) => {
    const name = await verifyUser((req.body || {}).accessToken);
    if(!name) return res.status(401).json(LOGIN_EXPIRED);
    try{
      const c = await load();
      const key = name.trim().toLowerCase();
      const today = kstDateString(Date.now());
      c.autoLast = c.autoLast || {};
      c.autoCount = c.autoCount || {};
      const cnt = c.autoCount[key] && c.autoCount[key].d === today ? c.autoCount[key].n : 0;
      if(Date.now() - (c.autoLast[key] || 0) < AUTO_GAP_MS) return res.json({ ok: false, reason: 'too_soon' });
      if(cnt >= AUTO_PER_DAY) return res.json({ ok: false, reason: 'daily_limit' });
      const stroke = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), a: key, h: hueOf(key), p: randomStroke(), t: Date.now(), auto: 1 };
      c.strokes.push(stroke);
      if(c.strokes.length > MAX_STROKES){                     // 넘치면 가장 오래된 자동 획부터 정리
        const idx = c.strokes.findIndex(s => s.auto);
        c.strokes.splice(idx >= 0 ? idx : 0, 1);
      }
      c.autoLast[key] = Date.now();
      c.autoCount[key] = { d: today, n: cnt + 1 };
      // 날이 바뀐 기록은 정리
      for(const k of Object.keys(c.autoCount)) if(c.autoCount[k].d !== today) delete c.autoCount[k];
      await save(c);
      res.json({ ok: true, stroke: { id: stroke.id, h: stroke.h, p: stroke.p, t: stroke.t }, total: c.strokes.length });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });

  // ---------- 작품 완성 (관리자만): 지금 은하를 완성작으로 보관하고 다음 호 시작 ----------
  app.post('/api/cosmos/complete', async (req, res) => {
    const { accessToken, title } = req.body || {};
    const name = await verifyUser(accessToken);
    if(!name) return res.status(401).json(LOGIN_EXPIRED);
    if(!isAdmin(name)) return res.status(403).json({ error: 'forbidden' });
    try{
      const c = await load();
      if(!c.strokes.length) return res.status(400).json({ error: 'empty', message: '아직 별이 없는 은하는 완성할 수 없어요.' });
      const no = (c.edition && c.edition.no) || 1;
      const t = String(title || '').trim().slice(0, 60) || `파이오니어들의 은하 제${no}호`;
      const view = publicView(c);
      const archive = { no, title: t, startedAt: (c.edition && c.edition.startedAt) || null, endedAt: Date.now(), hands: view.hands, strokes: view.strokes };
      await put(`dibutades-cosmos-ed-${no}.json`, JSON.stringify(archive), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      const eds = await loadEditions();
      eds.list = eds.list.filter(x => x.no !== no).concat({ no, title: t, startedAt: archive.startedAt, endedAt: archive.endedAt, count: archive.strokes.length, hands: archive.hands });
      await put(EDITIONS_BLOB, JSON.stringify(eds), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      await save(freshGalaxy(no + 1));
      res.json({ ok: true, completed: { no, title: t, count: archive.strokes.length }, next: no + 1 });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });
  // 완성작 목록 (최근 것부터)
  app.get('/api/cosmos/editions', async (req, res) => {
    try{
      const eds = await loadEditions();
      res.set('Cache-Control', 'no-store');
      res.json({ list: eds.list.slice().sort((a, b) => b.no - a.no) });
    }catch(e){ res.status(500).json({ error: e.message }); }
  });
  // 완성작 하나 보기
  app.get('/api/cosmos/edition/:no', async (req, res) => {
    const no = parseInt(req.params.no, 10);
    if(!(no > 0)) return res.status(400).json({ error: 'bad_no' });
    try{
      const response = await get(`dibutades-cosmos-ed-${no}.json`, { access: 'private' });
      res.set('Cache-Control', 'public, max-age=300');
      res.json(JSON.parse(await new Response(response.stream).text()));
    }catch(e){ res.status(404).json({ error: 'not_found' }); }
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

  // 전체 리셋 (관리자만): 지금까지의 작품을 백업 파일로 보관한 뒤 우주를 비우고, 오늘의 한 획 기록도 초기화
  app.post('/api/cosmos/reset', async (req, res) => {
    const name = await verifyUser((req.body || {}).accessToken);
    if(!name) return res.status(401).json(LOGIN_EXPIRED);
    if(!isAdmin(name)) return res.status(403).json({ error: 'forbidden' });
    try{
      const c = await load();
      const count = c.strokes.length;
      let backup = null;
      if(count){
        backup = 'dibutades-cosmos-backup-' + new Date(Date.now() + 9*3600*1000).toISOString().replace(/[-:]/g, '').slice(0, 15) + '.json';
        await put(backup, JSON.stringify(c), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      }
      await save({ strokes: [], last: {}, edition: { no: (c.edition && c.edition.no) || 1, startedAt: Date.now() }, resetAt: Date.now(), previous: backup });
      res.json({ ok: true, cleared: count, backup });
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
