/**
 * 낙서벽 (Pi Graffiti Wall) - 백엔드 서버
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const PI_API_KEY = process.env.PI_API_KEY; // Pi Developer Portal에서 발급받은 서버 API 키
const PI_API_BASE = 'https://api.minepi.com/v2';
const DATA_FILE = path.join(__dirname, 'data.json');

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

// ---------- 낙서 (일반, 결제 없음) ----------
app.post('/api/graffiti', (req, res) => {
  const { author, message } = req.body;
  if(!message || typeof message !== 'string' || !message.trim()){
    return res.status(400).json({ error: 'message is required' });
  }
  if(message.length > 200){
    return res.status(400).json({ error: 'message too long' });
  }
  const data = loadData();
  data.graffiti.push({
    author: (author || '익명').slice(0, 40),
    message: message.trim(),
    createdAt: Date.now()
  });
  saveData(data);
  res.json({ ok: true });
});

// ---------- 낙서벽 통합 피드 (낙서 + 홍보, 최신순) ----------
app.get('/api/wall', (req, res) => {
  const data = loadData();
  const now = Date.now();
  const activePromos = data.promos
    .filter(p => now - p.createdAt < 24 * 60 * 60 * 1000) // 24시간 노출
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
  console.log(`낙서벽 서버 실행 중: http://localhost:${PORT}`);
  if(!PI_API_KEY){
    console.warn('⚠️  PI_API_KEY 환경변수가 설정되지 않았습니다. 결제 기능이 동작하지 않습니다.');
  }
});
