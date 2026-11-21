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

// ---------- 오늘의 투표: 요일별 테마 + 특별한 날 (한국 시간 자정에 바뀜) ----------
// 요일마다 테마가 정해져 있고, 각 테마의 투표 9개가 매주 하나씩 돌아갑니다 (9주, 약 두 달에 한 바퀴).
// 모양: [질문(한국어), 질문(영어), [[보기(한국어), 보기(영어)], ...]]  · 보기는 2~4개
// 모든 투표에는 마지막에 "✏️ 다른 생각" 보기가 자동으로 붙고, 그걸 고르면 아래 한마디 칸에 쓰게 됩니다.
// 특별한 날(SPECIAL_DAYS)에는 요일 테마 대신 그날 투표가 나옵니다. 날짜는 '월-일'입니다.
const POLL_THEMES = [
  { day: '일요일', ko: '마음', en: 'Heart', qs: [
    ['요즘 나에게 더 필요한 건?', 'What do you need more these days?', [['휴식', 'Rest'], ['도전', 'A challenge']]],
    ['지금 내 마음의 날씨는?', 'Your inner weather right now?', [['☀️ 맑음', 'Sunny'], ['⛅ 구름', 'Cloudy'], ['🌧️ 비', 'Rainy']]],
    ['힘들 때 나는 주로?', 'When things get hard, I usually…', [['혼자 정리해요', 'Sort it out alone'], ['누군가와 이야기해요', 'Talk to someone'], ['일단 자요', 'Sleep on it']]],
    ['주말 저녁, 더 끌리는 건?', 'A weekend evening — which appeals more?', [['집에서 쉬기', 'Stay in'], ['밖에서 걷기', 'Go for a walk']]],
    ['위로가 필요할 때 듣고 싶은 말은?', 'Words you want to hear when you need comfort?', [['"괜찮아"', '"It\'s okay"'], ['"잘하고 있어"', '"You\'re doing great"'], ['"같이 있어 줄게"', '"I\'m here with you"']]],
    ['이번 주의 나에게 주고 싶은 점수는?', 'Your score for yourself this week?', [['💯 만점', 'Full marks'], ['👍 꽤 괜찮음', 'Pretty good'], ['🌱 다음 주엔 더', 'Better next week']]],
    ['혼자 있는 시간, 나에게는?', 'Time alone — for me it is…', [['충전 시간', 'Recharging'], ['조금 외로운 시간', 'A bit lonely']]],
    ['고마운 마음, 나는 주로 어떻게 전하나요?', 'How do you usually say thanks?', [['말로', 'In words'], ['메시지로', 'By message'], ['작은 선물로', 'With a small gift']]],
    ['잠들기 전 내 머릿속은?', 'Before sleep, my mind is…', [['오늘 일 되감기', 'Replaying today'], ['내일 계획 세우기', 'Planning tomorrow'], ['텅 빈 상태', 'Totally blank']]]
  ]},
  { day: '월요일', ko: '일상', en: 'Everyday', qs: [
    ['아침의 첫 음료는?', 'Your first drink of the morning?', [['☕ 커피', 'Coffee'], ['🍵 차', 'Tea'], ['💧 물', 'Water']]],
    ['알람이 울리면 나는?', 'When the alarm rings…', [['바로 일어나요', 'Up right away'], ['5분만 더…', 'Five more minutes'], ['알람이 여러 개예요', 'I set several alarms']]],
    ['월요일을 버티는 힘은?', 'What gets you through Monday?', [['맛있는 점심', 'A good lunch'], ['퇴근 후 계획', 'After-work plans'], ['그냥 버틴다', 'Just pushing through']]],
    ['휴대폰 배터리, 몇 %부터 불안해요?', 'At what battery level do you start to worry?', [['50%', '50%'], ['20%', '20%'], ['5%도 괜찮아요', 'Fine even at 5%']]],
    ['출근길·등굣길 이동 수단은?', 'How do you get to work or school?', [['🚶 걸어서', 'Walk'], ['🚌 대중교통', 'Public transit'], ['🚗 차', 'Car'], ['🏠 집에서 해요', 'From home']]],
    ['나는 어느 쪽?', 'Which one are you?', [['🌅 아침형', 'Morning person'], ['🌙 저녁형', 'Night owl']]],
    ['메시지 답장, 나는?', 'Replying to messages, I am…', [['바로바로', 'Right away'], ['몰아서', 'In batches'], ['가끔 잊어요', 'Sometimes I forget']]],
    ['지금 내 책상 상태는?', 'Your desk right now?', [['깔끔', 'Tidy'], ['적당히', 'So-so'], ['나만 아는 질서', 'Organized chaos']]],
    ['이번 주 목표의 크기는?', "The size of this week's goal?", [['큰 꿈', 'A big dream'], ['작은 한 걸음', 'One small step'], ['무사히 버티기', 'Just get through']]]
  ]},
  { day: '화요일', ko: '음식', en: 'Food', qs: [
    ['라면에 하나만 더 넣는다면?', 'One extra for your ramen?', [['🥚 달걀', 'Egg'], ['🧀 치즈', 'Cheese'], ['🥬 파·김치', 'Scallion or kimchi']]],
    ['평생 하나만 먹어야 한다면?', 'Only one for the rest of your life?', [['🍚 밥', 'Rice'], ['🍞 빵', 'Bread'], ['🍜 면', 'Noodles']]],
    ['비 오는 날 생각나는 건?', 'Your rainy-day craving?', [['부침개', 'Korean pancake'], ['따뜻한 국물', 'Hot soup'], ['달콤한 디저트', 'Something sweet']]],
    ['매운 음식, 나는?', 'Spicy food and me?', [['🔥 아주 맵게', 'Bring the heat'], ['🙂 적당히', 'Medium'], ['🥛 순한 맛', 'Mild, please']]],
    ['탕수육 소스는?', 'Sweet-and-sour pork sauce?', [['부어 먹기', 'Pour it on'], ['찍어 먹기', 'Dip it']]],
    ['외국 친구에게 먼저 권하고 싶은 한국 음식은?', 'The Korean dish you would offer a foreign friend first?', [['비빔밥', 'Bibimbap'], ['김치찌개', 'Kimchi stew'], ['떡볶이', 'Tteokbokki'], ['불고기', 'Bulgogi']]],
    ['오늘 저녁, 더 끌리는 건?', "Tonight's dinner?", [['집밥', 'Home-cooked'], ['외식', 'Eating out'], ['배달', 'Delivery']]],
    ['디저트를 고른다면?', 'Pick a dessert', [['🍦 아이스크림', 'Ice cream'], ['🍰 케이크', 'Cake'], ['🍓 과일', 'Fruit']]],
    ['음식 사진, 먹기 전에 찍나요?', 'A photo before eating?', [['꼭 찍어요', 'Always'], ['가끔', 'Sometimes'], ['먹기 바빠요', 'Too busy eating']]]
  ]},
  { day: '수요일', ko: '만약에', en: 'What if', qs: [
    ['투명인간 되기 vs 하늘 날기', 'Become invisible or be able to fly?', [['👻 투명인간', 'Invisible'], ['🕊️ 하늘 날기', 'Flying']]],
    ['시간 여행을 한다면 어디로?', 'Time travel — where to?', [['⏪ 과거로', 'The past'], ['⏩ 미래로', 'The future']]],
    ['동물과 대화할 수 있다면 먼저?', 'If you could talk to one animal first?', [['🐶 강아지', 'Dog'], ['🐱 고양이', 'Cat'], ['🐬 돌고래', 'Dolphin'], ['🐦 새', 'Bird']]],
    ['우주여행 티켓이 생긴다면?', 'You get a ticket to space?', [['🚀 바로 간다', 'Go right away'], ['🌍 지구가 좋아요', 'I will stay on Earth']]],
    ['하루에 한 시간이 더 생긴다면?', 'One extra hour every day?', [['😴 잠', 'Sleep'], ['📚 배우기', 'Learn'], ['🎮 놀기', 'Play'], ['👨‍👩‍👧 가족', 'Family']]],
    ['2099년에 열릴 타임캡슐에 넣는다면?', 'For a time capsule opened in 2099?', [['✉️ 편지', 'A letter'], ['📷 사진', 'A photo'], ['📱 지금 쓰는 휴대폰', "Today's phone"]]],
    ['하나만 가질 수 있다면?', 'Pick one power', [['순간이동', 'Teleport'], ['마음 읽기', 'Read minds'], ['시간 멈추기', 'Stop time']]],
    ['무인도에 하나만 가져간다면?', 'One item on a desert island?', [['🔪 칼', 'A knife'], ['📖 책', 'A book'], ['🍜 라면 한 박스', 'A box of ramen']]],
    ['내 인생이 영화라면 장르는?', 'Your life as a movie genre?', [['😂 코미디', 'Comedy'], ['🎭 드라마', 'Drama'], ['🗺️ 모험', 'Adventure'], ['💕 로맨스', 'Romance']]]
  ]},
  { day: '목요일', ko: '파이와 크립토', en: 'Pi & Crypto', qs: [
    ['Pi로 가장 먼저 해 보고 싶은 건?', 'The first thing you would like to do with Pi?', [['물건 사기', 'Buy goods'], ['서비스 이용', 'Use a service'], ['기부하기', 'Donate']]],
    ['처음 Pi를 알게 된 경로는?', 'How did you first hear about Pi?', [['지인 추천', 'A friend'], ['SNS·유튜브', 'Social media'], ['뉴스·기사', 'News']]],
    ['매일 채굴 버튼, 나는?', 'The daily mining tap — I…', [['하루도 안 빠져요', 'Never miss a day'], ['가끔 잊어요', 'Sometimes forget'], ['알림 덕분에 해요', 'Thanks to reminders']]],
    ['Pi 앱에 가장 바라는 것은?', 'What do you want most from the Pi app?', [['더 많은 쓸 곳', 'More places to use Pi'], ['더 쉬운 사용법', 'Easier to use'], ['더 빠른 소식', 'Faster updates']]],
    ['내 보안 서클은 몇 명인가요?', 'How many people in your Security Circle?', [['1~2명', '1–2'], ['3~4명', '3–4'], ['5명', '5'], ['아직 없어요', 'None yet']]],
    ['가장 자주 쓰는 Pi 앱 종류는?', 'The kind of Pi app you use most?', [['🎮 게임', 'Games'], ['💬 커뮤니티', 'Community'], ['🛍️ 쇼핑', 'Shopping'], ['거의 안 써요', 'Rarely']]],
    ['서밋 같은 큰 행사, 나는?', 'Big events like the Summit — I…', [['실시간으로 봐요', 'Watch live'], ['요약만 봐요', 'Read summaries'], ['잘 안 봐요', 'Skip them']]],
    ['가족에게 Pi를 알려 줬나요?', 'Have you told your family about Pi?', [['이미 함께해요', "They're in"], ['알려 줬지만 아직', 'Told them, not yet'], ['아직 안 했어요', 'Not yet']]],
    ['Pi 소식은 주로 어디서 보나요?', 'Where do you get Pi news?', [['X', 'X'], ['카페·커뮤니티', 'Forums'], ['유튜브', 'YouTube'], ['디부타데스', 'Dibutades']]]
  ]},
  { day: '금요일', ko: '007 사기 판별', en: '007 Scam Watch', qs: [
    ['모르는 계정이 보낸 링크, 나는?', 'A link from an unknown account — I…', [['절대 안 눌러요', 'Never tap it'], ['확인 후 눌러요', 'Check first'], ['가끔 눌러 봐요', 'Sometimes tap']]],
    ['"두 배로 돌려준다"는 말을 들으면?', '"Send and get double back" — you…', [['🚫 바로 차단', 'Block'], ['🙈 일단 무시', 'Ignore'], ['🚨 신고', 'Report']]],
    ['패스프레이즈 보관 방법은? (내용은 절대 쓰지 마세요!)', 'How do you keep your passphrase? (Never post the words!)', [['종이에 적어서', 'On paper'], ['안전한 곳에 따로', 'Somewhere safe offline'], ['휴대폰 메모·사진', 'Phone notes or photo']]],
    ['"공식 지원팀"이라며 DM이 오면?', 'An "official support" DM arrives — you…', [['무시', 'Ignore'], ['공식 채널에서 확인', 'Check official channels'], ['답장', 'Reply']]],
    ['가장 조심해야 할 사기는?', 'The scam to watch out for most?', [['패스프레이즈 요구', 'Passphrase requests'], ['선입금 요구', 'Upfront fees'], ['가짜 앱', 'Fake apps'], ['사칭 계정', 'Impersonators']]],
    ['사기를 당할 뻔한 적이 있나요?', 'Have you ever nearly fallen for a scam?', [['있어요', 'Yes'], ['없어요', 'No'], ['잘 모르겠어요', 'Not sure']]],
    ['사기 소식은 주로 어디서 알게 되나요?', 'Where do you learn about scams?', [['지인', 'Friends'], ['SNS', 'Social media'], ['007 경보', 'Scam Alert tab']]],
    ['조건이 너무 좋을 때 나는 먼저?', 'When a deal looks too good, first I…', [['공식 발표 확인', 'Check official news'], ['주변에 물어보기', 'Ask around'], ['그냥 지나가기', 'Walk away']]],
    ['오늘의 007 퀴즈, 결과는?', "Today's 007 quiz — how did it go?", [['맞혔어요', 'Got it'], ['틀렸어요', 'Missed it'], ['아직 안 풀었어요', 'Not yet']]]
  ]},
  { day: '토요일', ko: '추억과 문화', en: 'Memories & Culture', qs: [
    ['어릴 때 제일 좋아한 놀이는?', 'Your favorite game as a child?', [['숨바꼭질', 'Hide and seek'], ['술래잡기', 'Tag'], ['딱지·구슬', 'Marbles & cards'], ['게임기', 'Video games']]],
    ['처음 좋아한 음악 장르는?', 'The first music genre you loved?', [['가요·팝', 'Pop'], ['록', 'Rock'], ['트로트·민요', 'Folk & trot'], ['클래식', 'Classical']]],
    ['나의 여행 스타일은?', 'Your travel style?', [['📋 계획파', 'Planner'], ['🎲 즉흥파', 'Spontaneous']]],
    ['딱 하루 돌아갈 수 있다면?', 'Go back for one day?', [['어린 시절', 'Childhood'], ['학창 시절', 'School days'], ['지금이 좋아요', 'I like now']]],
    ['명절에 가장 기다려지는 것은?', 'The best part of a holiday?', [['🍲 음식', 'Food'], ['👨‍👩‍👧 가족 모임', 'Family'], ['🛌 쉬는 날', 'Days off']]],
    ['어릴 적 꿈과 지금의 나는?', 'Your childhood dream and you now?', [['꿈을 이뤘어요', 'Made it'], ['새 꿈을 찾았어요', 'Found a new dream'], ['아직 가는 중', 'Still on my way']]],
    ['받으면 더 기쁜 건?', 'Which feels better to receive?', [['✉️ 손편지', 'A handwritten letter'], ['📱 메시지', 'A text message']]],
    ['내 사진들은 주로 어디에?', 'Where do your photos live?', [['인화한 앨범', 'Printed albums'], ['휴대폰 속', 'On my phone'], ['클라우드', 'In the cloud']]],
    ['세계에 알리고 싶은 한국 문화는?', 'Korean culture you would share with the world?', [['한글', 'Hangeul'], ['한식', 'Food'], ['K-음악', 'Music'], ['전통 놀이', 'Traditional games']]]
  ]}
];
const SPECIAL_DAYS = {
  '01-01': ['새해 첫날! 올해 다짐의 크기는?', "New Year! How big is this year's resolution?", [['큰 목표', 'A big goal'], ['작은 습관', 'A small habit'], ['다짐 없이 자유롭게', 'No resolutions']], '새해 첫날', "New Year's Day"],
  '02-14': ['마음을 전하는 나만의 방법은?', 'Your way of showing you care?', [['🍫 초콜릿', 'Chocolate'], ['✉️ 편지', 'A letter'], ['🤝 함께하는 시간', 'Time together']], '밸런타인데이', "Valentine's Day"],
  '03-14': ['파이 데이! 오늘 나는?', 'Happy Pi Day! Today I…', [['🥧 파이 먹기', 'Eat a pie'], ['🔢 3.14 기념하기', 'Celebrate 3.14'], ['⛏️ 평소처럼 채굴', 'Mine as usual']], '파이 데이', 'Pi Day'],
  '04-22': ['지구의 날, 오늘의 작은 실천은?', "Earth Day — today's small action?", [['텀블러 쓰기', 'Reusable cup'], ['분리수거', 'Recycling'], ['차 대신 걷기', 'Walk instead of driving']], '지구의 날', 'Earth Day'],
  '05-05': ['어린 시절로 하루 돌아간다면?', 'Back to childhood for one day?', [['실컷 놀기', 'Play all day'], ['가족과 시간', 'Time with family'], ['공부 다시 하기', 'Study again']], '어린이날', "Children's Day"],
  '05-08': ['부모님께 전하고 싶은 것은?', 'What would you give your parents today?', [['고맙다는 말', 'A thank you'], ['사랑한다는 말', 'An I love you'], ['함께하는 식사', 'A meal together']], '어버이날', "Parents' Day"],
  '06-28': ['2π 데이! Pi와 함께한 시간은?', 'Happy 2π Day! How long have you been with Pi?', [['2019년부터', 'Since 2019'], ['2020~2022년부터', 'Since 2020–2022'], ['2023년 이후', 'Since 2023 or later']], '2π 데이', 'Pi2 Day'],
  '10-09': ['한글날! 가장 아름다운 우리말은?', 'Hangeul Day! The most beautiful Korean word?', [['사랑', 'Love'], ['하늘', 'Sky'], ['그리움', 'Longing'], ['우리', 'Us']], '한글날', 'Hangeul Day'],
  '10-31': ['할로윈, 나는?', 'Halloween — and me?', [['🎃 분장 좋아요', 'Love costumes'], ['🍬 사탕만', 'Just the candy'], ['😐 관심 없어요', 'Not my thing']], '할로윈', 'Halloween'],
  '12-25': ['크리스마스에 받고 싶은 선물은?', 'Your Christmas wish?', [['🎁 갖고 싶던 물건', 'Something I wanted'], ['✈️ 여행', 'A trip'], ['🛌 푹 쉬기', 'A good rest']], '크리스마스', 'Christmas'],
  '12-31': ['올해를 한 단어로 고른다면?', 'This year in one word?', [['🌱 성장', 'Growth'], ['🪨 버팀', 'Endurance'], ['😊 행복', 'Happiness'], ['🔄 변화', 'Change']], '한 해의 마지막 날', "New Year's Eve"]
};

