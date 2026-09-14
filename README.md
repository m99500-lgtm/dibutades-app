# 낙서벽 (Pi Graffiti Wall)

"낙서를 하자, 낙서를 보자, 나의 앱을 홍보하자"

Pi Network 생태계용 낙서 게시판 앱입니다. 일반 방문자는 부담 없이 낙서만 남길 수 있고,
Pi 앱을 가진 개발자는 1 Pi를 내고 24시간 동안 자신의 앱을 낙서벽에 홍보할 수 있습니다.

---

## 1. 이 앱이 코어팀 정책을 지키도록 설계된 부분

지금까지 확인한 Pi 공식 정책을 기준으로 아래와 같이 반영했습니다.

| 정책 | 이 앱에서의 반영 |
|---|---|
| 외부 사이트/서비스로의 리다이렉트 제한 | 홍보 링크는 `pi://` 스킴 또는 `*.pinet.com` 도메인만 허용 (프론트 + 백엔드 이중 검증) |
| 불필요한 개인정보 수집 금지 | 이메일·전화번호 등 수집 안 함. 저장하는 건 Pi 계정 username, 낙서 내용, 홍보 문구뿐 |
| 앱이 완전히 작동해야 함 | 세 기능(낙서/보기/홍보) 모두 실제 동작하는 최소 기능으로 구현 |
| 개발자 KYC | 앱 코드와는 별개로, **개발자 본인**이 Pi Developer Portal에서 KYC를 완료해야 리스팅 신청 가능 |
| Pi Ad Network vs 이 앱의 차이 | 이 앱은 공식 Pi Ad Network(제3자 광고주 대상, 별도 승인 필요)가 아니라, **개발자 간 자율 홍보 거래**를 표준 U2A 결제로 구현한 것입니다. 별도의 Ad Network 심사 없이도 운영 가능합니다. |

**주의**: 여기 반영된 내용은 지금까지 대화에서 검색으로 확인한 공개 문서 기준입니다.
정책은 코어팀 문서 업데이트에 따라 바뀔 수 있으니, 리스팅 신청 직전에 반드시
Pi Developer Portal의 최신 "Mainnet Listing Requirements" 페이지를 다시 확인하세요.

---

## 2. 로컬에서 실행해보기 (테스트넷)

```bash
cd pi-graffiti
npm install
PI_API_KEY=발급받은키 npm start
```

브라우저(또는 Pi Browser)에서 `http://localhost:3000` 접속.
`index.html`의 `Pi.init({ version: "2.0", sandbox: true })`는 테스트넷 개발용입니다.

---

## 3. 실제 등록 절차 (테스트넷 → 메인넷 → 홍보 결제 활성화)

### 1단계. 앱을 웹에 호스팅하기
Pi 앱은 HTTPS로 접근 가능한 웹사이트여야 합니다. Vercel, Netlify 등 무료 호스팅도 가능합니다.
- `public/index.html`을 정적 호스팅하고, `server.js`는 별도 Node 서버(Render, Railway 등)에 배포
- `index.html`의 `API_BASE`를 실제 백엔드 주소로 수정

### 2단계. Pi Developer Portal에서 메인넷용 앱 새로 등록
1. Pi Browser 앱에서 `pi://develop.pinet.com` 접속 (Pi Browser 안에서만 열림)
2. "New App" 클릭
3. **App Network를 Mainnet으로 선택** — 한 번 정하면 나중에 바꿀 수 없으므로, 지금 쓰던 테스트넷 앱과는
   별개로 새 앱 항목을 만들어야 합니다
4. 앱 이름, 설명, 호스팅 URL(1단계에서 배포한 주소) 입력

### 3단계. 개발자 본인 KYC 완료
- Pi Developer Portal 또는 Pi 앱 내 KYC 메뉴에서 진행
- 이미 완료하셨다면 이 단계는 건너뜁니다

### 4단계. 앱 지갑 연결 및 코드 연동
- Developer Portal의 "App Checklist"를 따라 앱 전용 지갑 생성/연결
- `server.js`의 `PI_API_KEY` 환경변수에 발급받은 서버 API 키 입력

### 5단계. Mainnet Ecosystem Listing 신청
- Developer Portal에서 리스팅 신청서 제출
- 심사 기준: 앱 완전 작동 여부, 불필요한 개인정보 미수집, 외부 링크 최소화(이 앱은 이미 pinet.com/pi:// 만 허용하도록 구현됨)
- 승인까지 기간은 코어팀 심사 일정에 따라 달라질 수 있음

### 6단계. 리스팅 승인 후 앱 실사용 시작
- Pi Browser의 Ecosystem/Explore 메뉴에서 앱 노출 시작
- 이 시점부터 "낙서하기"·"낙서 보기"·"1 Pi 홍보 결제" 기능이 실제 Pi로 동작

### (선택) 7단계. 나중에 공식 Pi Ad Network까지 확장하고 싶다면
- 이 앱과는 별개 절차: 리스팅된 앱을 Developer Portal에서 선택 → "Dev Ad Network" 신청 →
  3단계 광고 체크리스트 완료 → 신청서 제출
- 이건 "개발자 간 홍보 마켓"이 자리 잡은 뒤 추가로 고려할 수 있는 확장 옵션입니다

---

## 4. 다음에 보완하면 좋은 부분

- `data.json` 파일 저장 → 실제 데이터베이스로 교체 (동시 접속자 늘어나면 파일 저장은 한계가 있음)
- 홍보 링크 자동 검증(도메인 패턴)에 더해, 운영자가 수동으로 한 번 더 확인하는 승인 큐 추가하면 신뢰도 향상
- 낙서 도배/욕설 방지를 위한 간단한 빈도 제한(rate limit) 또는 신고 기능
