/**
 * 디부타데스 · 오늘의 소식 (파이 / 암호화폐 / 역사 속 오늘) — 서버 부분
 * -----------------------------------------------------------
 * 브라우저에서 바로 부르기 어려운 뉴스·역사 자료를 서버가 대신 가져와
 * 15분 동안 보관(캐시)했다가 앱에 넘겨 줍니다. 추가 설치할 패키지는 없습니다.
 *
 *  GET /api/news?topic=pi       → 파이 관련 최근 뉴스 (7일 안)
 *  GET /api/news?topic=crypto   → 암호화폐 최근 뉴스 (3일 안)
 *  GET /api/news?topic=history  → 역사 속 오늘 (한국시간 기준 날짜)
 *  GET/POST /api/meal           → 오늘 뭐 먹지? (오늘의 세계 밥상 + 세계 사람들의 한 끼)
 *
 * 오래된 소식이 새 소식처럼 섞이지 않도록, 뉴스는 기간(파이 7일, 암호화폐 3일)이
 * 지난 것은 빼고, 항상 날짜와 출처를 함께 보냅니다.
 *
 * server.js 에서 이렇게 한 줄로 연결합니다 (app.listen 바로 위):
 *   require('./news')(app);
 */

const CACHE_MS = 15 * 60 * 1000;
const UA = 'DibutadesApp/1.0 (Pi Network community app; https://dibutades-app.vercel.app)';
const cache = new Map();

