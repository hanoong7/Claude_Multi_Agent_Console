# Claude Multi-Agent Console &nbsp;·&nbsp; v0.1.0

내 컴퓨터에서 돌아가는 데스크탑 / 웹 UI로, **본인 Claude Code 구독**을 멀티 에이전트 시스템으로 활용할 수 있게 해줍니다. 오케스트레이터 + 전문가 워커들 + 팀 + 다중 세션 — 전부 채팅 한 곳에서 조율됩니다.

전부 로컬에서 동작합니다. **본인** Claude Code OAuth 로그인을 그대로 씁니다 (사용량은 본인 Pro/Max 플랜에서 차감, **API 키 필요 없음**).

---

## 주요 기능

- **오케스트레이터 채팅** — 위임을 라우팅하는 최상위 Claude와 대화
- **워커** — 전문가 정의 (planner / coder / reviewer / researcher / qa / custom). 각자 역할 프롬프트, 모델, 도구 권한을 따로 설정 가능
- **팀** — 워커들을 그룹화 (예: `coding-team` = planner + coder + reviewer). 오케스트레이터가 한 요청에 팀 전체를 가동
- **자동 워크플로** — 코드 요청에는 계획 → 구현 → 리뷰 → 수정 루프가 자동으로 돎
- **세션 & 히스토리** — 여러 채팅 thread를 탭으로 전환, 재시작에도 유지
- **활동 패널** — 각 위임이 카드로 표시 (워커 이름, 색, 진행률, 결과)
- **상태 미리보기** — 예정 / 진행중 / 완료 열로 분류. 위임 전에 오케스트레이터가 계획을 먼저 선언
- **상단 정보 바** — 로그인한 이메일·요금제·작업 디렉토리 즉시 확인

빈 상태로 시작합니다 — 본인 팀과 워커를 직접 정의하세요.

---

## 공통 요구사항

| 무엇                   | 왜                          | 설치                                 |
| --------------------- | --------------------------- | ----------------------------------- |
| **Node.js 20+**       | 런타임                       | <https://nodejs.org>                |
| **Claude Code CLI**   | 실제 Claude가 돌아가는 도구  | <https://claude.com/code>           |
| **Claude Pro / Max**  | Claude Code 로그인에 필요   | <https://claude.ai/pricing>         |
| **Git**               | 레포 클론                    | <https://git-scm.com>               |

**Claude Code 로그인 (한 번만)** — 어느 OS든 동일:

```bash
claude
```

브라우저가 열리며 OAuth 진행. 본인 Claude 계정으로 로그인. 확인:

```bash
claude auth status
```

`"loggedIn": true` 보이면 OK.

---

## Quick start 1. 로컬 Windows 단독 (Electron 데스크탑 앱)

PowerShell 또는 cmd:

```powershell
git clone https://github.com/hanoong7/Claude_Multi_Agent_Console.git
cd Claude_Multi_Agent_Console
npm install
npm start
```

Electron 창이 열립니다. 끝.

---

## Quick start 2. GUI 없는 Linux 서버 + 로컬 Windows (Electron이 원격 서버 가리킴)

서버에 Claude Code CLI를 깔고 로그인한 상태에서, 로컬 Windows의 데스크탑 창으로 사용하는 패턴. **명령 한 줄로 SSH 터널 + 원격 서버 시작 + Electron 창**까지 자동.

### A. 원격 Linux 서버 (한 번만, 인터넷에 클론만)

```bash
git clone https://github.com/hanoong7/Claude_Multi_Agent_Console.git
```

> 서버를 직접 띄울 필요 없어요. 로컬에서 `npm run start:remote` 할 때 자동으로 띄워줍니다.

### B. 로컬 Windows (한 번만 셋업)

```powershell
git clone https://github.com/hanoong7/Claude_Multi_Agent_Console.git
cd Claude_Multi_Agent_Console
npm install
```

**SSH 키 인증이 셋업돼 있어야 함** — `ssh <user>@<server>` 했을 때 비밀번호 안 물어보고 바로 들어가야 합니다 (자동화의 전제). 안 돼있으면 `ssh-keygen` + `ssh-copy-id` 한 번 해두세요.

**`~/.ssh/config`에 호스트 별칭 추가** (필수는 아니지만 편함):
```
Host myserver
    HostName <서버주소>
    Port <SSH포트>
    User <user>
```

### C. 사용할 때마다 — 명령 한 줄

```powershell
$env:REMOTE_SSH="myserver"; npm run start:remote
```

또는 SSH config 별칭 없이:
```powershell
$env:REMOTE_SSH="user@server.example.com"; npm run start:remote
# 비표준 SSH 포트면
$env:REMOTE_SSH="-p 22022 user@server"; npm run start:remote   # ← 따옴표 안에 그대로
```

이 명령이 자동으로:
1. SSH 터널 열어서 8787 포트 포워딩
2. 원격에서 `./start.sh` 실행
3. /health 응답 확인 (최대 30초 대기)
4. Electron 창 띄우면서 `REMOTE_URL` 자동 설정
5. 창 닫으면 SSH 터널 + 원격 서버 같이 정리

### 환경변수 옵션

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `REMOTE_SSH` | (필수) | SSH 별칭 또는 `user@host` |
| `REMOTE_PATH` | `Claude_Multi_Agent_Console` | 원격에 클론한 경로 |
| `LOCAL_PORT` | `8787` | 로컬 포트 |
| `REMOTE_PORT` | `8787` | 원격 서버 포트 |

