/**
 * 디부타데스 · 오늘의 소식 (파이 / 암호화폐 / 역사 속 오늘) — 서버 부분
 * -----------------------------------------------------------
 * 브라우저에서 바로 부르기 어려운 뉴스·역사 자료를 서버가 대신 가져와
 * 15분 동안 보관(캐시)했다가 앱에 넘겨 줍니다. 추가 설치할 패키지는 없습니다.
 *
 *  GET /api/news?topic=pi       → 파이 시세 + 파이 관련 최근 뉴스
 *  GET /api/news?topic=crypto   → 거래량 TOP 5 + 암호화폐 최근 뉴스
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

module.exports = function mountNews(app){
  mountMeal(app);
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
