/**
 * 디부타데스 (Pi Dibutades) - 백엔드 서버
 * -----------------------------------------------------------
 * 이 서버는 데모/시작점 코드입니다. 실제 서비스에는 다음을 반드시 교체하세요:
 *  - JSON 파일 저장(data.json) → 실제 데이터베이스 (Postgres, SQLite, Supabase 등)
 *  - 간단한 URL 정규식 검증 → 더 엄격한 Pi 앱 검증 (필요 시 운영자 수동 승인 큐 추가 권장)
 *  - PI_API_KEY, PORT 등은 .env 파일로 관리 (절대 코드에 하드코딩하지 마세요)
 *
 * 결제 흐름은 Pi Platform 공식 문서의 U2A(User-To-App) 결제 절차를 따릅니다:
 *  1) 프론트에서 Pi.createPayment() 호출
 *  2) onReadyForServerApproval → 서버가 /v2/payments/{id}/approve 호출
 *  3) 사용자가 Pi Browser에서 결제 확인
 *  4) onReadyForServerCompletion → 서버가 /v2/payments/{id}/complete 호출 (txid 포함)
 *
 * 참고: 이 마켓플레이스는 Pi 공식 "Pi Ad Network"(제3자 광고주 대상, 별도 승인 필요)와는
 * 다른, "개발자가 다른 개발자에게 직접 Pi를 지불하고 홍보 슬롯을 사는" 구조입니다.
 * 표준 U2A 결제만 사용하므로 Ad Network 별도 승인 없이 운영 가능합니다.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

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
const DATA_FILE = path.join(__dirname, 'data.json');

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

// ---------- 아주 단순한 파일 기반 저장소 (데모용) ----------
function loadData(){
  if(!fs.existsSync(DATA_FILE)){
    return { graffiti: [], promos: [] };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Pi 생태계 앱 URL만 허용 (pi:// 스킴 또는 *.pinet.com 도메인)
function isAllowedPiAppUrl(url){
  if(typeof url !== 'string') return false;
  return /^pi:\/\//i.test(url) || /^https:\/\/([a-z0-9-]+\.)*pinet\.com(\/|$)/i.test(url);
}

function generateId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- 낙서 (일반, 결제 없음) ----------
app.post('/api/graffiti', (req, res) => {
  const { author, message } = req.body;
  // 로그인한 Pi 계정만 낙서를 남길 수 있음 (익명 게시 차단)
  if(!author || typeof author !== 'string' || !author.trim()){
    return res.status(401).json({ error: 'login required' });
  }
  if(!message || typeof message !== 'string' || !message.trim()){
    return res.status(400).json({ error: 'message is required' });
  }
  if(message.length > 200){
    return res.status(400).json({ error: 'message too long' });
  }
  const data = loadData();
  data.graffiti.push({
    id: generateId(),
    author: author.trim().slice(0, 40),
    message: message.trim(),
    views: 0,
    createdAt: Date.now()
  });
  saveData(data);
  res.json({ ok: true });
});

// ---------- 낙서 조회수 올리기 (사용자가 낙서를 실제로 눌러서 볼 때 호출) ----------
app.post('/api/graffiti/:id/view', (req, res) => {
  const data = loadData();
  const item = data.graffiti.find(g => g.id === req.params.id);
  if(!item) return res.status(404).json({ error: 'not found' });
  item.views = (item.views || 0) + 1;
  saveData(data);
  res.json({ ok: true, views: item.views });
});

// ---------- 조회수 TOP 5 낙서 (닉네임 + 조회수) ----------
app.get('/api/graffiti/top', (req, res) => {
  const data = loadData();
  const top = [...data.graffiti]
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, 5)
    .map(g => ({ id: g.id, author: g.author, views: g.views || 0 }));
  res.json(top);
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
app.get('/api/wall', (req, res) => {
  const data = loadData();
  const now = Date.now();
  const activePromos = data.promos
    .filter(p => now - p.createdAt < 7 * 24 * 60 * 60 * 1000) // 7일(1주일) 노출
    .map(p => ({ type: 'promo', ...p }));
  const graffiti = data.graffiti.map(g => ({ type: 'graffiti', ...g }));

  const combined = [...activePromos, ...graffiti].sort((a, b) => b.createdAt - a.createdAt);
  res.json(combined.slice(0, 100));
});

// ---------- Pi 결제: 서버 승인 ----------
app.post('/api/payments/approve', async (req, res) => {
  const { paymentId } = req.body;
  if(!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try{
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
  const { paymentId, txid, appName, appUrl, message, author } = req.body;
  if(!paymentId || !txid) return res.status(400).json({ error: 'paymentId, txid required' });

  if(!isAllowedPiAppUrl(appUrl)){
    return res.status(400).json({ error: 'Pi 생태계 앱 URL만 등록할 수 있습니다.' });
  }

  try{
    const r = await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ txid })
    });
    if(!r.ok) throw new Error(`Pi API complete failed: ${r.status}`);

    const data = loadData();
    data.promos.push({
      appName: String(appName || '').slice(0, 40),
      appUrl: appUrl.slice(0, 200),
      message: String(message || '').slice(0, 120),
      author: String(author || '개발자').slice(0, 40),
      createdAt: Date.now()
    });
    saveData(data);

    res.json({ ok: true });
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