---

## 사용법

### 첫 실행

빈 상태로 시작합니다. 좌측 상단 `+ team` 버튼으로 팀 만들고, 팀 헤더에 마우스 올려서 `+ member` 로 멤버 추가.

### 본인 팀 정의

1. `+ team` 클릭 → 이름 + 목적 ("언제 이 팀을 부를지?")
2. 팀 헤더 hover → `+ member` → 멤버 정의:
   - **kind**: researcher / coder / reviewer / planner / qa / custom (기본 역할 프롬프트 자동 채워짐)
   - **role**: 그 워커의 시스템 프롬프트
   - **model**: opus / sonnet / haiku / inherit
   - **effort**: low / medium / high / xhigh / max
   - **permission**: 도구 실행 권한 (아래 참고)
3. 오케스트레이터 시스템 프롬프트가 자동으로 팀과 워크플로를 인지

**추천 시작 셋업**: `coding-team` 만들고 안에 planner(kind=planner) / coder(kind=coder) / reviewer(kind=reviewer) 3명 추가. 이 조합이면 코드 요청 시 자동으로 plan → code → review → fix-loop 워크플로 가동.

### 권한 모드

| 모드                  | 동작                                                          |
| -------------------- | ------------------------------------------------------------ |
| `default`            | Claude Code 기본. 프롬프트 뜰 수 있음 — 헤드리스에선 비추.       |
| `acceptEdits`        | 파일 편집 + 기본 fs 명령 자동 허용 (Bash `git` 같은 거)         |
| `bypassPermissions`  | ⚠ 모든 권한 체크 스킵. 신뢰하는 워크플로일 때.                  |
| `plan`               | 읽기 전용 계획 모드                                            |
| `dontAsk`            | allowlist 외 모두 거부 (CI 스타일로 잠긴 모드)                  |

코드 작성 워크플로엔 워커에 `acceptEdits` 권장. 도구 prompt에 자꾸 막히면 오케스트레이터를 `bypassPermissions`로 올리세요.

### 작업 디렉토리 (workspace)

기본적으로 오케스트레이터와 워커들은 `app.js` 옆 `./workspace/` 안에서 작업합니다. 생성하는 파일이 여기 떨어집니다. 상단 정보 바에 현재 경로 표시 (📁 아이콘).

다른 디렉토리에서 작업하게 하려면 실행 전에 `CLAUDE_CWD` 환경변수 설정:

**Windows PowerShell**

```powershell
$env:CLAUDE_CWD="C:\path\to\my\project"; npm start
```

**Linux**

```bash
CLAUDE_CWD=/path/to/my/project npm start
```

### 포트

기본 `8787`. 바꾸려면 `PORT=...` 환경변수 설정.

---

## 파일/폴더 구조

```
release-folder/
├── app.js              ← 번들된 서버 (수정 불가)
├── electron-main.mjs   ← 데스크탑 앱 진입점
├── public/             ← UI 에셋 (수정 불가)
├── data/               ← 본인 팀/워커/세션/설정 (자동 생성)
│   ├── agents.json
│   └── sessions/
│       └── <session-uuid>.jsonl
└── workspace/          ← Claude/워커가 만드는 파일 (자동 생성)
```

`data/`와 `workspace/`는 gitignored — 자유롭게 수정/삭제해도 됨.

---

## 트러블슈팅

**"Claude is not logged in" 배너** — 터미널에서 `claude` 한 번 실행, 로그인 후 페이지 새로고침.

**"Claude CLI not installed" 배너** — <https://claude.com/code> 에서 설치 → 셸 재시작 → 재시도.

**채팅에 "claude exited (1)..."** — 권한 또는 인증 이슈. `claude auth status`로 로그인 확인. 도구 호출이 계속 실패하면 오케스트레이터 권한을 `bypassPermissions`로 변경.

**워커가 워크플로 무시 / 위임 안 함** — 각 워커의 `description`이 트리거 키워드를 포함하는지 확인. 그리고 팀에 `planner / coder / reviewer` 기본 kind들이 있어야 자동 워크플로가 동작.

**포트 점유 충돌** — `PORT=...` 로 다른 포트 사용.

**완전히 처음부터 다시** — 앱 끄고 `data/` (선택적으로 `workspace/`도) 삭제, 다시 실행.

---

## 비용 & 프라이버시

- 모든 Claude 호출은 **본인** 머신에서 **본인** Claude Code 로그인을 통해 Anthropic으로 직접 갑니다.
- 사용량은 본인 Pro/Max 플랜에서 차감.
- 채팅 히스토리, 에이전트 정의, 워커 출력 모두 본인 디스크의 `data/`에만 저장. 어디로도 업로드되지 않음.

---

## 한계 / 알려진 이슈

- **소스 코드는 포함되지 않음.** 사전 빌드 번들입니다.
- 같은 서버에 여러 브라우저 탭을 띄우면 한 백엔드 연결을 공유 — 동작은 하지만 세션 간 동시 실행은 안 됨
- "예정 (pending)" 미리보기는 오케스트레이터가 지시를 따라야 동작. 가끔 plan 태그를 빼먹습니다.
- 모바일 레이아웃 없음
- 왼쪽 패널 너비 조정은 가능한데 새로고침하면 초기화

---

## 라이센스

MIT — `LICENSE` 참고.
