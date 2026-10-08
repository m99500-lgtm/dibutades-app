/**
 * 디부타데스 (Pi Dibutades) - 백엔드 서버
 * -----------------------------------------------------------
 * 데이터 저장을 로컬 JSON 파일(data.json) 대신 Vercel Blob으로 변경한 버전입니다.
 * Vercel 서버리스 환경은 파일시스템이 읽기 전용이라 fs.writeFileSync가
 * EROFS 에러를 냈기 때문에, 대신 Vercel Blob(클라우드 저장소)에 읽고 씁니다.
 *
 * 결제 흐름은 Pi Platform 공식 문서의 U2A(User-To-App) 결제 절차를 따릅니다:
 *  1) 프론트에서 Pi.createPayment() 호출
 *  2) onReadyForServerApproval → 서버가 /v2/payments/{id}/approve 호출
 *  3) 사용자가 Pi Browser에서 결제 확인
 *  4) onReadyForServerCompletion → 서버가 /v2/payments/{id}/complete 호출 (txid 포함)
 *
 * 참고: 앱 홍보 마켓은 "개발자가 다른 개발자에게 직접 Pi를 지불하고 홍보 슬롯을 사는" 구조로
 * 표준 U2A 결제만 사용합니다. 이와 별개로 Pi 공식 광고(Pi Ad Network)를 연동했습니다:
 *  - 전면 광고(interstitial): 프론트에서만 처리
 *  - 보상형 광고(rewarded): 프론트가 받은 adId를 /api/ads/rewarded/verify 로 보내면
 *    서버가 Pi Platform API(/v2/ads_network/status/{adId})로 확인 후 'granted'일 때만 보상 지급
 */

const express = require('express');
const path = require('path');
const { put, get } = require('@vercel/blob');
const crypto = require('crypto');

