/**
 * 디부타데스 · 오늘의 소식 (파이 / 암호화폐 / 역사 속 오늘) — 서버 부분
 * -----------------------------------------------------------
 * 브라우저에서 바로 부르기 어려운 뉴스·역사 자료를 서버가 대신 가져와
 * 15분 동안 보관(캐시)했다가 앱에 넘겨 줍니다. 추가 설치할 패키지는 없습니다.
 *
 *  GET /api/news?topic=pi       → 파이 시세 + 파이 관련 최근 뉴스
 *  GET /api/news?topic=crypto   → 거래량 TOP 5 + 암호화폐 최근 뉴스
 *  GET /api/news?topic=history  → 역사 속 오늘 (한국시간 기준 날짜)
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
async function googleNews(query, maxAgeDays, limit){
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=ko&gl=KR&ceid=KR:ko';
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
  const [price, news] = await Promise.all([
    getJson('https://api.coingecko.com/api/v3/simple/price?ids=pi-network&vs_currencies=usd,krw&include_24hr_change=true&include_24hr_vol=true')
      .then(d => d['pi-network'] || null).catch(() => null),
    googleNews('파이코인 OR 파이네트워크 OR "Pi Network"', 7, 5).catch(() => [])
  ]);
  return {
    topic: 'pi',
    price: price ? { usd: price.usd, krw: price.krw, change24h: price.usd_24h_change, vol24h: price.usd_24h_vol } : null,
    news
  };
}

async function cryptoTopic(){
  const [markets, news] = await Promise.all([
    getJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=5&page=1&price_change_percentage=24h')
      .catch(() => []),
    googleNews('암호화폐 OR 비트코인 OR 가상자산', 3, 5).catch(() => [])
  ]);
  return {
    topic: 'crypto',
    top5: (Array.isArray(markets) ? markets : []).slice(0, 5).map(m => ({
      name: m.name, symbol: String(m.symbol || '').toUpperCase(), price: m.current_price,
      vol24h: m.total_volume, change24h: m.price_change_percentage_24h, image: m.image
    })),
    news
  };
}

function kstMonthDay(){
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
async function historyTopic(){
  const { m, d } = kstMonthDay();
  const mm = String(m).padStart(2, '0'), dd = String(d).padStart(2, '0');
  const pick = (data, lang) => ((data && (data.selected || data.events)) || []).map(e => ({
    year: e.year,
    text: e.text,
    link: e.pages && e.pages[0] && e.pages[0].content_urls && e.pages[0].content_urls.mobile ? e.pages[0].content_urls.mobile.page : null,
    lang
  })).filter(e => e.year && e.text);
  let events = [];
  // 한국어 자료가 있으면 한국어로, 없으면 영어로
  try{ events = pick(await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/ko/onthisday/selected/${mm}/${dd}`), 'ko'); }catch(e){}
  if(events.length < 3){
    try{ events = pick(await getJson(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/${mm}/${dd}`), 'en'); }catch(e){}
  }
  events.sort((a, b) => b.year - a.year);
  return { topic: 'history', month: m, day: d, events: events.slice(0, 6) };
}

module.exports = function mountNews(app){
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