function getBasePoll(){
  const kst = new Date(Date.now() + 9 * 3600 * 1000);          // 한국 시간 기준
  const date = kst.toISOString().slice(0, 10);
  const sp = SPECIAL_DAYS[date.slice(5)];
  let q, theme, themeEn, special = false;
  if(sp){ q = sp; theme = sp[3]; themeEn = sp[4]; special = true; }
  else{
    const t = POLL_THEMES[kst.getUTCDay()];
    const week = Math.floor(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) / 86400000 / 7);
    q = t.qs[week % t.qs.length]; theme = `${t.day} · ${t.ko}`; themeEn = t.en;
  }
  const options = q[2].map(o => ({ ko: o[0], en: o[1] })).concat([{ ko: '✏️ 다른 생각', en: 'Something else', other: true }]);
  return { date, key: date, ko: q[0], en: q[1], theme, themeEn, special, options, override: false };
}


// ---------- 관리자 특별 투표 (그날 하루만 요일 테마 대신 나옴, 자정에 저절로 원래대로) ----------
// 관리자: Vercel 환경변수 COSMOS_ADMIN, 없으면 minkyeungsoon (007 경보·은하 관리자와 같음)
const POLL_OVERRIDE_BLOB = 'dibutades-poll-override.json';
const overrideMem = { d: undefined, at: 0 };
async function loadOverride(){
  if(overrideMem.d !== undefined && Date.now() - overrideMem.at < 60 * 1000) return overrideMem.d;
  let d = null;
  try{ const r = await get(POLL_OVERRIDE_BLOB, { access: 'private' }); d = JSON.parse(await new Response(r.stream).text()); }catch(e){}
  overrideMem.d = d; overrideMem.at = Date.now();
  return d;
}
async function getTodayPoll(){
  const p = getBasePoll();
  const o = await loadOverride().catch(() => null);
  if(o && o.date === p.date && Array.isArray(o.options) && o.options.length >= 2){
    const options = o.options.map(x => ({ ko: x.ko, en: x.en || '' })).concat([{ ko: '✏️ 다른 생각', en: 'Something else', other: true }]);
    return { date: p.date, key: p.date + ':' + o.setAt, ko: o.ko, en: o.en || '', theme: '🎤 오늘의 특별 투표', themeEn: 'Special poll', special: true, options, override: true };
  }
  return p;
}
function pollAdminName(){ return String(process.env.COSMOS_ADMIN || 'minkyeungsoon').trim().toLowerCase(); }
async function isPollAdmin(accessToken){
  const name = await verifyUser(accessToken);
  return !!name && name.trim().toLowerCase() === pollAdminName();
}

