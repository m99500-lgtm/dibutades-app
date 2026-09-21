[README (1).md](https://github.com/user-attachments/files/32448318/README.1.md)
디부타데스 (Pi Dibutades)
"거울은 사라지고 낙서는 남아요~ 흔적은 누군가의 맘을 울려요~"

Pi Network 생태계용 낙서 게시판 앱입니다. 일반 방문자는 부담 없이 낙서만 남길 수 있고, Pi 앱을 가진 개발자는 1 Pi를 내고 1주일(7일) 동안 자신의 앱을 디부타데스에 홍보할 수 있습니다.

**현재 실제 서비스 주소:** https://dibutades-app.vercel.app (Pi Developer Portal에 Mainnet 앱으로 등록된 URL)

1. 이 앱이 코어팀 정책을 지키도록 설계된 부분
지금까지 확인한 Pi 공식 정책을 기준으로 아래와 같이 반영했습니다.

정책	이 앱에서의 반영
외부 사이트/서비스로의 리다이렉트 제한	홍보 링크는 pi:// 스킴 또는 *.pinet.com 도메인만 허용 (프론트 + 백엔드 이중 검증)
불필요한 개인정보 수집 금지	이메일·전화번호 등 수집 안 함. 저장하는 건 Pi 계정 username, 낙서 내용, 홍보 문구뿐
앱이 완전히 작동해야 함	세 기능(낙서/보기/홍보) 모두 실제 동작하는 최소 기능으로 구현
개발자 KYC	앱 코드와는 별개로, 개발자 본인이 Pi Developer Portal에서 KYC를 완료해야 리스팅 신청 가능
Pi Ad Network vs 이 앱의 차이	이 앱은 공식 Pi Ad Network(제3자 광고주 대상, 별도 승인 필요)가 아니라, 개발자 간 자율 홍보 거래를 표준 U2A 결제로 구현한 것입니다. 별도의 Ad Network 심사 없이도 운영 가능합니다.
주의: 여기 반영된 내용은 지금까지 대화에서 검색으로 확인한 공개 문서 기준입니다. 정책은 코어팀 문서 업데이트에 따라 바뀔 수 있으니, 리스팅 신청 직전에 반드시 Pi Developer Portal의 최신 "Mainnet Listing Requirements" 페이지를 다시 확인하세요.

2. 로컬에서 실행해보기 (테스트넷)
```
npm install
PI_API_KEY=발급받은키 npm start
```
브라우저(또는 Pi Browser)에서 http://localhost:3000 접속. `public/index.html`의 `Pi.init({ version: "2.0" })` 호출부는 Pi Browser 안에서만 정상 동작합니다 (Pi SDK가 로드되지 않는 일반 브라우저에서는 로그인/결제 기능이 비활성화됨).

3. 배포 구조 (Vercel)
현재 GitHub 저장소(`m99500-lgtm/dibutades-app`)가 Vercel 프로젝트 `dibutades-app`과 연결되어 있어, `main` 브랜치에 커밋할 때마다 자동으로 재배포됩니다.

- `public/index.html` — 프론트엔드 전체 (HTML/CSS/JS 단일 파일)
- `server.js` — Express 백엔드 (Vercel 서버리스 함수로 실행됨, `index.js`가 이를 감싸서 노출)
- `vercel.json` — 모든 요청을 `/api/index`로 라우팅, 응답에 `Cache-Control: no-cache, no-store, must-revalidate` 헤더를 강제해 배포할 때마다 브라우저/웹뷰에 옛날 버전이 남는 문제를 방지
- `validation-key.txt` (public 폴더 내) — Pi Developer Portal 도메인 소유권 검증용

**환경변수 (Vercel → Settings → Environment Variables)**
- `PI_API_KEY` — Pi Developer Portal에서 발급받은 서버 API 키 (결제 승인/완료 요청에 사용)
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob Store(`dibutades-app-blob`, Private) 연결 시 자동 생성되는 토큰. 낙서·홍보 데이터를 이 Blob에 저장함 (아래 "데이터 저장 방식" 참고)

4. 데이터 저장 방식
Vercel의 서버리스 환경은 파일시스템이 읽기 전용이라, 로컬 JSON 파일(`data.json`) 저장 방식은 `EROFS` 에러로 동작하지 않습니다. 그래서 **Vercel Blob(Private Store)**에 낙서·홍보 데이터를 JSON 하나로 통째로 읽고 쓰는 방식으로 구현되어 있습니다.

- 저장 위치: Blob Store `dibutades-app-blob`, 파일명 `dibutades-data.json`
- 구조: `{ graffiti: [], promos: [], lastPostAt: {}, streaks: {} }`
- 알려진 한계: 두 사람이 거의 동시에 낙서를 올리면, 전체를 읽고-고쳐서-다시 쓰는 방식(read-modify-write) 특성상 나중에 저장한 쪽이 먼저 저장된 낙서를 덮어쓸 수 있습니다. 트래픽이 늘면 Supabase/Firestore 같은 실제 데이터베이스로 옮기는 걸 고려하세요.

5. Pi Developer Portal 실제 등록 절차 (순서대로)
1단계. 앱을 웹에 호스팅하기 — 완료 (Vercel, 위 3번 참고)
2단계. Pi Browser에서 개발자 포털 접속 — `pi://develop.pi` (Pi Browser 안에서만 열림)
3단계. 개발자 본인 KYC 완료
4단계. 메인넷용 앱 등록 — App Network를 Mainnet으로 선택 (테스트넷 앱과는 별개 항목)
5단계. 앱 지갑 연결 및 API 키 발급 → Vercel 환경변수 `PI_API_KEY`에 입력
6단계. Mainnet Ecosystem Listing 신청서 작성 및 제출 (아래 6번 섹션 참고)
7단계. 심사 대기 → 승인 후 Pi Browser Ecosystem/Explore 메뉴에 노출 시작
(선택) 8단계. 나중에 공식 Pi Ad Network까지 확장하고 싶다면, 리스팅된 앱을 Developer Portal에서 선택 → "Dev Ad Network" 신청

6. Developer Portal에 실제로 작성해야 하는 글 (예시 초안)
정확한 입력 항목명은 Developer Portal 화면 업데이트에 따라 달라질 수 있지만, 보통 아래 항목들을 요구합니다.

**앱 이름 (App Name)**
디부타데스 (Dibutades)

**짧은 소개 / 태그라인**
누구나 편하게 낙서를 남기고, 개발자는 자신의 Pi 앱을 홍보할 수 있는 커뮤니티 공간입니다.

**상세 설명 (Full Description)**
디부타데스는 세 가지 기능으로 구성된 Pi 생태계 커뮤니티 앱입니다.

1. 쓰기 — 매일 바뀌는 질문에 답하며 짧은 낙서(메시지)를 남깁니다. Pi 로그인이 필요하며, 붙여넣기·드래그 입력은 차단되어 있습니다. 연속으로 작성한 날짜에 따라 스트릭이 표시됩니다.
2. 둘러보기 — 낙서만 조용히 볼 수 있는 별도의 명상형 화면입니다. 다른 사람의 낙서에 하트/엄지척/기도/기쁨/슬픔 중 하나로 반응을 남길 수 있고, 조회수 기준 인기 낙서 TOP5도 확인할 수 있습니다.
3. 앱 — Pi 생태계 안의 다른 개발자가 1 Pi를 지불하고 자신의 앱을 1주일간 홍보할 수 있습니다. 홍보 링크는 Pi 생태계 앱(pi:// 또는 *.pinet.com)만 허용됩니다.

이메일, 전화번호 등 개인정보는 수집하지 않으며, Pi 계정의 공개 닉네임과 사용자가 직접 작성한 낙서 내용만 저장합니다. 모든 결제는 Pi 공식 결제(U2A)로 처리됩니다.

**카테고리 (Category)**
커뮤니티 / 소셜 (Community / Social)

**호스팅 URL**
https://dibutades-app.vercel.app

**요청 권한 (Scopes)**
username, payments

**개인정보 처리 관련 문구**
수집 항목: Pi 계정 공개 사용자명(username), 사용자가 작성한 게시물 내용
수집하지 않는 항목: 이메일, 전화번호, 위치정보, 기타 개인식별정보

**지원/문의 연락처**
(로저님이 공개해도 괜찮은 연락 채널 — 예: X 계정 링크)

7. 화면 구성
- **헤더**: 디부타데스 로고 + soSOso 애니메이션(평소엔 거울 속에서 정지, 페이지 로드 시·낙서 성공 시에만 한 번씩 인사) + 라이트/다크 모드 전환 버튼(초승달 아이콘)
- **왼쪽**: 한국(서울) 포함 5개국 실시간 시계
- **오른쪽**: PI 실시간 가치(CoinGecko 공개 API, 1분마다 갱신) → 런치패드 TOP5 → 스테이킹 TOP5
- **쓰기 탭**: 메인화면 안에서 폼 작성. 성공 시 스트릭 뱃지 표시
- **둘러보기 / 앱 탭**: 각각 별도의 서브화면으로 전환됨 (좌우 시계·Pi 패널 숨김, 헤더는 로고+soSOso만 남김). 하단에 "메인화면으로 돌아가기" 버튼. 브라우저/웹뷰의 뒤로가기를 눌러도 앱을 바로 나가지 않고 먼저 메인화면으로만 돌아오도록 History API로 처리되어 있음
- **도배 방지**: 같은 Pi 계정이 20초 안에 다시 게시하면 서버에서 차단
- **욕설/스팸 필터**: 서버(`server.js`)의 `BANNED_WORDS` 배열 기준 기본 필터링 + 같은 문자 반복, 링크 과다 게시 차단 (운영하며 계속 단어 추가 권장)

**알려진 미해결 이슈**: 일부 모바일 임베디드 브라우저(Pi Browser, 네이버 인앱 브라우저 등)에서 라이트/다크 모드 전환 버튼이 동작하지 않는 문제가 있음. PC 브라우저에서는 정상 동작 확인됨 — 원인 추적 중, 추후 재조사 예정.

8. 다음에 보완하면 좋은 부분
- 데이터 저장을 Vercel Blob(단일 JSON, read-modify-write 방식) → 실제 데이터베이스로 교체 (동시 쓰기 충돌 방지, 트래픽 증가 대비)
- 라이트/다크 모드 토글이 모바일 웹뷰에서 안 되는 문제 원인 규명
- 낙서 수가 많아졌을 때를 대비한 페이지네이션
- 홍보 링크 자동 검증(도메인 패턴)에 더해, 운영자가 수동으로 한 번 더 확인하는 승인 큐 추가하면 신뢰도 향상