async function cached(key, fn){
  const hit = cache.get(key);
  if(hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try{
    const data = await fn();
    cache.set(key, { at: Date.now(), data });
    return data;
  }catch(e){
    console.error('news fetch error', key, e && e.message);
    if(hit) return hit.data;          // 실패하면 직전 자료라도 보여 줌
    throw e;
  }
}

async function getText(url){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try{
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' }, signal: ctrl.signal });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }finally{ clearTimeout(t); }
}
async function getJson(url){ return JSON.parse(await getText(url)); }

function decode(s){
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}
function tag(xml, name){
  const m = xml.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>'));
  return m ? decode(m[1]) : '';
}

// Google 뉴스 RSS 검색 → [{title, source, link, t}]
async function googleNews(query, maxAgeDays, limit, lang){
  const loc = lang === 'en' ? '&hl=en-US&gl=US&ceid=US:en' : '&hl=ko&gl=KR&ceid=KR:ko';
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + loc;
  const xml = await getText(url);
  const items = xml.split('<item>').slice(1).map(chunk => {
    const source = tag(chunk, 'source');
    let title = tag(chunk, 'title');
    if(source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const t = Date.parse(tag(chunk, 'pubDate')) || 0;
    return { title, source, link: tag(chunk, 'link'), t };
  });
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  const seen = new Set();
  return items
    .filter(it => it.title && it.link && it.t >= cutoff)
    .sort((a, b) => b.t - a.t)
    .filter(it => { const k = it.title.slice(0, 24); if(seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit);
}

async function piTopic(){
  // 실시간 가격은 화면 맨 아래 숫자 줄에서 1분마다 보여 주므로, 여기서는 소식만
  // 한국어 소식 먼저, 그 아래 영어 소식
  const [news, newsEn] = await Promise.all([
    googleNews('파이코인 OR 파이네트워크 OR "Pi Network"', 7, 4, 'ko').catch(() => []),
    googleNews('"Pi Network" OR "Pi Coin"', 7, 4, 'en').catch(() => [])
  ]);
  return { topic: 'pi', news, newsEn };
}

async function cryptoTopic(){
  // 가격 순위는 다른 시세 앱에서도 볼 수 있어 빼고, 최근 소식만 보여 줍니다
  const [news, newsEn] = await Promise.all([
    googleNews('암호화폐 OR 비트코인 OR 가상자산', 3, 4, 'ko').catch(() => []),
    googleNews('crypto OR bitcoin OR cryptocurrency', 3, 4, 'en').catch(() => [])
  ]);
  return { topic: 'crypto', news, newsEn };
}

function kstMonthDay(){
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
// 한국어 위키백과 날짜 문서(예: "11월 10일")의 "사건" 부분에서 연도와 내용을 뽑습니다.
// (위키미디어 '오늘의 역사' 묶음 자료는 한국어를 지원하지 않아서 직접 읽어 옵니다)
function wikiPlain(t){
  return String(t || '')
    .replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '').replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, '$1').replace(/\[https?:\/\/\S+\]/g, '')
    .replace(/'{2,}/g, '').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function koWikiEvents(wikitext, m, d){
  const lines = String(wikitext || '').split('\n');
  let inEvents = false, year = null;
  const out = [];
  for(const raw of lines){
    const line = raw.trim();
    const h = line.match(/^==\s*([^=].*?)\s*==$/);
    if(h){ inEvents = /사건/.test(h[1]); year = null; continue; }
    if(!inEvents || !line.startsWith('*')) continue;
    const depth = line.match(/^\*+/)[0].length;
    const body = line.replace(/^\*+\s*/, '');
    const y = body.match(/^\[\[(기원전\s*)?(\d{1,4})년(?:\|[^\]]*)?\]\]\s*(?:[-–—:]\s*)?(.*)$/);
    if(y){
      year = y[1] ? -Number(y[2]) : Number(y[2]);
      const text = wikiPlain(y[3]);
      if(text) out.push({ year, text, link: null, lang: 'ko' });
    }else if(depth >= 2 && year != null){
      const text = wikiPlain(body);
      if(text) out.push({ year, text, link: null, lang: 'ko' });
    }
  }
  const page = 'https://ko.m.wikipedia.org/wiki/' + encodeURIComponent(`${m}월 ${d}일`.replace(/ /g, '_'));
  return out.filter(e => e.year > 0 && e.text.length >= 4 && e.text.length <= 160).map(e => Object.assign(e, { link: page }));
}
async function koHistory(m, d){
  const title = encodeURIComponent(`${m}월 ${d}일`.replace(/ /g, '_'));
  const data = await getJson(`https://ko.wikipedia.org/w/api.php?action=parse&page=${title}&prop=wikitext&redirects=1&format=json&formatversion=2`);
  return koWikiEvents(data && data.parse && data.parse.wikitext, m, d);
}

// 번역: MyMemory 무료 번역 (키 없이 하루 사용량이 정해져 있어서, 하루 한 번만 번역하고 Blob에 보관)
async function translate(text, from, to){
  const q = String(text || '').slice(0, 450);
  if(!q) return '';
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + from + '|' + to;
  const j = await getJson(url);
  const out = j && j.responseData && j.responseData.translatedText;
  if(!out || j.quotaFinished || Number(j.responseStatus) !== 200) throw new Error('translate_failed');
  if(/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('translate_limit');
  return decode(out);
}
const HIST_BLOB = 'dibutades-history.json';
async function histLoad(){
  try{
    const { get } = require('@vercel/blob');
    const res = await get(HIST_BLOB, { access: 'private' });
    return JSON.parse(await new Response(res.stream).text());
  }catch(e){ return null; }
}
async function histSave(h){
  try{
    const { put } = require('@vercel/blob');
    await put(HIST_BLOB, JSON.stringify(h), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
  }catch(e){ console.error('history save', e && e.message); }
}

async function historyTopic(){
  const { m, d } = kstMonthDay();
  const mm = String(m).padStart(2, '0'), dd = String(d).padStart(2, '0');
  const dateKey = `${mm}-${dd}`;
  // 오늘 이미 번역해 둔 것이 있으면 그대로 (번역이 덜 된 채면 1시간 뒤 다시 시도)
  const saved = await histLoad();
  if(saved && saved.date === dateKey && (saved.complete || Date.now() - (saved.at || 0) < 3600 * 1000)){
    return { topic: 'history', month: m, day: d, events: saved.events || [], eventsEn: saved.eventsEn || [] };
  }
  const pick = (data, lang) => ((data && (data.selected || data.events)) || []).map(e => ({
    year: e.year,
    text: e.text,
    link: e.pages && e.pages[0] && e.pages[0].content_urls && e.pages[0].content_urls.mobile ? e.pages[0].content_urls.mobile.page : null,
    lang
  })).filter(e => e.year && e.text);
  // 한국 위키백과 사건 + 영어 위키백과(세계) 사건
  const [ko, en] = await Promise.all([
    koHistory(m, d).catch(() => []),
    getJson(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/${mm}/${dd}`).then(x => pick(x, 'en')).catch(() => [])
  ]);
  ko.sort((a, b) => b.year - a.year); // 가까운 해부터
  en.sort((a, b) => b.year - a.year);
  let complete = true;
  const tr = (t, f, to) => translate(t, f, to).catch(() => { complete = false; return ''; });
  // 한국 사건: 한국어 원문 + 영어 번역 / 세계 사건: 한국어 번역 + 영어 원문
  const events = await Promise.all(ko.slice(0, 4).map(async e => ({ year: e.year, link: e.link, ko: e.text, en: await tr(e.text, 'ko', 'en') })));
  const eventsEn = await Promise.all(en.slice(0, 4).map(async e => ({ year: e.year, link: e.link, ko: await tr(e.text, 'en', 'ko'), en: e.text })));
  if(events.length || eventsEn.length) await histSave({ date: dateKey, at: Date.now(), complete, events, eventsEn });
  return { topic: 'history', month: m, day: d, events, eventsEn };
}



/* =====================================================================
 * 오늘 뭐 먹지? · 오늘의 세계 밥상 + 세계 사람들의 한 끼 (지도)
 *  GET  /api/meal            → 오늘의 밥상 + 오늘(한국시간) 올라온 한 끼 목록
 *  POST /api/meal            → { accessToken, country, time, text } 한 끼 올리기 (하루 3번까지)
 * 저장: Vercel Blob 'dibutades-meals.json' (최근 3일치만 보관)
 * ===================================================================== */
const MEAL_DISHES = [
  { code:'PE', ko:'페루', en:'Peru', dish:'세비체', dishEn:'Ceviche', when:'점심', items:'생선 · 라임 · 양파 · 고추',
    desc:'신선한 생선을 라임즙에 재워 새콤하게 만든 요리예요. 바닷가 사람들이 한낮에 즐겨 먹어요.',
    descEn:'Fresh fish cured in lime juice — a midday favourite along the coast.' },
  { code:'KR', ko:'대한민국', en:'South Korea', dish:'비빔밥', dishEn:'Bibimbap', when:'점심', items:'밥 · 나물 · 고추장 · 달걀',
    desc:'밥 위에 여러 가지 나물과 고추장을 올려 비벼 먹어요. 남은 반찬으로도 뚝딱 만드는 한 그릇이에요.',
    descEn:'Rice topped with seasoned vegetables and chili paste, mixed together in one bowl.' },
  { code:'JP', ko:'일본', en:'Japan', dish:'오니기리', dishEn:'Onigiri', when:'아침 · 간식', items:'밥 · 김 · 연어 · 매실',
    desc:'밥을 세모나게 뭉쳐 김으로 감싼 주먹밥이에요. 편의점과 도시락의 단골이에요.',
    descEn:'Rice balls wrapped in seaweed — a staple of lunch boxes and convenience stores.' },
  { code:'VN', ko:'베트남', en:'Vietnam', dish:'쌀국수 퍼', dishEn:'Phở', when:'아침', items:'쌀국수 · 소고기 육수 · 허브',
    desc:'오래 끓인 맑은 육수에 쌀국수와 고기, 향긋한 허브를 얹어요. 아침 거리에서 김이 모락모락 나요.',
    descEn:'Rice noodles in a long-simmered clear broth with herbs, often eaten for breakfast.' },
  { code:'TH', ko:'태국', en:'Thailand', dish:'팟타이', dishEn:'Pad Thai', when:'저녁', items:'쌀국수 · 새우 · 땅콩 · 숙주',
    desc:'쌀국수를 새콤달콤한 소스에 볶아 땅콩과 라임을 곁들여요. 밤 노점의 대표 메뉴예요.',
    descEn:'Stir-fried rice noodles with a sweet-sour sauce, peanuts and lime.' },
  { code:'IN', ko:'인도', en:'India', dish:'달과 짜파티', dishEn:'Dal & Chapati', when:'점심 · 저녁', items:'렌틸콩 · 향신료 · 통밀빵',
    desc:'렌틸콩을 향신료와 푹 끓인 달을 얇은 통밀빵 짜파티에 싸서 먹어요. 집집마다 맛이 달라요.',
    descEn:'Spiced lentil stew scooped up with thin whole-wheat flatbread.' },
  { code:'CN', ko:'중국', en:'China', dish:'만두 자오쯔', dishEn:'Jiaozi', when:'저녁', items:'밀가루 피 · 돼지고기 · 배추',
    desc:'얇은 피에 고기와 채소를 넣어 빚은 만두예요. 명절이면 온 가족이 둘러앉아 빚어요.',
    descEn:'Boiled dumplings filled with pork and cabbage, made together at festivals.' },
  { code:'ID', ko:'인도네시아', en:'Indonesia', dish:'나시고렝', dishEn:'Nasi Goreng', when:'아침 · 저녁', items:'밥 · 달콤한 간장 · 달걀',
    desc:'달콤한 간장 케찹 마니스로 볶은 볶음밥에 달걀 프라이를 올려요.',
    descEn:'Fried rice with sweet soy sauce, topped with a fried egg.' },
  { code:'PH', ko:'필리핀', en:'Philippines', dish:'아도보', dishEn:'Adobo', when:'점심 · 저녁', items:'닭 · 돼지고기 · 식초 · 간장 · 마늘',
    desc:'고기를 식초와 간장, 마늘에 조려 새콤짭짤해요. 밥 한 그릇이 금방 사라져요.',
    descEn:'Meat braised in vinegar, soy sauce and garlic, served with rice.' },
  { code:'NG', ko:'나이지리아', en:'Nigeria', dish:'졸로프 라이스', dishEn:'Jollof Rice', when:'점심 · 잔치', items:'쌀 · 토마토 · 고추 · 양파',
    desc:'토마토와 고추로 지은 붉은 밥이에요. 잔칫날이면 꼭 빠지지 않아요.',
    descEn:'Rice cooked in a tomato and pepper sauce — a must at every celebration.' },
  { code:'ET', ko:'에티오피아', en:'Ethiopia', dish:'인제라', dishEn:'Injera', when:'점심 · 저녁', items:'테프 가루 · 스튜',
    desc:'시큼하고 폭신한 큰 전병 위에 여러 스튜를 올리고, 손으로 찢어 함께 나눠 먹어요.',
    descEn:'A spongy sourdough flatbread shared by hand with stews on top.' },
  { code:'MA', ko:'모로코', en:'Morocco', dish:'타진', dishEn:'Tagine', when:'저녁', items:'양고기 · 채소 · 말린 과일 · 향신료',
    desc:'고깔 모양 뚜껑의 냄비에 고기와 채소를 오래 익힌 요리예요. 냄비 이름이 곧 요리 이름이에요.',
    descEn:'Slow-cooked stew named after its cone-lidded clay pot.' },
  { code:'EG', ko:'이집트', en:'Egypt', dish:'코샤리', dishEn:'Koshari', when:'점심', items:'쌀 · 렌틸콩 · 마카로니 · 토마토소스',
    desc:'밥, 콩, 파스타를 한데 담고 토마토소스와 바삭한 양파를 얹어요. 거리의 든든한 한 끼예요.',
    descEn:'Rice, lentils and pasta with tomato sauce and crispy onions.' },
  { code:'ZA', ko:'남아프리카공화국', en:'South Africa', dish:'보보티', dishEn:'Bobotie', when:'저녁', items:'다진 고기 · 카레 향신료 · 달걀',
    desc:'향신료로 양념한 다진 고기 위에 달걀물을 부어 구워요.',
    descEn:'Spiced minced meat baked with an egg topping.' },
  { code:'KE', ko:'케냐', en:'Kenya', dish:'우갈리와 수쿠마', dishEn:'Ugali & Sukuma', when:'저녁', items:'옥수숫가루 · 케일',
    desc:'옥수숫가루를 되직하게 쑨 우갈리에 볶은 케일을 곁들여요. 동아프리카 식탁의 기본이에요.',
    descEn:'Firm maize porridge with sautéed greens — an East African staple.' },
  { code:'TR', ko:'튀르키예', en:'Türkiye', dish:'메네멘', dishEn:'Menemen', when:'아침', items:'달걀 · 토마토 · 고추',
    desc:'토마토와 고추를 볶다가 달걀을 풀어 익혀요. 빵을 찍어 먹는 아침 메뉴예요.',
    descEn:'Eggs scrambled with tomatoes and peppers, eaten with bread at breakfast.' },
  { code:'IR', ko:'이란', en:'Iran', dish:'첼로 케밥', dishEn:'Chelow Kebab', when:'점심', items:'사프란 밥 · 구운 고기',
    desc:'사프란 향의 길쭉한 쌀밥에 숯불에 구운 꼬치고기를 곁들여요.',
    descEn:'Saffron rice served with grilled kebab.' },
  { code:'LB', ko:'레바논', en:'Lebanon', dish:'후무스와 피타', dishEn:'Hummus & Pita', when:'간식 · 전채', items:'병아리콩 · 참깨 소스 · 올리브유',
    desc:'병아리콩을 곱게 갈아 참깨 소스와 올리브유를 섞어요. 둥근 빵 피타에 찍어 먹어요.',
    descEn:'Chickpea and sesame dip with olive oil, scooped with pita bread.' },
  { code:'IT', ko:'이탈리아', en:'Italy', dish:'카르보나라', dishEn:'Carbonara', when:'점심', items:'파스타 · 달걀 노른자 · 치즈 · 관찰레',
    desc:'로마식은 크림 없이 달걀 노른자와 치즈, 돼지 볼살로 맛을 내요.',
    descEn:'Roman pasta made with egg yolk, cheese and cured pork cheek — no cream.' },
  { code:'FR', ko:'프랑스', en:'France', dish:'크로크무슈', dishEn:'Croque Monsieur', when:'점심', items:'빵 · 햄 · 치즈 · 베샤멜',
    desc:'햄과 치즈를 넣은 빵을 구워 낸 카페의 단골 메뉴예요.',
    descEn:'A grilled ham-and-cheese sandwich, a café classic.' },
  { code:'ES', ko:'스페인', en:'Spain', dish:'파에야', dishEn:'Paella', when:'점심', items:'쌀 · 사프란 · 해산물 · 닭고기',
    desc:'넓은 팬에 쌀과 해산물을 넣어 사프란으로 노랗게 지어요. 주말 점심에 다 같이 나눠 먹어요.',
    descEn:'Saffron rice cooked in a wide pan, shared at weekend lunches.' },
  { code:'DE', ko:'독일', en:'Germany', dish:'브레첼과 소시지', dishEn:'Brezel & Wurst', when:'아침 · 간식', items:'빵 · 소시지 · 겨자',
    desc:'매듭 모양 빵 브레첼에 소시지와 겨자를 곁들여요.',
    descEn:'Knot-shaped pretzel bread with sausage and mustard.' },
  { code:'GB', ko:'영국', en:'United Kingdom', dish:'피시 앤드 칩스', dishEn:'Fish and Chips', when:'저녁', items:'흰살생선 · 감자 · 완두콩',
    desc:'바삭하게 튀긴 생선과 두툼한 감자튀김에 식초를 뿌려 먹어요.',
    descEn:'Battered fried fish with thick chips and a splash of vinegar.' },
  { code:'GR', ko:'그리스', en:'Greece', dish:'수블라키', dishEn:'Souvlaki', when:'저녁', items:'꼬치고기 · 피타 · 차지키',
    desc:'꼬치에 구운 고기를 빵에 싸고 요거트 소스 차지키를 듬뿍 올려요.',
    descEn:'Grilled skewered meat in pita with tzatziki.' },
  { code:'PL', ko:'폴란드', en:'Poland', dish:'피에로기', dishEn:'Pierogi', when:'점심 · 저녁', items:'밀가루 피 · 감자 · 치즈',
    desc:'감자와 치즈를 넣어 반달 모양으로 빚은 만두예요.',
    descEn:'Half-moon dumplings filled with potato and cheese.' },
  { code:'RU', ko:'러시아', en:'Russia', dish:'보르시', dishEn:'Borscht', when:'점심', items:'비트 · 양배추 · 사워크림',
    desc:'비트로 붉게 끓인 수프에 사워크림을 한 숟갈 얹어요. 동유럽 여러 나라에서 즐겨요.',
    descEn:'Beet soup topped with sour cream, loved across Eastern Europe.' },
  { code:'SE', ko:'스웨덴', en:'Sweden', dish:'미트볼', dishEn:'Köttbullar', when:'저녁', items:'다진 고기 · 감자 · 링곤베리 잼',
    desc:'작은 미트볼에 으깬 감자와 새콤한 링곤베리 잼을 곁들여요.',
    descEn:'Meatballs with mashed potatoes and lingonberry jam.' },
  { code:'US', ko:'미국', en:'United States', dish:'팬케이크', dishEn:'Pancakes', when:'아침', items:'밀가루 · 달걀 · 메이플 시럽',
    desc:'폭신하게 구운 팬케이크를 몇 장 쌓아 메이플 시럽을 뿌려요. 주말 아침의 즐거움이에요.',
    descEn:'Fluffy stacked pancakes with maple syrup — a weekend breakfast.' },
  { code:'MX', ko:'멕시코', en:'Mexico', dish:'타코', dishEn:'Tacos', when:'점심 · 저녁', items:'옥수수 토르티야 · 고기 · 살사',
    desc:'옥수수 토르티야에 고기와 양파, 고수, 살사를 얹어 접어 먹어요.',
    descEn:'Corn tortillas folded around meat, onion, cilantro and salsa.' },
  { code:'CA', ko:'캐나다', en:'Canada', dish:'푸틴', dishEn:'Poutine', when:'간식', items:'감자튀김 · 치즈 커드 · 그레이비',
    desc:'감자튀김 위에 치즈 덩어리와 뜨거운 그레이비 소스를 부어요.',
    descEn:'Fries topped with cheese curds and hot gravy.' },
  { code:'BR', ko:'브라질', en:'Brazil', dish:'페이조아다', dishEn:'Feijoada', when:'점심', items:'검은콩 · 돼지고기 · 쌀 · 케일',
    desc:'검은콩과 여러 부위의 돼지고기를 푹 끓인 스튜예요. 토요일 점심의 상징이에요.',
    descEn:'Black bean and pork stew, a Saturday lunch tradition.' },
  { code:'AR', ko:'아르헨티나', en:'Argentina', dish:'아사도', dishEn:'Asado', when:'주말 · 저녁', items:'소고기 · 숯불 · 치미추리',
    desc:'숯불에 소고기를 천천히 구워 허브 소스 치미추리와 함께 먹어요. 가족 모임의 중심이에요.',
    descEn:'Slow-grilled beef with chimichurri, the heart of family gatherings.' },
  { code:'CO', ko:'콜롬비아', en:'Colombia', dish:'아레파', dishEn:'Arepa', when:'아침', items:'옥수숫가루 · 치즈 · 버터',
    desc:'옥수숫가루 반죽을 둥글넓적하게 구워 치즈나 버터를 곁들여요.',
    descEn:'Grilled corn cakes with cheese or butter.' },
  { code:'CL', ko:'칠레', en:'Chile', dish:'엠파나다', dishEn:'Empanada', when:'간식 · 명절', items:'밀가루 반죽 · 다진 고기 · 양파 · 올리브',
    desc:'반죽 속에 고기와 양파, 올리브를 넣어 구운 파이예요. 명절에 특히 많이 먹어요.',
    descEn:'Baked pastries filled with meat, onion and olives.' },
  { code:'AU', ko:'오스트레일리아', en:'Australia', dish:'미트파이', dishEn:'Meat Pie', when:'간식 · 점심', items:'파이 반죽 · 다진 고기 · 그레이비',
    desc:'손바닥만 한 파이 속에 고기와 그레이비가 가득해요. 경기장에서 들고 먹는 간식이에요.',
    descEn:'Hand-sized pies filled with minced meat and gravy.' },
  { code:'NZ', ko:'뉴질랜드', en:'New Zealand', dish:'항이', dishEn:'Hāngī', when:'잔치', items:'고기 · 고구마 · 땅속 화덕',
    desc:'마오리족 전통으로, 달군 돌을 땅에 묻고 고기와 채소를 오래 쪄 내요.',
    descEn:'A Māori tradition of cooking food in an earth oven with heated stones.' },
  { code:'MY', ko:'말레이시아', en:'Malaysia', dish:'나시 르막', dishEn:'Nasi Lemak', when:'아침', items:'코코넛 밥 · 멸치 · 땅콩 · 삼발',
    desc:'코코넛밀크로 지은 밥에 매콤한 삼발과 멸치, 땅콩을 곁들여요.',
    descEn:'Coconut rice with spicy sambal, anchovies and peanuts.' },
  { code:'PK', ko:'파키스탄', en:'Pakistan', dish:'비리야니', dishEn:'Biryani', when:'점심 · 잔치', items:'쌀 · 고기 · 향신료',
    desc:'향신료에 재운 고기와 쌀을 켜켜이 쌓아 익혀요. 잔칫상의 주인공이에요.',
    descEn:'Layered spiced rice and meat, the star of celebrations.' },
  { code:'BD', ko:'방글라데시', en:'Bangladesh', dish:'생선 카레와 밥', dishEn:'Fish Curry & Rice', when:'점심', items:'민물생선 · 겨자유 · 쌀',
    desc:'강이 많은 나라답게 민물생선을 겨자유와 향신료로 끓인 카레를 밥과 먹어요.',
    descEn:'River fish cooked in mustard oil and spices, eaten with rice.' },
  { code:'MN', ko:'몽골', en:'Mongolia', dish:'보쯔', dishEn:'Buuz', when:'명절', items:'밀가루 피 · 양고기',
    desc:'양고기를 넣고 쪄 낸 만두예요. 설날 차강사르에 많이 빚어요.',
    descEn:'Steamed mutton dumplings, made in large batches for Lunar New Year.' }
];
const MEAL_COUNTRIES = ['KR','JP','CN','TW','HK','MN','VN','TH','PH','ID','MY','SG','IN','PK','BD','NG','GH','ET','KE','ZA','EG','MA','TR','IR','SA','AE','LB','IT','FR','ES','PT','DE','GB','NL','GR','PL','UA','RU','SE','US','CA','MX','BR','AR','CO','CL','PE','AU','NZ','ZZ'];
const MEAL_TIMES = ['아침','점심','저녁','간식'];
const MEAL_BLOB = 'dibutades-meals.json';
const mealTokenCache = new Map();

function kstDay(ts){ return new Date(ts + 9*3600*1000).toISOString().slice(0, 10); }
function todayDish(){
  const d = new Date(Date.now() + 9*3600*1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
  return Object.assign({ month: d.getUTCMonth() + 1, day: d.getUTCDate() }, MEAL_DISHES[dayOfYear % MEAL_DISHES.length]);
}
async function mealVerify(accessToken){
  if(!accessToken || typeof accessToken !== 'string') return null;
  const hit = mealTokenCache.get(accessToken);
  if(hit && hit.exp > Date.now()) return hit.name;
  try{
    const r = await fetch('https://api.minepi.com/v2/me', { headers: { Authorization: 'Bearer ' + accessToken } });
    if(!r.ok) return null;
    const me = await r.json();
    const name = String(me.username || '').trim();
    if(!name) return null;
    if(mealTokenCache.size > 500) mealTokenCache.clear();
    mealTokenCache.set(accessToken, { name, exp: Date.now() + 10*60*1000 });
    return name;
  }catch(e){ return null; }
}
async function mealLoad(){
  try{
    const { get } = require('@vercel/blob');
    const res = await get(MEAL_BLOB, { access: 'private' });
    const m = JSON.parse(await new Response(res.stream).text());
    m.days = m.days || {};
    return m;
  }catch(e){
    if(!(e && (e.name === 'BlobNotFoundError' || /not.*found/i.test(e.message || '')))) console.error('meal load error:', e && e.message);
    return { days: {} };
  }
}
async function mealSave(m){
  const { put } = require('@vercel/blob');
  const keep = Object.keys(m.days).sort().slice(-3);          // 최근 3일만 보관
  m.days = Object.fromEntries(keep.map(k => [k, m.days[k]]));
  await put(MEAL_BLOB, JSON.stringify(m), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
}
function publicMeals(list){
  return list.slice(-60).reverse().map(p => ({ id: p.id, c: p.c, w: p.w, x: p.x, a: p.a, t: p.t }));
}

function mountMeal(app){
  app.get('/api/meal', async (req, res) => {
    try{
      const m = await mealLoad();
      const list = m.days[kstDay(Date.now())] || [];
      res.set('Cache-Control', 'no-store');
      res.json({ dish: todayDish(), posts: publicMeals(list), total: list.length, countries: new Set(list.map(p => p.c)).size });
    }catch(e){ console.error(e); res.status(500).json({ error: 'meal_unavailable' }); }
  });

  app.post('/api/meal', async (req, res) => {
    const { accessToken, country, time, text } = req.body || {};
    const name = await mealVerify(accessToken);
    if(!name) return res.status(401).json({ error: 'login required', message: '로그인이 만료되었어요. 다시 Pi로 로그인해주세요.' });
    const c = String(country || '').toUpperCase();
    const w = String(time || '');
    const x = String(text || '').replace(/\s+/g, ' ').trim();
    if(!MEAL_COUNTRIES.includes(c)) return res.status(400).json({ error: 'bad_country', message: '나라를 골라 주세요.' });
    if(!MEAL_TIMES.includes(w)) return res.status(400).json({ error: 'bad_time', message: '아침·점심·저녁·간식 중에 골라 주세요.' });
    if(!x || x.length > 40) return res.status(400).json({ error: 'bad_text', message: '한 끼를 40자 안으로 적어 주세요.' });
    if(/https?:\/\/|www\./i.test(x)) return res.status(400).json({ error: 'no_link', message: '링크는 넣을 수 없어요.' });
    try{
      const m = await mealLoad();
      const day = kstDay(Date.now());
      const list = m.days[day] = m.days[day] || [];
      const key = name.toLowerCase();
      if(list.filter(p => p.k === key).length >= 3) return res.status(429).json({ error: 'limit', message: '한 끼는 하루 세 번까지 올릴 수 있어요. 내일 또 알려 주세요!' });
      const post = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), k: key, a: name, c, w, x, t: Date.now() };
      list.push(post);
      await mealSave(m);
      res.json({ ok: true, post: { id: post.id, c, w, x, a: name, t: post.t } });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });
}


/* =====================================================================
 * 007 사기 경보
 *  GET    /api/scam                 → 경보 목록 (최신순)
 *  POST   /api/scam/me              → { accessToken } 관리자인지 확인
 *  POST   /api/scam                 → { accessToken, level, title, body } 경보 올리기 (관리자만)
 *  POST   /api/scam/:id/remove      → { accessToken } 경보 지우기 (관리자만)
 * 관리자: Vercel 환경변수 COSMOS_ADMIN, 없으면 minkyeungsoon
 * 저장: Vercel Blob 'dibutades-scam.json'
 * ===================================================================== */
const SCAM_BLOB = 'dibutades-scam.json';
const SCAM_LEVELS = ['위험', '주의', '참고'];
function scamIsAdmin(name){
  const admin = String(process.env.COSMOS_ADMIN || 'minkyeungsoon').trim().toLowerCase();
  return !!name && name.toLowerCase() === admin;
}
async function scamLoad(){
  try{
    const { get } = require('@vercel/blob');
    const res = await get(SCAM_BLOB, { access: 'private' });
    const d = JSON.parse(await new Response(res.stream).text());
    d.items = Array.isArray(d.items) ? d.items : [];
    return d;
  }catch(e){
    if(!(e && (e.name === 'BlobNotFoundError' || /not.*found/i.test(e.message || '')))) console.error('scam load error:', e && e.message);
    return { items: [] };
  }
}
async function scamSave(d){
  const { put } = require('@vercel/blob');
  d.items = d.items.slice(-200);
  await put(SCAM_BLOB, JSON.stringify(d), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
}
function mountScam(app){
  app.get('/api/scam', async (req, res) => {
    try{
      const d = await scamLoad();
      res.set('Cache-Control', 'no-store');
      res.json({ items: d.items.slice().reverse() });
    }catch(e){ res.status(500).json({ error: 'scam_unavailable' }); }
  });
  app.post('/api/scam/me', async (req, res) => {
    const name = await mealVerify((req.body || {}).accessToken);
    if(!name) return res.status(401).json({ error: 'login required' });
    res.json({ admin: scamIsAdmin(name) });
  });
  app.post('/api/scam', async (req, res) => {
    const { accessToken, level, title, body } = req.body || {};
    const name = await mealVerify(accessToken);
    if(!name) return res.status(401).json({ error: 'login required', message: '로그인이 만료되었어요. 다시 로그인해주세요.' });
    if(!scamIsAdmin(name)) return res.status(403).json({ error: 'forbidden', message: '관리자만 올릴 수 있어요.' });
    const lv = SCAM_LEVELS.includes(level) ? level : '주의';
    const t = String(title || '').trim().slice(0, 80);
    const b = String(body || '').trim().slice(0, 1200);
    if(!t) return res.status(400).json({ error: 'bad_title', message: '제목을 적어 주세요.' });
    try{
      const d = await scamLoad();
      const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), level: lv, title: t, body: b, t: Date.now() };
      d.items.push(item);
      await scamSave(d);
      res.json({ ok: true, item });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });
  app.post('/api/scam/:id/remove', async (req, res) => {
    const name = await mealVerify((req.body || {}).accessToken);
    if(!name) return res.status(401).json({ error: 'login required' });
    if(!scamIsAdmin(name)) return res.status(403).json({ error: 'forbidden' });
    try{
      const d = await scamLoad();
      const before = d.items.length;
      d.items = d.items.filter(x => x.id !== req.params.id);
      await scamSave(d);
      res.json({ ok: true, removed: before - d.items.length });
    }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
  });
}


/* =====================================================================
 * 오늘의 007 퀴즈 · 이건 사기일까?
 *  GET  /api/quiz          → 오늘의 문제 (정답은 빼고) + 오늘 맞힌 비율
 *  POST /api/quiz/answer   → { choice:'scam'|'safe', visitorId } → 정답·설명·비율
 *  문제는 아래 QUIZ 목록을 한국시간 날짜에 맞춰 하루 한 문제씩 차례로 돌립니다.
 *  새 문제를 넣고 싶으면 QUIZ 목록 맨 끝에 같은 모양으로 한 줄 더 붙이면 됩니다.
 *  (a: 'scam' = 사기다, 'safe' = 괜찮다)
 * ===================================================================== */
const QUIZ = [
 {
  "a": "scam",
  "q": "X에서 \"Pi Network 공식 지원팀\"이라는 계정이 DM을 보냈어요. \"지갑에 이상 거래가 감지됐어요. 잠금 해제를 위해 24단어 패스프레이즈를 입력해 주세요.\"",
  "qEn": "A \"Pi Network Support\" account DMs you: \"Suspicious activity detected. Enter your 24-word passphrase to unlock your wallet.\"",
  "x": "패스프레이즈는 지갑의 열쇠 그 자체예요. Pi 팀은 DM으로 먼저 연락하지 않고, 패스프레이즈를 절대 묻지 않아요.",
  "xEn": "Your passphrase is the key to your wallet. The Pi team never DMs first and never asks for it."
 },
 {
  "a": "scam",
  "q": "텔레그램 단체방에 글이 올라왔어요. \"서밋 기념 이벤트! 지금 10 Pi를 보내면 24시간 안에 20 Pi로 돌려드립니다. 선착순 100명!\"",
  "qEn": "\"Summit event! Send 10 Pi now and get 20 Pi back within 24 hours. First 100 only!\"",
  "x": "\"보내면 두 배로\"는 가장 오래되고 흔한 사기예요. \"선착순\"과 \"24시간\"은 생각할 틈을 주지 않으려는 장치예요.",
  "xEn": "\"Send and get double back\" is the oldest trick. Time limits are there to stop you from thinking."
 },
 {
  "a": "safe",
  "q": "Pi Browser에서 처음 연 앱의 로그인 버튼을 누르자, Pi 화면이 \"이 앱에 사용자 이름을 공유할까요?\"라고 물어요. 패스프레이즈를 적는 칸은 없어요.",
  "qEn": "A Pi app's login shows the Pi screen: \"Share your username with this app?\" No passphrase field.",
  "x": "Pi 공식 로그인의 정상적인 모습이에요. 앱은 내가 허락한 사용자 이름만 받아요. 로그인 화면에 패스프레이즈 칸이 있다면 그건 가짜예요.",
  "xEn": "This is the normal official Pi login. If a login screen asks for your passphrase, it is fake."
 },
 {
  "a": "scam",
  "q": "\"KYC가 너무 오래 걸리시죠? 수수료 5 Pi만 내시면 저희가 하루 만에 통과시켜 드립니다.\"라는 광고를 봤어요.",
  "qEn": "\"KYC taking too long? Pay just 5 Pi and we will get you approved in one day.\"",
  "x": "KYC를 대신 빨리 통과시켜 주는 곳은 없어요. KYC는 Pi 앱이 안내하는 공식 절차로만 진행돼요.",
  "xEn": "No one can speed up your KYC for a fee. KYC only goes through the official process in the Pi app."
 },
 {
  "a": "scam",
  "q": "\"메인넷 마이그레이션 대행 서비스! 패스프레이즈만 알려 주시면 남은 파이를 바로 옮겨 드려요.\"",
  "qEn": "\"Mainnet migration service! Just give us your passphrase and we will move your remaining Pi right away.\"",
  "x": "마이그레이션은 Pi 앱의 메인넷 체크리스트로만 진행돼요. 패스프레이즈를 넘기는 순간 파이는 그 사람 것이 돼요.",
  "xEn": "Migration only happens through the Mainnet checklist in the Pi app. Hand over your passphrase and your Pi becomes theirs."
 },
 {
  "a": "scam",
  "q": "\"Pi 에어드롭 당첨! 지금 이 사이트에 접속해 지갑을 연결하고 패스프레이즈로 본인 확인을 해 주세요.\"",
  "qEn": "\"You won a Pi airdrop! Visit this site, connect your wallet and verify with your passphrase.\"",
  "x": "에어드롭을 받으려고 패스프레이즈를 입력하는 일은 없어요. \"당첨\"이라는 말로 서두르게 만드는 전형적인 낚시예요.",
  "xEn": "No real airdrop needs your passphrase. \"You won\" is classic bait."
 },
 {
  "a": "safe",
  "q": "Pi 앱 결제를 누르자 Pi 지갑 화면에 앱 이름과 금액이 나오고, 내가 \"승인\"을 눌러야만 결제가 돼요.",
  "qEn": "Paying in a Pi app opens the Pi wallet showing the app name and amount; it only goes through if you tap approve.",
  "x": "정상적인 Pi 결제 모습이에요. 승인 전에 앱 이름과 금액을 꼭 확인하고, 이상하면 취소하면 돼요.",
  "xEn": "This is a normal Pi payment. Check the app name and amount, and cancel if anything looks off."
 },
 {
  "a": "scam",
  "q": "메신저로 \"Pi Browser 프로 버전\"이라는 파일(apk)을 받았어요. \"채굴 속도가 2배\"라며 설치하래요.",
  "qEn": "You get a \"Pi Browser Pro\" apk file by message, promising \"double mining speed\".",
  "x": "Pi 앱과 Pi Browser는 공식 앱 스토어에서만 받아야 해요. 출처 모를 설치 파일은 지갑 정보를 훔쳐 갈 수 있어요.",
  "xEn": "Only install Pi apps from the official app stores. Unknown installers can steal your wallet."
 },
 {
  "a": "scam",
  "q": "니콜라스 코칼리스라고 소개한 계정이 DM으로 \"특별히 선택된 파이오니어에게만 드리는 기회\"라며 연락했어요.",
  "qEn": "An account claiming to be Nicolas Kokkalis DMs you about \"a special chance for selected pioneers\".",
  "x": "창립자는 개인 DM으로 파이오니어에게 기회를 제안하지 않아요. 창립자 이름을 빌린 사칭은 아주 흔해요.",
  "xEn": "The founders do not offer private deals by DM. Impersonating them is very common."
 },
 {
  "a": "scam",
  "q": "\"파이를 1개당 314,159달러에 사 드립니다. 먼저 활성화 수수료 100달러만 보내 주세요.\"",
  "qEn": "\"We buy Pi at $314,159 each. Just send a $100 activation fee first.\"",
  "x": "터무니없이 비싼 값에 사 준다며 먼저 돈을 받는 건 선입금 사기예요. 수수료를 보내면 연락이 끊겨요.",
  "xEn": "An unrealistic price plus an upfront fee is advance-fee fraud. Pay and they vanish."
 },
 {
  "a": "safe",
  "q": "친구가 Pi에 가입할 때 내 사용자 이름을 초대 코드로 넣었어요.",
  "qEn": "A friend used your username as the invitation code when joining Pi.",
  "x": "초대 코드는 사용자 이름일 뿐이라 알려 줘도 괜찮아요. 패스프레이즈와는 전혀 달라요.",
  "xEn": "An invitation code is just a username, safe to share. It is nothing like your passphrase."
 },
 {
  "a": "scam",
  "q": "\"파이 투자 리딩방! 매달 30% 수익 보장, 원금도 보장해 드립니다.\"",
  "qEn": "\"Pi investment group! 30% guaranteed every month, principal guaranteed.\"",
  "x": "수익과 원금을 \"보장\"한다는 말 자체가 경고 신호예요. 진짜 투자에는 보장이 없어요.",
  "xEn": "\"Guaranteed returns\" is itself the warning sign. Real investments guarantee nothing."
 },
 {
  "a": "scam",
  "q": "\"채굴 속도를 3배로 올려 주는 부스터! 월 5 Pi만 내면 됩니다.\"",
  "qEn": "\"A booster that triples your mining rate! Only 5 Pi a month.\"",
  "x": "채굴 속도는 돈을 내서 올릴 수 없어요. 보안 서클, 추천 팀 같은 Pi 앱 안의 공식 방법만 있어요.",
  "xEn": "You cannot buy a faster mining rate. Only official in-app features like Security Circles affect it."
 },
 {
  "a": "scam",
  "q": "\"이 메일에 24시간 안에 답하지 않으면 회원님의 Pi 계정이 삭제됩니다. 아래 링크에서 본인 확인을 해 주세요.\"",
  "qEn": "\"Reply within 24 hours or your Pi account will be deleted. Verify through the link below.\"",
  "x": "겁을 주고 시간을 재촉하는 메일은 낚시예요. 계정 관련 안내는 Pi 앱 안에서 직접 확인하세요.",
  "xEn": "Threats with a deadline are phishing. Check account notices inside the Pi app itself."
 },
 {
  "a": "safe",
  "q": "실제로 알고 믿을 수 있는 가족과 친구 몇 명을 Pi 앱의 보안 서클에 넣었어요.",
  "qEn": "You added a few family members and friends you truly trust to your Security Circle in the Pi app.",
  "x": "보안 서클의 원래 쓰임새예요. 모르는 사람이 아니라 실제로 아는 사람을 넣는 게 맞아요.",
  "xEn": "That is exactly what Security Circles are for: people you really know."
 },
 {
  "a": "scam",
  "q": "\"KYC 서류는 이 웹사이트에 올려 주세요. 신분증 앞뒷면과 셀카가 필요합니다.\"라는 링크를 받았어요.",
  "qEn": "You get a link: \"Upload your KYC documents here — both sides of your ID and a selfie.\"",
  "x": "KYC는 Pi 앱이 연결해 주는 공식 KYC 앱 안에서만 해요. 외부 사이트에 신분증을 올리면 신분 도용에 쓰일 수 있어요.",
  "xEn": "KYC is only done in the official KYC app opened from Pi. Uploading your ID elsewhere risks identity theft."
 },
 {
  "a": "scam",
  "q": "온라인에서 알게 된 친구가 몇 주째 다정하게 대화하더니, \"급한 일이 생겼다\"며 파이를 조금 보내 달래요.",
  "qEn": "An online friend you have chatted with for weeks suddenly asks you to send some Pi for \"an emergency\".",
  "x": "오랜 시간 신뢰를 쌓은 뒤 돈을 요구하는 건 로맨스·친분 사기의 전형이에요. 한 번 보낸 파이는 되돌릴 수 없어요.",
  "xEn": "Building trust then asking for money is a classic romance scam. Sent Pi cannot be recovered."
 },
 {
  "a": "scam",
  "q": "\"재택 알바! 월급은 파이로 드립니다. 시작하려면 보증금 20 Pi를 먼저 보내 주세요.\"",
  "qEn": "\"Work from home, paid in Pi! Send a 20 Pi deposit to get started.\"",
  "x": "일을 시작하기 전에 보증금을 요구하는 일자리는 사기예요.",
  "xEn": "A job that asks you to pay a deposit first is a scam."
 },
 {
  "a": "safe",
  "q": "Pi 앱을 열고 하루에 한 번 채굴 버튼을 눌렀어요. 돈은 내지 않았어요.",
  "qEn": "You opened the Pi app and tapped the mining button once for the day. No payment involved.",
  "x": "Pi 채굴의 정상적인 방법이에요. 채굴은 무료예요.",
  "xEn": "That is the normal way to mine Pi. Mining is free."
 },
 {
  "a": "scam",
  "q": "\"Pi 거래소 상장 전 프리세일! 지금 사면 상장 후 10배!\"라며 다른 코인으로 파이를 사라고 해요.",
  "qEn": "\"Pi pre-sale before the exchange listing! Buy now with other coins and get 10x after listing!\"",
  "x": "\"상장 전 프리세일\"과 \"몇 배 보장\"은 가짜 판매의 대표적인 문구예요.",
  "xEn": "\"Pre-sale before listing\" and \"guaranteed 10x\" are hallmarks of fake sales."
 },
 {
  "a": "scam",
  "q": "\"패스프레이즈를 잃어버리셨나요? 저희가 지갑을 복구해 드립니다. 남아 있는 단어를 알려 주세요.\"",
  "qEn": "\"Lost your passphrase? We can recover your wallet. Tell us the words you remember.\"",
  "x": "복구 업체를 사칭해 남은 단어를 받아 내는 수법이에요. 단어 몇 개만 알려 줘도 위험해요.",
  "xEn": "Fake \"recovery services\" collect your remaining words. Even a few words are dangerous."
 },
 {
  "a": "scam",
  "q": "상담원이 \"문제를 해결해 드릴게요\"라며 화면 공유를 켜고 Pi 지갑을 열어 보라고 해요.",
  "qEn": "A \"support agent\" asks you to share your screen and open your Pi wallet so they can \"fix the problem\".",
  "x": "화면 공유 중에 지갑을 열면 패스프레이즈와 잔액이 그대로 보여요. 진짜 지원팀은 이런 요청을 하지 않아요.",
  "xEn": "Opening your wallet while sharing your screen exposes everything. Real support never asks this."
 },
 {
  "a": "safe",
  "q": "Pi 노드 프로그램을 Pi Network 공식 사이트(minepi.com)에서 내려받았어요.",
  "qEn": "You downloaded the Pi Node software from the official site, minepi.com.",
  "x": "노드는 공식 사이트에서 받는 게 맞아요. 다른 곳에서 받은 노드 파일은 피하세요.",
  "xEn": "The official site is the right place. Avoid node files from anywhere else."
 },
 {
  "a": "scam",
  "q": "\"지갑이 정상인지 확인하려면 테스트로 1 Pi만 이 주소로 보내 주세요. 바로 돌려드려요.\"",
  "qEn": "\"To check your wallet works, send 1 Pi to this address as a test. We will send it right back.\"",
  "x": "\"테스트 송금\"은 돌려받지 못해요. 1 Pi로 시작해서 점점 더 큰 금액을 요구하기도 해요.",
  "xEn": "\"Test transfers\" never come back, and they often lead to bigger requests."
 },
 {
  "a": "scam",
  "q": "텔레그램에 \"Pi 공식 고객센터\"라는 방이 있어요. 관리자가 개인 메시지로 문제를 도와주겠다고 해요.",
  "qEn": "A Telegram group called \"Pi Official Help Desk\"; an admin offers to help you by private message.",
  "x": "관리자를 사칭해 먼저 개인 메시지를 보내는 건 흔한 수법이에요. 공식 도움은 Pi 앱 안에서 받으세요.",
  "xEn": "Fake admins messaging you first is a common trick. Get help inside the Pi app."
 },
 {
  "a": "scam",
  "q": "\"리트윗하고 지갑을 연결하면 100 Pi 무료 증정!\" 링크를 누르니 패스프레이즈 입력 창이 나와요.",
  "qEn": "\"Retweet and connect your wallet for 100 free Pi!\" The link asks for your passphrase.",
  "x": "무료라면서 패스프레이즈를 묻는 순간 사기예요. 그 창은 지갑을 훔치려는 가짜 화면이에요.",
  "xEn": "\"Free\" plus a passphrase prompt equals theft."
 },
 {
  "a": "safe",
  "q": "Pi 앱이 안내하는 KYC 메뉴로 들어가 공식 KYC 앱에서 신청했어요. 신청비는 내지 않았어요.",
  "qEn": "You applied for KYC through the menu in the Pi app, using the official KYC app, without paying anything.",
  "x": "공식 KYC 절차예요. Pi 앱 안에서 연결되는 공식 경로로만 신청하세요.",
  "xEn": "That is the official KYC process. Only use the path the Pi app gives you."
 },
 {
  "a": "scam",
  "q": "어떤 앱 화면 안에 \"보너스를 받으려면 여기에 패스프레이즈를 입력하세요\"라는 칸이 있어요.",
  "qEn": "An app shows a box: \"Enter your passphrase here to claim your bonus.\"",
  "x": "정상적인 앱은 패스프레이즈를 입력하라고 하지 않아요. 결제는 Pi 지갑의 승인 화면에서만 이뤄져요.",
  "xEn": "Legit apps never ask for your passphrase. Payments only happen on the Pi wallet approval screen."
 },
 {
  "a": "scam",
  "q": "\"Pi 체크카드 사전 예약! 예약금 10 Pi를 내면 출시 즉시 1순위로 받습니다.\"",
  "qEn": "\"Pi debit card pre-order! Pay 10 Pi to get it first at launch.\"",
  "x": "공식 발표에 없는 상품을 미리 돈 받고 파는 건 사기예요. 새 기능은 Pi 공식 채널에서 먼저 확인하세요.",
  "xEn": "Selling products that were never officially announced is a scam. Check official Pi channels first."
 },
 {
  "a": "scam",
  "q": "\"해커톤 상금에 당첨되셨어요! 상금을 받으려면 송금 수수료 15 Pi를 먼저 보내 주세요.\"",
  "qEn": "\"You won a hackathon prize! Send a 15 Pi transfer fee first to receive it.\"",
  "x": "상금을 주기 전에 수수료를 내라는 건 선입금 사기예요.",
  "xEn": "Paying a fee before receiving a prize is advance-fee fraud."
 },
 {
  "a": "safe",
  "q": "24단어 패스프레이즈를 종이에 적어 집 안 안전한 곳에 보관했어요. 사진은 찍지 않았어요.",
  "qEn": "You wrote your 24-word passphrase on paper and keep it somewhere safe at home. No photos.",
  "x": "아주 좋은 습관이에요. 사진·메모 앱·클라우드에 두면 해킹으로 새어 나갈 수 있어요.",
  "xEn": "Great habit. Photos, notes apps and clouds can leak in a hack."
 },
 {
  "a": "scam",
  "q": "\"Pi 행사 VIP 입장권 판매! 창립자와 화상으로 직접 만날 수 있어요. 50 Pi\"",
  "qEn": "\"Pi event VIP pass! Meet the founders on a video call. 50 Pi.\"",
  "x": "공식 발표에 없는 입장권이나 만남을 파는 건 사기예요. 가짜 입장권은 큰 행사 때마다 나타나요. 행사 소식은 Pi 공식 채널에서 확인하세요.",
  "xEn": "Passes or meetings not in official announcements are scams, and they pop up at every big event. Check official Pi channels."
 },
 {
  "a": "scam",
  "q": "\"Pi Network 한국 공식 모임\" 운영자가 \"회원 등급을 올리려면 30 Pi를 예치하라\"고 해요.",
  "qEn": "The leader of a \"Pi Network Korea official group\" asks you to deposit 30 Pi to raise your member level.",
  "x": "공식 이름을 붙인 모임이 예치금을 받는 건 위험 신호예요. Pi에는 돈을 내고 올리는 회원 등급이 없어요.",
  "xEn": "A group using an official-sounding name and asking for deposits is a red flag. Pi has no paid member levels."
 },
 {
  "a": "scam",
  "q": "\"채굴이 더 잘되는 Pi Mining 2.0 앱!\"이라는 광고로 비슷한 이름의 다른 앱을 깔라고 해요.",
  "qEn": "An ad pushes \"Pi Mining 2.0 — mines better!\", a look-alike app.",
  "x": "이름과 로고를 흉내 낸 가짜 앱이에요. 채굴은 공식 Pi 앱에서만 할 수 있어요.",
  "xEn": "It is a copycat app. Mining only happens in the official Pi app."
 },
 {
  "a": "safe",
  "q": "친구에게 파이를 받으려고 G로 시작하는 내 지갑 주소(공개 주소)만 알려 줬어요.",
  "qEn": "To receive Pi from a friend, you shared only your wallet address starting with G.",
  "x": "지갑 주소는 받는 데 쓰는 공개 정보라 알려 줘도 괜찮아요. 패스프레이즈만은 절대 안 돼요.",
  "xEn": "Your public address is meant for receiving. Just never share the passphrase."
 },
 {
  "a": "scam",
  "q": "누군가 \"계정을 확인하려고 문자로 보낸 인증번호를 알려 달라\"고 해요.",
  "qEn": "Someone asks you to tell them the verification code just sent to you by SMS.",
  "x": "인증번호를 넘기면 내 계정을 그 사람이 가져갈 수 있어요. 인증번호는 누구에게도 알려 주지 마세요.",
  "xEn": "Sharing that code lets them take over your account. Never share it."
 },
 {
  "a": "scam",
  "q": "\"신분증을 빌려주시면 다른 사람 KYC에 쓰고 1건당 5 Pi를 드려요.\"",
  "qEn": "\"Lend us your ID for other people's KYC and earn 5 Pi each time.\"",
  "x": "내 신분을 남의 계정에 쓰게 하는 건 사기이자 불법이에요. 내 계정도 위험해질 수 있어요.",
  "xEn": "Letting others use your identity is fraud and illegal, and it puts your own account at risk."
 },
 {
  "a": "scam",
  "q": "\"Pi 스테이킹 디앱! 맡기기만 하면 매일 3% 이자가 붙어요.\"",
  "qEn": "\"Pi staking dApp! Just deposit and earn 3% interest every day.\"",
  "x": "하루 3%면 1년에 수천 % 수익이라는 뜻이에요. 비현실적인 이자는 폰지 사기의 신호예요.",
  "xEn": "3% a day means thousands of percent a year. Unrealistic interest signals a Ponzi scheme."
 },
 {
  "a": "safe",
  "q": "메인넷 이전을 Pi 앱의 메인넷 체크리스트를 따라 하나씩 진행했어요.",
  "qEn": "You moved to Mainnet by following the Mainnet checklist in the Pi app step by step.",
  "x": "공식 방법이에요. 대행이나 외부 사이트 없이 체크리스트만 따라가면 돼요.",
  "xEn": "That is the official way. No agents or outside sites needed."
 },
 {
  "a": "scam",
  "q": "\"잠긴(락업) 파이를 지금 바로 풀어 드립니다. 해제 수수료 20%.\"",
  "qEn": "\"We can unlock your locked-up Pi right now. 20% unlock fee.\"",
  "x": "락업 기간은 내가 선택한 설정대로 지켜져요. 남이 수수료를 받고 풀어 줄 수 없어요.",
  "xEn": "Lockups follow the settings you chose. No one can release them for a fee."
 },
 {
  "a": "scam",
  "q": "\"노드 보상 2배 프로그램! 노드 운영자 전용, 가입비 10 Pi.\"",
  "qEn": "\"Double node rewards program! Node operators only, 10 Pi to join.\"",
  "x": "노드 보상은 공식 노드 소프트웨어와 규칙으로만 정해져요. 돈 내고 늘리는 프로그램은 없어요.",
  "xEn": "Node rewards come only from the official node software and rules. There is no paid boost."
 },
 {
  "a": "scam",
  "q": "YouTube 라이브에 창립자 얼굴이 나오며 \"지금 이 주소로 보내면 두 배로 돌려드려요\"라는 자막이 떠요.",
  "qEn": "A YouTube live shows a founder's face with a caption: \"Send to this address now and get double back.\"",
  "x": "얼굴과 목소리를 합성한 가짜 방송이 늘고 있어요. 창립자가 송금을 부탁하는 일은 없어요.",
  "xEn": "Deepfake streams are on the rise. Founders never ask you to send them anything."
 },
 {
  "a": "safe",
  "q": "내 거래 내역을 Pi 공식 블록 탐색기에서 지갑 주소로 찾아봤어요.",
  "qEn": "You looked up your transactions on the official Pi block explorer using your wallet address.",
  "x": "블록 탐색기는 누구나 볼 수 있는 공개 기록이에요. 주소만으로 조회하니 안전해요.",
  "xEn": "The block explorer is a public record. Looking up by address is safe."
 },
 {
  "a": "scam",
  "q": "\"어려운 이웃을 돕는 Pi 기부 캠페인\"이라며 지갑 주소만 하나 알려 주고 사연을 보내요. 단체 이름이나 확인할 곳은 없어요.",
  "qEn": "A \"Pi charity drive\" sends a sad story and one wallet address, with no organization or way to verify.",
  "x": "확인할 수 없는 기부 요청은 감정을 이용한 사기일 수 있어요. 보내기 전에 단체를 꼭 확인하세요.",
  "xEn": "Unverifiable charity requests often play on emotions. Check the organization before giving."
 },
 {
  "a": "scam",
  "q": "\"큰 거래소에 오늘 파이가 상장됐어요! 저희에게 팔면 시세보다 20% 더 드려요. 먼저 보내 주세요.\"",
  "qEn": "\"Pi just listed on a big exchange! Sell to us for 20% above market — send first.\"",
  "x": "확인되지 않은 소식에 웃돈까지 얹어 먼저 보내라는 건 사기예요. 소식은 공식 발표로 확인하세요.",
  "xEn": "Unverified news plus a premium plus \"send first\" is a scam. Check official announcements."
 },
 {
  "a": "scam",
  "q": "\"Pi와 1:1로 바꿔 주는 BNB 체인 Pi 토큰이 나왔어요. 지금 사면 나중에 메인넷 Pi로 바꿔 줘요.\"",
  "qEn": "\"A Pi token on BNB chain that converts 1:1 to Mainnet Pi later. Buy now!\"",
  "x": "다른 체인의 \"Pi 토큰\"은 Pi Network와 관계없는 가짜예요. 메인넷 Pi로 바꿔 주지 않아요.",
  "xEn": "\"Pi tokens\" on other chains are unrelated fakes. They do not convert to Mainnet Pi."
 },
 {
  "a": "safe",
  "q": "Pi Browser에서 결제하기 전에 주소창을 보고 내가 원래 쓰던 앱 주소가 맞는지 확인했어요.",
  "qEn": "Before paying in the Pi Browser, you checked the address bar to make sure it is the app you know.",
  "x": "훌륭한 습관이에요. 비슷한 이름의 가짜 앱을 걸러 낼 수 있어요.",
  "xEn": "Great habit. It filters out look-alike fake apps."
 },
 {
  "a": "scam",
  "q": "\"QR 코드를 찍으면 이벤트 보상이 바로 들어와요.\" 찍으니 낯선 사이트가 열리고 지갑 연결을 요구해요.",
  "qEn": "\"Scan this QR code for an instant event reward.\" It opens an unknown site asking to connect your wallet.",
  "x": "QR 코드는 어디로든 연결될 수 있어요. 낯선 사이트에서 지갑을 연결하거나 정보를 입력하지 마세요.",
  "xEn": "A QR code can lead anywhere. Do not connect your wallet on unknown sites."
 },
 {
  "a": "scam",
  "q": "\"보안 서클 자리를 팔아요. 10 Pi만 내면 채굴 속도가 올라가는 서클에 넣어 드려요.\"",
  "qEn": "\"Selling Security Circle spots. Pay 10 Pi and I will add you to boost your mining.\"",
  "x": "보안 서클은 내가 실제로 아는 믿을 만한 사람끼리 맺는 거예요. 자리를 사고파는 건 사기예요.",
  "xEn": "Security Circles are for people you actually know and trust. Buying a spot is a scam."
 },
 {
  "a": "scam",
  "q": "\"KYC가 끝난 Pi 계정을 팝니다. 잔액 5,000 Pi 포함.\"",
  "qEn": "\"Selling a KYC-verified Pi account with 5,000 Pi balance.\"",
  "x": "계정 매매는 Pi 규칙 위반이고, 돈만 받고 넘기지 않거나 나중에 되찾아 가는 경우가 많아요.",
  "xEn": "Account trading breaks Pi rules, and sellers often take the money or reclaim the account."
 },
 {
  "a": "safe",
  "q": "앱을 쓰다가 생각지 않은 결제 승인 창이 떠서 \"취소\"를 눌렀어요.",
  "qEn": "An unexpected payment approval popped up while using an app, so you tapped cancel.",
  "x": "잘하셨어요. 내가 원하지 않은 결제는 언제든 거절할 수 있어요.",
  "xEn": "Well done. You can always refuse a payment you did not intend."
 },
 {
  "a": "scam",
  "q": "\"이전 가능 잔액을 늘려 드려요. 저희에게 연락 주세요.\"라는 댓글이 내 글에 달렸어요.",
  "qEn": "A reply under your post: \"We can increase your transferable balance. Contact us.\"",
  "x": "이전 가능 잔액은 Pi의 공식 절차로만 바뀌어요. 이런 댓글은 연락을 유도하는 미끼예요.",
  "xEn": "Transferable balance only changes through official Pi processes. Such replies are bait."
 },
 {
  "a": "scam",
  "q": "\"파이 가격이 다음 달 100배 오릅니다. 확실한 정보, VIP 방 입장료 20 Pi.\"",
  "qEn": "\"Pi will 100x next month. Inside info — VIP room entry 20 Pi.\"",
  "x": "가격을 \"확실하게\" 아는 사람은 없어요. 확실한 정보를 판다는 것 자체가 사기의 신호예요.",
  "xEn": "No one knows prices for sure. Selling \"certain\" tips is itself the scam."
 },
 {
  "a": "scam",
  "q": "\"Pi 앱 업데이트 필수! 아래 링크로 새 버전을 받으세요.\" 링크 주소는 처음 보는 사이트예요.",
  "qEn": "\"Mandatory Pi app update! Download the new version from this link.\" The address is unfamiliar.",
  "x": "앱 업데이트는 휴대폰의 공식 앱 스토어에서만 하세요. 낯선 링크의 업데이트는 악성 앱일 수 있어요.",
  "xEn": "Only update through your official app store. \"Updates\" from links can be malware."
 },
 {
  "a": "safe",
  "q": "창립자를 사칭하는 계정을 보고 X의 신고 기능으로 신고했어요.",
  "qEn": "You saw an account impersonating a founder and reported it with X's report feature.",
  "x": "좋은 행동이에요. 신고가 쌓이면 다른 파이오니어의 피해를 막을 수 있어요.",
  "xEn": "Good move. Reports help protect other pioneers."
 },
 {
  "a": "scam",
  "q": "\"메인넷 이전 마감이 오늘이에요! 지금 이 주소로 파이를 보내야 사라지지 않아요.\"",
  "qEn": "\"Migration deadline is today! Send your Pi to this address now or it will be lost.\"",
  "x": "파이를 남의 주소로 보내야 지켜진다는 말은 사기예요. 공식 일정과 절차는 Pi 앱 안에서 확인하세요.",
  "xEn": "No real process needs you to send Pi to someone else. Check official dates in the Pi app."
 },
 {
  "a": "scam",
  "q": "게임 앱에서 \"지금 10 Pi를 걸면 5분 만에 30 Pi가 될 수도 있어요!\" 하며 계속 더 걸라고 해요.",
  "qEn": "A game app urges you: \"Bet 10 Pi now, it could be 30 Pi in 5 minutes!\" and keeps pushing for more.",
  "x": "짧은 시간에 몇 배를 약속하며 계속 더 걸게 만드는 건 도박·사기의 방식이에요.",
  "xEn": "Promising multiples in minutes and pushing for more is how gambling scams work."
 },
 {
  "a": "scam",
  "q": "\"Pi 지갑 주소와 패스프레이즈를 적어 주시면 서밋 기념 NFT를 보내 드려요.\"",
  "qEn": "\"Leave your wallet address and passphrase and we will send you a summit NFT.\"",
  "x": "주소만으로도 무언가를 보낼 수 있어요. 패스프레이즈까지 달라는 건 지갑을 가져가겠다는 뜻이에요.",
  "xEn": "Sending only needs your address. Asking for the passphrase means they want your wallet."
 },
 {
  "a": "safe",
  "q": "새 기능 소식을 듣고, 바로 믿기 전에 Pi 앱 안의 공지와 Pi Network 공식 계정에서 먼저 확인했어요.",
  "qEn": "Hearing about a new feature, you checked the in-app news and the official Pi Network account before believing it.",
  "x": "가장 확실한 습관이에요. 공식 채널에 없는 소식은 일단 의심해 보세요.",
  "xEn": "The surest habit. Be wary of news that is not on official channels."
 },
 {
  "a": "safe",
  "q": "Pi 생태계 앱에 로그인할 때 Pi 화면이 \"결제 권한도 함께 허락할까요?\"라고 물어요. 실제 결제는 매번 따로 승인 창이 떠요.",
  "qEn": "When logging into a Pi app, the Pi screen asks to allow payments too; each actual payment still needs its own approval.",
  "x": "정상이에요. 결제 권한은 앱이 결제를 \"요청\"할 수 있게 해 줄 뿐이고, 돈은 내가 매번 승인해야만 나가요.",
  "xEn": "Normal. The permission only lets the app request payments; money moves only when you approve each one."
 }
];
const QUIZ_BLOB = 'dibutades-quiz.json';
function quizToday(){
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const date = kst.toISOString().slice(0, 10);
  const dayNo = Math.floor(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) / 86400000);
  const QUIZ_START = 20767; // 2026-11-10 = 1번 문제
  const idx = (((dayNo - QUIZ_START) % QUIZ.length) + QUIZ.length) % QUIZ.length;
  return { date, idx, item: QUIZ[idx] };
}
async function quizLoad(date){
  try{
    const { get } = require('@vercel/blob');
    const res = await get(QUIZ_BLOB, { access: 'private' });
    const d = JSON.parse(await new Response(res.stream).text());
    if(d && d.date === date) return d;
  }catch(e){}
  return { date, total: 0, right: 0, voters: {} };
}
async function quizSave(d){
  const { put } = require('@vercel/blob');
  await put(QUIZ_BLOB, JSON.stringify(d), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
}
function quizStats(d){ return { total: d.total || 0, right: d.right || 0 }; }
function mountQuiz(app){
  app.get('/api/quiz', async (req, res) => {
    const { date, idx, item } = quizToday();
    const d = await quizLoad(date);
    res.json({ date, no: idx + 1, count: QUIZ.length, q: item.q, qEn: item.qEn, stats: quizStats(d) });
  });
  app.post('/api/quiz/answer', async (req, res) => {
    const { choice, visitorId } = req.body || {};
    if(choice !== 'scam' && choice !== 'safe') return res.status(400).json({ error: 'bad_choice' });
    const { date, item } = quizToday();
    const correct = choice === item.a;
    let d = await quizLoad(date);
    const vid = String(visitorId || '').slice(0, 64);
    try{
      if(vid && !d.voters[vid] && Object.keys(d.voters).length < 20000){
        d.voters[vid] = 1; d.total = (d.total || 0) + 1; if(correct) d.right = (d.right || 0) + 1;
        await quizSave(d);
      }
    }catch(e){ console.error('quiz save', e && e.message); }
    res.json({ date, correct, a: item.a, x: item.x, xEn: item.xEn, stats: quizStats(d) });
  });
}

module.exports = function mountNews(app){
  mountQuiz(app);
  mountMeal(app);
  mountScam(app);
  app.get('/api/news', async (req, res) => {
    const topic = String(req.query.topic || 'pi');
    const fn = { pi: piTopic, crypto: cryptoTopic, history: historyTopic }[topic];
    if(!fn) return res.status(400).json({ error: 'unknown_topic' });
    try{
      const key = topic === 'history' ? 'history:' + JSON.stringify(kstMonthDay()) : topic;
      const data = await cached(key, fn);
      res.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200');
      res.json(Object.assign({ fetchedAt: (cache.get(key) || {}).at || Date.now() }, data));
    }catch(e){
      res.status(502).json({ error: 'news_unavailable', message: '소식을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
  });
};