// ---------- 투표 집계 (저장 횟수를 아끼려고 5분에 한 번, 또는 30표마다 한꺼번에 저장) ----------
const POLL_BLOB_NAME = 'dibutades-poll.json';
const pollMem = { d: null, at: 0, pending: [], lastFlush: 0 };
function pollEmpty(key, n){ return { date: key, counts: Array(n).fill(0), voters: {}, cc: {} }; }
async function pollLoadBlob(date, n){   // date 자리에는 투표 열쇠(날짜, 특별 투표면 날짜:시각)가 들어옴
  try{
    const r = await get(POLL_BLOB_NAME, { access: 'private' });
    const d = JSON.parse(await new Response(r.stream).text());
    if(d && d.date === date && Array.isArray(d.counts)){ while(d.counts.length < n) d.counts.push(0); d.voters = d.voters || {}; d.cc = d.cc || {}; return d; }
  }catch(e){}
  return pollEmpty(date, n);
}
function pollApply(d){
  for(const p of pollMem.pending){
    if(p.date !== d.date || d.voters[p.vid] !== undefined) continue;
    d.voters[p.vid] = p.choice; d.counts[p.choice] = (d.counts[p.choice] || 0) + 1;
    pollCountryAdd(d, p.choice, p.cc);
  }
  return d;
}
async function pollLoad(date, n){
  if(pollMem.d && pollMem.d.date === date && Date.now() - pollMem.at < 60 * 1000) return pollMem.d;
  pollMem.pending = pollMem.pending.filter(p => p.date === date);   // 날이 바뀐 표는 버림
  pollMem.d = pollApply(await pollLoadBlob(date, n));
  pollMem.at = Date.now();
  return pollMem.d;
}
async function pollFlush(date, n){
  if(!pollMem.pending.length) return;
  if(Date.now() - pollMem.lastFlush < 5 * 60 * 1000 && pollMem.pending.length < 30) return;
  const d = pollApply(await pollLoadBlob(date, n));
  await put(POLL_BLOB_NAME, JSON.stringify(d), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
  pollMem.pending = []; pollMem.d = d; pollMem.at = Date.now(); pollMem.lastFlush = Date.now();
}
// 나라별 합계: 누가 어느 나라인지는 저장하지 않고, 보기마다 "나라 코드: 표 수" 합계만 남김
function pollCountryAdd(d, choice, cc){
  d.cc = d.cc || {};
  const k = /^[A-Z]{2}$/.test(cc || '') ? cc : 'XX';
  const m = d.cc[choice] = d.cc[choice] || {};
  m[k] = (m[k] || 0) + 1;
}
function pollView(p, d, vid){
  const total = d.counts.reduce((a, b) => a + b, 0);
  const byCountry = p.options.map((_, i) => Object.entries((d.cc && d.cc[i]) || {}).sort((a, b) => b[1] - a[1]).slice(0, 8));
  return { ...p, byCountry, counts: d.counts.slice(0, p.options.length), total, myChoice: vid && d.voters[vid] !== undefined ? d.voters[vid] : null };
}

app.get('/api/poll/today', async (req, res) => {
  const p = await getTodayPoll();
  try{
    flushOldPoll(p.key);
    const d = await pollLoad(p.key, p.options.length);
    res.set('Cache-Control', 'no-store');
    res.json(pollView(p, d, String(req.query.vid || '').slice(0, 64)));
  }catch(e){ res.json({ ...p, counts: Array(p.options.length).fill(0), total: 0, myChoice: null }); }
});
app.post('/api/poll/vote', async (req, res) => {
  const p = await getTodayPoll();
  const { choice, visitorId } = req.body || {};
  const c = Number(choice), vid = String(visitorId || '').slice(0, 64);
  const cc = String(req.headers['x-vercel-ip-country'] || '').toUpperCase().slice(0, 2);   // Vercel이 알려 주는 접속 나라 (나라 단위)
  if(!Number.isInteger(c) || c < 0 || c >= p.options.length) return res.status(400).json({ error: 'bad_choice' });
  if(!vid) return res.status(400).json({ error: 'no_visitor' });
  try{
    const d = await pollLoad(p.key, p.options.length);
    if(d.voters[vid] === undefined && Object.keys(d.voters).length < 20000){
      d.voters[vid] = c; d.counts[c] = (d.counts[c] || 0) + 1; pollCountryAdd(d, c, cc);
      pollMem.pending.push({ date: p.key, vid, choice: c, cc });
      try{ await pollFlush(p.key, p.options.length); }catch(e){ console.error('poll save', e && e.message); }
    }
    res.json(pollView(p, d, vid));
  }catch(e){ console.error('poll vote', e && e.message); res.status(500).json({ error: 'server' }); }
});


// 열쇠가 바뀌면(자정 또는 특별 투표) 모아 둔 이전 표는 버림
function flushOldPoll(key){ if(pollMem.pending.some(p => p.date !== key)) pollMem.pending = pollMem.pending.filter(p => p.date === key); }

// ---------- 관리자 전용: 오늘의 특별 투표 걸기 / 되돌리기 ----------
app.post('/api/poll/admin/me', async (req, res) => {
  res.json({ admin: await isPollAdmin((req.body || {}).accessToken) });
});

// 관리자 투표용 한→영 자동 번역 (MyMemory 무료 번역, 실패하면 빈칸)
async function koToEn(text){
  const q = String(text || '').trim().slice(0, 200);
  if(!q) return '';
  try{
    const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=ko|en', { headers: { 'User-Agent': 'DibutadesApp/1.0' } });
    const j = await r.json();
    const out = j && j.responseData && j.responseData.translatedText;
    if(!out || j.quotaFinished || Number(j.responseStatus) !== 200 || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) return '';
    return String(out).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/<[^>]*>/g, '').trim();
  }catch(e){ return ''; }
}
app.post('/api/poll/admin/translate', async (req, res) => {
  const { accessToken, texts } = req.body || {};
  if(!(await isPollAdmin(accessToken))) return res.status(403).json({ error: 'forbidden' });
  const list = (Array.isArray(texts) ? texts : []).slice(0, 5).map(t => String(t || '').slice(0, 200));
  res.json({ en: await Promise.all(list.map(koToEn)) });
});
app.post('/api/poll/admin/set', async (req, res) => {
  const { accessToken, ko, en, options } = req.body || {};
  if(!(await isPollAdmin(accessToken))) return res.status(403).json({ error: 'forbidden', message: '관리자만 바꿀 수 있어요.' });
  const q = String(ko || '').trim().slice(0, 80), qEn = String(en || '').trim().slice(0, 120);
  const opts = (Array.isArray(options) ? options : []).map(o => ({ ko: String((o && o.ko) || '').trim().slice(0, 30), en: String((o && o.en) || '').trim().slice(0, 40) })).filter(o => o.ko).slice(0, 4);
  if(!q) return res.status(400).json({ error: 'bad_question', message: '질문을 적어 주세요.' });
  if(opts.length < 2) return res.status(400).json({ error: 'bad_options', message: '보기를 2개 이상 적어 주세요.' });
  // 영어 칸이 비어 있으면 자동 번역으로 채움 (실패하면 한국어만 나옴)
  const [autoQ, ...autoOpts] = await Promise.all([qEn ? qEn : koToEn(q), ...opts.map(o => o.en ? o.en : koToEn(o.ko))]);
  opts.forEach((o, i) => { o.en = String(autoOpts[i] || '').slice(0, 40); });
  const date = getBasePoll().date;
  const o = { date, setAt: Date.now(), ko: q, en: String(autoQ || '').slice(0, 120), options: opts };
  try{
    await put(POLL_OVERRIDE_BLOB, JSON.stringify(o), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
    overrideMem.d = o; overrideMem.at = Date.now();
    res.json({ ok: true });
  }catch(e){ console.error('poll override', e && e.message); res.status(500).json({ error: 'server', message: '저장하지 못했어요. 잠시 뒤 다시 해 주세요.' }); }
});
app.post('/api/poll/admin/clear', async (req, res) => {
  if(!(await isPollAdmin((req.body || {}).accessToken))) return res.status(403).json({ error: 'forbidden', message: '관리자만 바꿀 수 있어요.' });
  try{
    await put(POLL_OVERRIDE_BLOB, JSON.stringify({ date: '', setAt: Date.now(), cleared: true }), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
    overrideMem.d = null; overrideMem.at = Date.now();
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: 'server', message: '되돌리지 못했어요. 잠시 뒤 다시 해 주세요.' }); }
});