const app = express();
app.get('/validation-key.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.status(200).send('e98f7ad5c60b5908de11f1ed');
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const PI_API_KEY = process.env.PI_API_KEY; // Pi Developer Portal에서 발급받은 서버 API 키
const PI_API_BASE = 'https://api.minepi.com/v2';

// Vercel Blob에 저장할 파일 이름
const DATA_BLOB_NAME = 'dibutades-data.json';

// ---------- 오늘의 질문 (매일 자정 자동 로테이션) ----------
// 목록을 자유롭게 추가/수정/순서 변경해도 됩니다. 40개가 다 돌면 처음부터 반복됩니다.
const QUESTIONS = [
  { ko: '오늘 하루 중 제일 웃겼던 순간은?', en: 'What made you laugh the most today?' },
  { ko: '요즘 가장 듣고 싶은 말은?', en: 'What words do you want to hear these days?' },
  { ko: '오늘 나에게 칭찬 한마디 해준다면?', en: 'Give yourself one compliment for today.' },
  { ko: '지금 가장 먹고 싶은 음식은?', en: 'What food are you craving right now?' },
  { ko: '요즘 스트레스 풀리는 나만의 방법은?', en: 'How do you relieve stress these days?' },
  { ko: '올해가 가기 전에 꼭 해보고 싶은 일은?', en: 'What do you want to do before this year ends?' },
  { ko: '오늘 아침에 제일 먼저 한 생각은?', en: 'What was the first thing you thought this morning?' },
  { ko: '최근에 새로 알게 된 재미있는 사실은?', en: 'What interesting fact did you learn recently?' },
  { ko: '지금 이 순간 가장 그리운 것은?', en: 'What do you miss the most right now?' },
  { ko: '나를 한 단어로 표현한다면?', en: 'Describe yourself in one word.' },
  { ko: '오늘 하루를 색깔로 표현한다면?', en: 'If today were a color, what would it be?' },
  { ko: '최근에 본 것 중 가장 인상 깊었던 장면은?', en: 'What is the most memorable thing you saw recently?' },
  { ko: '지금 창밖 날씨는 어떤가요?', en: 'What is the weather like outside right now?' },
  { ko: '요즘 자꾸 흥얼거리게 되는 노래가 있나요?', en: 'Is there a song stuck in your head lately?' },
  { ko: '오늘 처음 만난 사람에게 하고 싶은 한마디는?', en: 'What would you say to someone you just met today?' },
  { ko: '지금 가장 갖고 싶은 초능력은?', en: 'What superpower do you want most right now?' },
  { ko: '요즘 나를 웃게 하는 사람은 누구인가요?', en: 'Who makes you smile these days?' },
  { ko: '오늘 하루, 몇 점짜리 하루였나요? (10점 만점)', en: 'How would you rate today out of 10?' },
  { ko: '지금 이 순간 가장 감사한 것은?', en: 'What are you most grateful for right now?' },
  { ko: '요즘 자주 꾸는 꿈이 있나요?', en: 'Do you have a recurring dream lately?' },
  { ko: '나에게 위로가 되는 문장 하나를 남겨주세요.', en: 'Leave a sentence that comforts you.' },
  { ko: '오늘 처음 보는 사람에게 디부타데스를 소개한다면?', en: 'How would you introduce this wall to a stranger?' },
  { ko: '지금 손에 잡히는 물건 하나로 삼행시를 지어보세요.', en: 'Make a short poem using the nearest object to you.' },
  { ko: '요즘 미루고 있는 일이 있나요?', en: 'Is there something you keep putting off?' },
  { ko: '오늘 하루를 한 문장으로 요약한다면?', en: 'Summarize today in one sentence.' },
  { ko: '지금 이 순간 듣고 있는 소리는?', en: 'What sound do you hear right now?' },
  { ko: '나에게 가장 소중한 물건 하나는?', en: 'What is your most precious possession?' },
  { ko: '요즘 배우고 싶은 게 있나요?', en: 'Is there something you want to learn these days?' },
  { ko: '지금 기분을 이모지 하나로 표현한다면?', en: 'Pick one emoji for your mood right now.' },
  { ko: '오늘 하루 중 가장 평화로웠던 순간은?', en: 'What was the most peaceful moment of your day?' },
  { ko: 'Pi 파이오니어가 된 지 얼마나 되셨나요?', en: 'How long have you been a Pi Pioneer?' },
  { ko: '파이오니어로서 가장 기억에 남는 순간은?', en: "What's your most memorable moment as a Pioneer?" },
  { ko: 'Pi 생태계에서 가장 기대되는 기능은?', en: 'What Pi ecosystem feature excites you the most?' },
  { ko: '오늘 Pi 관련해서 가장 궁금한 것은?', en: "What's your biggest question about Pi today?" },
  { ko: '나만의 디부타데스 이용 팁이 있다면?', en: 'Do you have a tip for using this wall?' },
  { ko: '지금 이 순간 응원하고 싶은 사람이 있나요?', en: 'Is there someone you want to cheer on right now?' },
  { ko: '오늘 처음 시도해본 것이 있나요?', en: 'Did you try something new today?' },
  { ko: '나에게 내일 하루를 선물한다면 뭘 하고 싶나요?', en: 'If you had a free day tomorrow, what would you do?' },
  { ko: '지금 가장 편안한 장소는 어디인가요?', en: 'Where is the most comfortable place for you right now?' },
  { ko: '오늘 디부타데스에 남기고 싶은 진짜 이유는?', en: "What's your real reason for writing here today?" }
];

function getTodayQuestion(){
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  const q = QUESTIONS[dayOfYear % QUESTIONS.length];
  return { ...q, date: now.toISOString().slice(0, 10) };
}

app.get('/api/question/today', (req, res) => {
  res.json(getTodayQuestion());
});

// ---------- Vercel Blob 기반 저장소 (Private Store) ----------
// data.json 로컬 파일 대신, Private Blob 저장소에 하나의 JSON 파일을 두고 매번 읽고 씁니다.
// Private 저장소는 URL로 직접 접근이 안 되고, 반드시 get()으로 인증된 방식으로 읽어야 합니다.
async function loadData(){
  let data;
  try{
    const response = await get(DATA_BLOB_NAME, { access: 'private' });
    const text = await new Response(response.stream).text();
    data = JSON.parse(text);
  }catch(e){
    // 아직 파일이 한 번도 저장된 적 없으면 (첫 실행) 빈 데이터로 시작
    if(e && (e.name === 'BlobNotFoundError' || /not.*found/i.test(e.message || ''))){
      data = {};
    }else{
      console.error('loadData error:', e);
      data = {};
    }
  }
  // 예전에 저장된 데이터에는 아래 필드가 없을 수 있으므로 기본값으로 채워줌
  data.graffiti = data.graffiti || [];
  data.promos = data.promos || [];
  data.lastPostAt = data.lastPostAt || {};   // 도배 방지: { username: timestamp }
  data.streaks = data.streaks || {};         // 연속 작성: { username: { count, lastDate } }
  data.tickets = data.tickets || {};         // 무료 홍보권(1일): { username: 장수 }
  data.rewardedAds = data.rewardedAds || {}; // 보상형 광고 사용 기록: { adId: { user, at } } (같은 adId 재사용 방지)
  data.adRewardDays = data.adRewardDays || {}; // 보상형 광고 하루 지급 횟수: { username: { date, count } }
  return data;
}

async function saveData(data){
  await put(DATA_BLOB_NAME, JSON.stringify(data, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

// Pi 생태계 앱 URL만 허용 (pi:// 스킴 또는 *.pinet.com 도메인)
function isAllowedPiAppUrl(url){
  if(typeof url !== 'string') return false;
  return /^pi:\/\//i.test(url) || /^https:\/\/([a-z0-9-]+\.)*pinet\.com(\/|$)/i.test(url);
}

// ---------- 로그인 검증 (1단계 보안 보완) ----------
// 프론트가 보낸 username을 그대로 믿지 않고, Pi 액세스 토큰을 Pi 서버(/me)에 물어
// 진짜 로그인한 사용자 이름만 사용합니다. 같은 토큰은 5분간 캐시해 Pi API 호출을 줄입니다.
const tokenCache = new Map(); // accessToken -> { username, exp }
const TOKEN_CACHE_MS = 5 * 60 * 1000;
async function verifyUser(accessToken){
  if(!accessToken || typeof accessToken !== 'string') return null;
  const hit = tokenCache.get(accessToken);
  if(hit && hit.exp > Date.now()) return hit.username;
  try{
    const me = await getPiUser(accessToken);
    const username = String(me.username || '').trim();
    if(!username) return null;
    tokenCache.set(accessToken, { username, exp: Date.now() + TOKEN_CACHE_MS });
    if(tokenCache.size > 1000) tokenCache.clear(); // 메모리 보호
    return username;
  }catch(e){
    return null; // 만료·위조된 토큰
  }
}
const LOGIN_EXPIRED = { error: 'login required', message: '로그인이 만료되었어요. 다시 Pi로 로그인해주세요.' };

// 조회수 중복 방지용: 비로그인 방문자는 IP를 그대로 저장하지 않고 해시값 일부만 씁니다.
function viewerKey(req, username){
  if(username) return 'u:' + username.toLowerCase();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return 'a:' + crypto.createHash('sha256').update('dibutades:' + ip).digest('hex').slice(0, 16);
}

function generateId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- 도배 방지 ----------
// 같은 계정이 이 시간(ms) 안에 다시 낙서를 올리면 막습니다. 필요하면 숫자만 바꾸세요.
const POST_COOLDOWN_MS = 20 * 1000; // 20초

// ---------- 욕설/스팸 필터 ----------
// 아주 기본적인 블랙리스트 방식입니다. 완벽하지 않으니, 실제 운영하면서
// 자주 보이는 우회 표현(초성, 특수문자 섞기 등)을 이 배열에 계속 추가해주세요.
const BANNED_WORDS = [
  '시발', '씨발', 'ㅅㅂ', 'ㅆㅂ', '개새끼', '병신', 'ㅂㅅ', '지랄', '좆', '존나', 'ㅈㄴ',
  '느금', '엄창', '섹스', '자살하', '죽어버려',
  'fuck', 'shit', 'bitch', 'asshole'
];

// 문자 사이에 공백/특수문자를 끼워 필터를 피하는 걸 어느 정도 막기 위해,
// 검사할 때는 한글(완성형+낱자)/영문/숫자가 아닌 문자를 제거하고 비교합니다.
// ㄱ-ㅎ, ㅏ-ㅣ 범위(한글 낱자)를 빼먹으면 'ㅅㅂ' 같은 낱자 단어가 빈 문자열이 되어
// 모든 메시지가 오탐(false positive)되는 버그가 생기므로 반드시 포함해야 합니다.
function normalizeForFilter(s){
  return (s || '').toLowerCase().replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-z0-9]/g, '');
}
function containsBannedWord(message){
  const normalized = normalizeForFilter(message);
  return BANNED_WORDS.some(w => {
    const nw = normalizeForFilter(w);
    return nw.length > 0 && normalized.includes(nw); // 빈 문자열은 매칭 대상에서 제외
  });
}

// 같은 글자/이모지를 과도하게 반복하는 스팸성 게시물 감지 (예: "ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ")
function looksLikeSpam(message){
  if(/(.)\1{9,}/.test(message)) return true; // 같은 문자가 10번 이상 연속
  const urlCount = (message.match(/https?:\/\//gi) || []).length;
  if(urlCount >= 2) return true; // 링크 2개 이상 도배성 게시물로 간주
  return false;
}

// ---------- 홍보 요금제 ----------
// 결제 수수료(약 0.01 Pi)가 고정이라 너무 작은 금액은 수수료 비중이 커져서 최소 0.5 Pi로 둡니다.
// 금액/기간은 여기 숫자만 바꾸면 서버·검증 모두 반영됩니다. (화면 문구는 index.html에서 별도 수정)
const DAY_MS = 24 * 60 * 60 * 1000;
const PLANS = {
  7:  { amount: 0.5, days: 7 },
  30: { amount: 1.5, days: 30 }
};
const FREE_PROMO_DAYS = 1;       // 무료 홍보권 1장 = 1일 노출
const STREAK_FOR_TICKET = 7;     // 연속 7일 낙서마다 무료권 1장
const MAX_FREE_ACTIVE = 3;       // 무료 홍보가 동시에 노출될 수 있는 최대 개수 (스팸/도배 방지)

function promoExpiresAt(p){
  // 예전에 등록된 홍보에는 expiresAt이 없으므로 등록 후 7일로 계산
  return p.expiresAt || (p.createdAt + 7 * DAY_MS);
}

// ---------- 연속 작성(스트릭) 계산 ----------
function kstDateString(ts){
  // 한국 시간(KST, UTC+9) 기준 날짜 문자열(YYYY-MM-DD)로 변환
  const d = new Date(ts + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function updateStreak(data, username, now){
  const today = kstDateString(now);
  const yesterday = kstDateString(now - 24 * 60 * 60 * 1000);
  const prev = data.streaks[username];
  let count;
  if(!prev){
    count = 1;
  }else if(prev.lastDate === today){
    count = prev.count; // 오늘 이미 작성함 — 스트릭 유지, 중복 증가 없음
  }else if(prev.lastDate === yesterday){
    count = prev.count + 1; // 어제에 이어 오늘도 작성 — 스트릭 이어짐
  }else{
    count = 1; // 하루 이상 건너뜀 — 스트릭 초기화
  }
  data.streaks[username] = { count, lastDate: today };
  // 새로운 날에 스트릭이 늘어났고 7의 배수가 되면 무료 홍보권 1장 지급
  let ticketEarned = false;
  const isNewDay = !prev || prev.lastDate !== today;
  if(isNewDay && count > 0 && count % STREAK_FOR_TICKET === 0){
    data.tickets[username] = (data.tickets[username] || 0) + 1;
    ticketEarned = true;
  }
  return { count, ticketEarned };
}

// ---------- 낙서 (일반, 결제 없음) ----------
app.post('/api/graffiti', async (req, res) => {
  const { accessToken, message } = req.body || {};
  if(!message || typeof message !== 'string' || !message.trim()){
    return res.status(400).json({ error: 'message is required' });
  }
  if(message.length > 200){
    return res.status(400).json({ error: 'message too long' });
  }
  if(containsBannedWord(message)){
    return res.status(400).json({ error: 'inappropriate_content', message: '부적절한 표현이 포함되어 있어요.' });
  }
  if(looksLikeSpam(message)){
    return res.status(400).json({ error: 'spam_detected', message: '도배성 게시물로 감지되었어요.' });
  }
  // 로그인한 Pi 계정만 낙서 가능 — 작성자 이름은 Pi 서버가 확인해준 값만 사용 (사칭 차단)
  const author = await verifyUser(accessToken);
  if(!author) return res.status(401).json(LOGIN_EXPIRED);
  try{
    const data = await loadData();
    const authorKey = author.trim().toLowerCase();
    const now = Date.now();

    // 도배 방지: 최근에 이 계정으로 올린 적이 있으면 쿨다운 시간이 지날 때까지 막음
    const lastAt = data.lastPostAt[authorKey] || 0;
    const elapsed = now - lastAt;
    if(elapsed < POST_COOLDOWN_MS){
      const waitSec = Math.ceil((POST_COOLDOWN_MS - elapsed) / 1000);
      return res.status(429).json({ error: 'cooldown', message: `너무 빠르게 연속 게시했어요. ${waitSec}초 후 다시 시도해주세요.`, retryAfter: waitSec });
    }

    const { count: streak, ticketEarned } = updateStreak(data, authorKey, now);
    data.lastPostAt[authorKey] = now;
    data.graffiti.push({
      id: generateId(),
      author: author.trim().slice(0, 40),
      message: message.trim(),
      views: 0,
      reactions: { heart: 0, thumbsup: 0, pray: 0, happy: 0, sad: 0 },
      createdAt: now
    });
    await saveData(data);
    res.json({ ok: true, streak, ticketEarned });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 낙서에 반응(하트/엄지척/기도/기쁨/슬픔) 남기기 ----------
const REACTION_TYPES = ['heart', 'thumbsup', 'pray', 'happy', 'sad'];
app.post('/api/graffiti/:id/react', async (req, res) => {
  const { type, accessToken } = req.body || {};
  if(!REACTION_TYPES.includes(type)){
    return res.status(400).json({ error: 'invalid reaction type' });
  }
  // 반응은 로그인한 파이오니어만, 낙서 하나당 한 사람 한 번
  const username = await verifyUser(accessToken);
  if(!username) return res.status(401).json(LOGIN_EXPIRED);
  try{
    const data = await loadData();
    const item = data.graffiti.find(g => g.id === req.params.id);
    if(!item) return res.status(404).json({ error: 'not found' });
    // 예전에 등록된 낙서에는 reactions 필드가 없을 수 있으므로 채워줌
    item.reactions = item.reactions || { heart: 0, thumbsup: 0, pray: 0, happy: 0, sad: 0 };
    item.reactedBy = item.reactedBy || {};
    const userKey = username.toLowerCase();
    if(item.reactedBy[userKey]){
      return res.status(409).json({ error: 'already_reacted', reactions: item.reactions, mine: item.reactedBy[userKey] });
    }
    item.reactedBy[userKey] = type;
    item.reactions[type] = (item.reactions[type] || 0) + 1;
    await saveData(data);
    res.json({ ok: true, reactions: item.reactions, mine: type });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 낙서 조회수 올리기 (사용자가 낙서를 실제로 눌러서 볼 때 호출) ----------
// 같은 사람(로그인 계정 또는 비로그인 방문자)의 반복 클릭은 한 번만 셉니다.
app.post('/api/graffiti/:id/view', async (req, res) => {
  try{
    const username = await verifyUser((req.body || {}).accessToken);
    const key = viewerKey(req, username);
    const data = await loadData();
    const item = data.graffiti.find(g => g.id === req.params.id);
    if(!item) return res.status(404).json({ error: 'not found' });
    item.viewedBy = item.viewedBy || {};
    if(item.viewedBy[key]) return res.json({ ok: true, views: item.views || 0 });
    item.viewedBy[key] = 1;
    item.views = (item.views || 0) + 1;
    await saveData(data);
    res.json({ ok: true, views: item.views });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 조회수 TOP 5 낙서 (닉네임 + 조회수) ----------
app.get('/api/graffiti/top', async (req, res) => {
  try{
    const data = await loadData();
    const top = [...data.graffiti]
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 5)
      .map(g => ({ id: g.id, author: g.author, views: g.views || 0 }));
    res.json(top);
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 런치패드 TOP5 / 스테이킹 TOP5 ----------
// 코어팀의 공식 공개 API가 아직 확인되지 않아, 지금은 아래 배열을 수동으로 채워
// 넣는 방식입니다. 항목을 추가/수정하면 화면에 바로 반영됩니다.
// name: 화면에 보일 이름, metric: 부가 정보(가격, 모금액, 스테이킹 비율 등 자유롭게).
// 나중에 공식 API가 열리면 이 배열 대신 실제 fetch 호출로 교체하세요.
const LAUNCHPAD_TOP5 = [
  // { name: '토큰이름', metric: '예: $0.02 · 모금 80%' },
];
const STAKING_TOP5 = [
  // { name: '앱이름', metric: '예: 스테이킹 12,000 Pi' },
];

app.get('/api/launchpad/top5', (req, res) => {
  res.json(LAUNCHPAD_TOP5.slice(0, 5));
});

app.get('/api/staking/top5', (req, res) => {
  res.json(STAKING_TOP5.slice(0, 5));
});

// ---------- 디부타데스 통합 피드 (낙서 + 홍보, 최신순) ----------
app.get('/api/wall', async (req, res) => {
  try{
    const data = await loadData();
    const now = Date.now();
    const activePromos = data.promos
      .filter(p => now < promoExpiresAt(p)) // 요금제별 노출 기간(7일/30일/무료 1일)
      .map(p => ({ type: 'promo', ...p }));
    const graffiti = data.graffiti.map(({ reactedBy, viewedBy, ...g }) => ({ type: 'graffiti', ...g }));

    const combined = [...activePromos, ...graffiti].sort((a, b) => b.createdAt - a.createdAt);
    res.json(combined.slice(0, 100));
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 내 스트릭 / 무료 홍보권 조회 ----------
app.get('/api/tickets', async (req, res) => {
  try{
    const verified = await verifyUser(req.get('x-pi-token'));
    const user = String(verified || '').trim().toLowerCase();
    if(!user) return res.json({ tickets: 0, streak: 0 });
    const data = await loadData();
    const st = data.streaks[user];
    res.json({ tickets: data.tickets[user] || 0, streak: st ? st.count : 0, every: STREAK_FOR_TICKET });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

// ---------- 무료 홍보권 사용 (결제 없음, 1일 노출) ----------
app.post('/api/promo/free', async (req, res) => {
  const { appName, appUrl, message, accessToken } = req.body || {};
  const author = await verifyUser(accessToken);
  if(!author) return res.status(401).json(LOGIN_EXPIRED);
  if(!appName || !message) return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
  if(!isAllowedPiAppUrl(appUrl)){
    return res.status(400).json({ error: 'Pi 생태계 앱 URL만 등록할 수 있습니다.' });
  }
  if(containsBannedWord(appName) || containsBannedWord(message) || looksLikeSpam(message)){
    return res.status(400).json({ error: '부적절한 표현이 포함되어 있어요.' });
  }
  try{
    const data = await loadData();
    const key = String(author).trim().toLowerCase();
    const now = Date.now();
    if(!(data.tickets[key] > 0)){
      return res.status(400).json({ error: '무료 홍보권이 없어요. 연속 7일 낙서하면 1장 받아요.' });
    }
    const activeFree = data.promos.filter(p => p.free && now < promoExpiresAt(p));
    if(activeFree.length >= MAX_FREE_ACTIVE){
      return res.status(400).json({ error: '지금은 무료 홍보 자리가 가득 찼어요. 잠시 뒤 다시 시도해주세요.' });
    }
    if(activeFree.some(p => String(p.author).toLowerCase() === key)){
      return res.status(400).json({ error: '이미 무료 홍보가 노출 중이에요.' });
    }
    data.tickets[key] -= 1;
    data.promos.push({
      appName: String(appName).slice(0, 40),
      appUrl: appUrl.slice(0, 200),
      message: String(message).slice(0, 120),
      author: String(author).slice(0, 40),
      free: true,
      createdAt: now,
      expiresAt: now + FREE_PROMO_DAYS * DAY_MS
    });
    await saveData(data);
    res.json({ ok: true, tickets: data.tickets[key] });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Pi 광고(Ad Network): 보상형 광고 서버 검증 ----------
// 클라이언트(SDK) 결과는 조작될 수 있으므로, 반드시 서버에서 Pi Platform API로 확인한 뒤에만 보상합니다.
const AD_REWARD_DAILY_LIMIT = 1; // 한 사람이 하루(KST)에 광고로 받을 수 있는 무료 1일권 최대 장수

// accessToken으로 실제 로그인한 Pi 사용자를 확인 (클라이언트가 보낸 username을 그대로 믿지 않음)
async function getPiUser(accessToken){
  const r = await fetch(`${PI_API_BASE}/me`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if(!r.ok) throw new Error(`Pi API /me failed: ${r.status}`);
  return r.json(); // { uid, username }
}

async function getRewardedAdStatus(adId){
  const r = await fetch(`${PI_API_BASE}/ads_network/status/${encodeURIComponent(adId)}`, {
    headers: { 'Authorization': `Key ${PI_API_KEY}` }
  });
  if(!r.ok) throw new Error(`Pi API ad status failed: ${r.status}`);
  return r.json(); // { identifier, mediator_ack_status: 'granted'|'revoked'|'failed'|null, ... }
}

app.post('/api/ads/rewarded/verify', async (req, res) => {
  const { adId, accessToken } = req.body || {};
  if(!adId || typeof adId !== 'string') return res.status(400).json({ rewarded: false, error: 'adId required' });
  if(!accessToken) return res.status(401).json({ rewarded: false, error: 'login required' });
  if(!PI_API_KEY) return res.status(500).json({ rewarded: false, error: 'server not configured' });

  try{
    const me = await getPiUser(accessToken);
    const userKey = String(me.username || '').trim().toLowerCase();
    if(!userKey) return res.status(401).json({ rewarded: false, error: 'invalid user' });

    const status = await getRewardedAdStatus(adId);
    if(status.mediator_ack_status !== 'granted'){
      return res.json({ rewarded: false, reason: 'not_granted', status: status.mediator_ack_status });
    }

    const data = await loadData();
    if(data.rewardedAds[adId]){
      return res.json({ rewarded: false, reason: 'already_used' });
    }

    const today = kstDateString(Date.now());
    const day = data.adRewardDays[userKey];
    const usedToday = (day && day.date === today) ? day.count : 0;
    // 한도 초과여도 이 adId는 사용 처리해서 나중에 다시 쓰지 못하게 함
    data.rewardedAds[adId] = { user: userKey, at: Date.now() };
    if(usedToday >= AD_REWARD_DAILY_LIMIT){
      await saveData(data);
      return res.json({ rewarded: false, reason: 'daily_limit' });
    }

    data.adRewardDays[userKey] = { date: today, count: usedToday + 1 };
    data.tickets[userKey] = (data.tickets[userKey] || 0) + 1;
    await saveData(data);
    res.json({ rewarded: true, tickets: data.tickets[userKey] });
  }catch(e){
    console.error(e);
    res.status(500).json({ rewarded: false, error: e.message });
  }
});

// Pi 서버에서 결제 정보를 조회 (금액 위조 방지용)
async function getPiPayment(paymentId){
  const r = await fetch(`${PI_API_BASE}/payments/${paymentId}`, {
    headers: { 'Authorization': `Key ${PI_API_KEY}` }
  });
  if(!r.ok) throw new Error(`Pi API get payment failed: ${r.status}`);
  return r.json();
}
function planForAmount(amount){
  return Object.values(PLANS).find(p => Math.abs(p.amount - Number(amount)) < 1e-9) || null;
}

// ---------- Pi 결제: 서버 승인 ----------
app.post('/api/payments/approve', async (req, res) => {
  const { paymentId } = req.body;
  if(!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try{
    // 요금제에 없는 금액이면 승인하지 않음
    const payment = await getPiPayment(paymentId);
    if(!planForAmount(payment.amount)){
      return res.status(400).json({ error: 'invalid amount' });
    }
    const r = await fetch(`${PI_API_BASE}/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${PI_API_KEY}` }
    });
    if(!r.ok) throw new Error(`Pi API approve failed: ${r.status}`);
    res.json({ ok: true });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Pi 결제: 서버 완료 처리 + 홍보 등록 ----------
app.post('/api/payments/complete', async (req, res) => {
  const { paymentId, txid, appName, appUrl, message, accessToken } = req.body;
  // 결제는 Pi 서버가 이미 검증하므로 막지는 않되, 표시 이름은 확인된 계정명만 사용
  const author = (await verifyUser(accessToken)) || '개발자';
  if(!paymentId || !txid) return res.status(400).json({ error: 'paymentId, txid required' });

  if(!isAllowedPiAppUrl(appUrl)){
    return res.status(400).json({ error: 'Pi 생태계 앱 URL만 등록할 수 있습니다.' });
  }

  try{
    // 기간은 클라이언트가 보낸 값이 아니라, 실제로 결제된 금액으로 결정함
    const payment = await getPiPayment(paymentId);
    const plan = planForAmount(payment.amount);
    if(!plan) return res.status(400).json({ error: 'invalid amount' });

    const r = await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ txid })
    });
    if(!r.ok) throw new Error(`Pi API complete failed: ${r.status}`);

    const data = await loadData();
    const now = Date.now();
    data.promos.push({
      appName: String(appName || '').slice(0, 40),
      appUrl: appUrl.slice(0, 200),
      message: String(message || '').slice(0, 120),
      author: String(author).slice(0, 40),
      paymentId,
      createdAt: now,
      expiresAt: now + plan.days * DAY_MS
    });
    await saveData(data);

    res.json({ ok: true, days: plan.days });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 앱 재실행 시 남아있던 미완료 결제 정리용 (프론트의 onIncompletePaymentFound에서 호출)
app.post('/api/payments/complete-existing', async (req, res) => {
  const { paymentId } = req.body;
  try{
    const r = await fetch(`${PI_API_BASE}/payments/${paymentId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${PI_API_KEY}` }
    });
    res.json({ ok: r.ok });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`디부타데스 서버 실행 중: http://localhost:${PORT}`);
  if(!PI_API_KEY){
    console.warn('⚠️  PI_API_KEY 환경변수가 설정되지 않았습니다. 결제 기능이 동작하지 않습니다.');
  }
});