// 예전 화면과의 호환용 (오늘의 투표 질문만 돌려줌)
app.get('/api/question/today', async (req, res) => {
  const p = await getTodayPoll();
  res.json({ ko: p.ko, en: p.en, theme: p.theme, themeEn: p.themeEn, special: p.special, date: p.date });
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

// ---------- 방문 통계: 오늘 방문한 사람 / 낙서한 사람 / 구경만 한 사람 ----------
// 낙서·결제 데이터(dibutades-data.json)와 섞이지 않도록 별도 파일에 저장합니다.
// (방문 기록 저장이 낙서·결제 저장과 동시에 일어나도 서로 덮어쓰지 않게 하기 위함)
// 방문자 구분: 브라우저가 만든 무작위 번호(visitorId), 없으면 IP를 해시한 값 일부. 원래 IP는 저장하지 않음.
const VISITS_BLOB_NAME = 'dibutades-visits.json';
const VISIT_KEEP_DAYS = 14;
async function loadVisits(){
  try{
    const response = await get(VISITS_BLOB_NAME, { access: 'private' });
    const v = JSON.parse(await new Response(response.stream).text());
    v.days = v.days || {};
    return v;
  }catch(e){
    if(!(e && (e.name === 'BlobNotFoundError' || /not.*found/i.test(e.message || '')))) console.error('loadVisits error:', e);
    return { days: {} };
  }
}
async function saveVisits(v){
  const keep = Object.keys(v.days).sort().slice(-VISIT_KEEP_DAYS); // 최근 14일만 보관
  const days = {}; keep.forEach(d => { days[d] = v.days[d]; });
  await put(VISITS_BLOB_NAME, JSON.stringify({ days }), {
    access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true
  });
}
function visitorKey(req, visitorId){
  if(typeof visitorId === 'string' && /^[a-z0-9]{8,32}$/.test(visitorId)) return 'c:' + visitorId;
  return viewerKey(req, null); // 브라우저 저장소를 못 쓰는 경우: IP 해시 일부
}
function visitStats(day){
  const v = day ? Object.keys(day.v || {}) : [];
  const w = day ? day.w || {} : {};
  const writers = Object.keys(w).length;
  return { visitors: v.length, writers, lookers: v.filter(k => !w[k]).length };
}
// kind: 'v' = 방문, 'w' = 낙서 작성 (작성자는 방문자로도 함께 기록)
// 저장 횟수 줄이기 (Vercel 무료 요금제: Blob 쓰기 한 달 2,000번):
// 새 방문자를 바로 저장하지 않고 서버 메모리에 모았다가 5분에 한 번(또는 30명이 모이면) 한꺼번에 저장합니다.
// 저장할 때 Blob의 최신 기록을 다시 읽어 합치므로 서버가 여러 개여도 서로 덮어쓰지 않습니다.
const VISIT_FLUSH_MS = 5 * 60 * 1000, VISIT_FLUSH_COUNT = 30, VISIT_READ_CACHE_MS = 60 * 1000;
const visitMem = { v: null, at: 0, pending: [], lastFlush: 0 };
function applyVisitPending(v){
  for(const p of visitMem.pending){
    const day = v.days[p.date] = v.days[p.date] || { v: {}, w: {} };
    day.v = day.v || {}; day.w = day.w || {};
    day.v[p.key] = 1;
    if(p.kind === 'w') day.w[p.key] = 1;
  }
  return v;
}
async function getVisits(){
  if(visitMem.v && Date.now() - visitMem.at < VISIT_READ_CACHE_MS) return visitMem.v;
  visitMem.v = applyVisitPending(await loadVisits());
  visitMem.at = Date.now();
  return visitMem.v;
}
async function flushVisits(force){
  if(!visitMem.pending.length) return;
  if(!force && Date.now() - visitMem.lastFlush < VISIT_FLUSH_MS && visitMem.pending.length < VISIT_FLUSH_COUNT) return;
  const v = applyVisitPending(await loadVisits());
  await saveVisits(v);
  visitMem.pending = [];
  visitMem.v = v; visitMem.at = Date.now(); visitMem.lastFlush = Date.now();
}
async function recordVisit(key, kind){
  const v = await getVisits();
  const today = kstDateString(Date.now());
  const day = v.days[today] = v.days[today] || { v: {}, w: {} };
  const changed = !day.v[key] || (kind === 'w' && !day.w[key]);
  day.v[key] = 1;
  if(kind === 'w') day.w[key] = 1;
  if(changed){                                   // 이미 오늘 기록된 사람이면 저장할 것 없음
    visitMem.pending.push({ date: today, key, kind });
    try{ await flushVisits(false); }catch(e){ console.error('visits flush', e && e.message); }
  }
  return { date: today, ...visitStats(day) };
}
app.post('/api/visit', async (req, res) => {
  try{
    res.json(await recordVisit(visitorKey(req, (req.body || {}).visitorId), 'v'));
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/visit/today', async (req, res) => {
  try{
    flushVisits(false).catch(e => console.error('visits flush', e && e.message));
    const v = await getVisits();
    const today = kstDateString(Date.now());
    res.json({ date: today, ...visitStats(v.days[today]) });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 낙서 (일반, 결제 없음) ----------
app.post('/api/graffiti', async (req, res) => {
  const { accessToken, message, visitorId } = req.body || {};
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
    // 방문 통계에 '낙서한 사람'으로 표시 (실패해도 낙서 등록에는 영향 없음)
    try{ await recordVisit(visitorKey(req, visitorId), 'w'); }catch(e){ console.error('recordVisit error:', e); }
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

   require('./cosmos')(app, { put, get, verifyUser, kstDateString, LOGIN_EXPIRED });
   require('./news')(app);

app.listen(PORT, () => {
  console.log(`디부타데스 서버 실행 중: http://localhost:${PORT}`);
  if(!PI_API_KEY){
    console.warn('⚠️  PI_API_KEY 환경변수가 설정되지 않았습니다. 결제 기능이 동작하지 않습니다.');
  }
});
