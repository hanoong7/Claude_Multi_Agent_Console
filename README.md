# Claude Multi-Agent Console

내 컴퓨터에서 돌아가는 웹 UI로, **본인 Claude Code 구독**을 멀티 에이전트 시스템으로 활용할 수 있게 해줍니다. 오케스트레이터 + 전문가 워커들 + 팀 + 다중 세션 — 전부 채팅 한 곳에서 조율됩니다.

전부 로컬에서 동작합니다. **본인** Claude Code OAuth 로그인을 그대로 씁니다 (사용량은 본인 Pro/Max 플랜에서 차감, **API 키 필요 없음**).

> 상태: pre-alpha 데모. 지인용. 거친 부분 있어요.

---

## 주요 기능

- **오케스트레이터 채팅** — 위임을 라우팅하는 최상위 Claude와 대화
- **워커** — 전문가 정의 (planner / coder / reviewer / researcher / qa / custom). 각자 역할 프롬프트, 모델, 도구 권한을 따로 설정 가능
- **팀** — 워커들을 그룹화 (예: `coding-team` = planner + coder + reviewer). 오케스트레이터가 한 요청에 팀 전체를 가동
- **자동 워크플로** — 코드 요청에는 계획 → 구현 → 리뷰 → 수정 루프가 자동으로 돎
- **세션 & 히스토리** — 여러 채팅 thread를 탭으로 전환, 재시작에도 유지
- **활동 패널** — 각 위임이 카드로 표시 (워커 이름, 색, 진행률, 결과)
- **상태 미리보기** — 예정 / 진행중 / 완료 열로 분류. 위임 전에 오케스트레이터가 계획을 먼저 선언

데모 상태가 같이 들어있어요 (한국어 팀/워커 예시) — 어떻게 세팅하는지 바로 볼 수 있습니다.

---

## 요구사항

| 무엇                   | 왜                          | 설치                                 |
| --------------------- | --------------------------- | ----------------------------------- |
| **Node.js 20+**       | 로컬 서버 런타임             | <https://nodejs.org>                |
| **Claude Code CLI**   | 실제 Claude가 돌아가는 도구  | <https://claude.com/code>           |
| **Claude Pro / Max**  | Claude Code 로그인에 필요   | <https://claude.ai/pricing>         |

macOS, Linux, Windows (10/11) 모두 지원.

---

## 설치

```bash
git clone https://github.com/hanoong7/Claude_Multi_Agent_Console.git
cd Claude_Multi_Agent_Console
```

끝. **npm 설치 단계 없음** — 서버는 이미 번들된 상태로 들어있습니다.

---

## 처음 한 번만 설정

**1. Claude Code 로그인** (아무 터미널에서 한 번만):

```bash
claude
```

브라우저가 열리면서 OAuth 진행됩니다. 본인 Claude 계정으로 로그인하세요. 끝나면 터미널 닫아도 됩니다. 이 머신의 다른 Claude 도구들 (이 앱 포함)도 같은 로그인을 씁니다.

확인:

```bash
claude auth status
```

`"loggedIn": true` 가 보이면 OK.

**2. 콘솔 실행**:

### macOS / Linux

```bash
./start.sh
```

### Windows

`start.bat` 더블클릭, 또는 PowerShell / cmd:

```cmd
start.bat
```

런처가 이런 출력을 보여줍니다:

```
[seed] copied examples/agents.json → data/agents.json
[server] listening on :8787  cwd=.../workspace
[server] open http://localhost:8787 in your browser
[auth] OK · you@example.com · max
```

브라우저에서 <http://localhost:8787> 열기.

---

## 사용법

### 포함된 데모로 먼저 둘러보기

배포 패키지에 예제 팀들 (`coding-team` 등)과 과거 채팅 세션 몇 개가 들어있습니다. 클릭해보면서 구조를 익혀보세요. 깨끗하게 시작하려면:

- 탭의 **✕** 로 세션 삭제
- 또는 통째로 초기화: 서버 끄고 `app.js` 옆 `data/`와 `workspace/` 폴더 삭제, 다시 실행 — `examples/`에서 자동으로 다시 시드

### 본인 팀 정의

1. 왼쪽 위 `+ team` 클릭 → 이름 + 목적 ("언제 이 팀을 부를지?")
2. 팀 헤더에 마우스 올리면 → `+ member` → 멤버 정의:
   - **kind**: researcher / coder / reviewer / planner / qa / custom (기본 역할 프롬프트 자동 채워짐)
   - **role**: 그 워커의 시스템 프롬프트
   - **model**: opus / sonnet / haiku / inherit (워커마다 다르게 가능)
   - **effort**: low / medium / high / xhigh / max (추론 깊이)
   - **permission**: 도구 실행 권한 (아래 참고)
3. 오케스트레이터 시스템 프롬프트가 자동으로 팀과 워크플로를 인지하게 업데이트됨

### 권한 모드

각 워커 (그리고 오케스트레이터)에 권한 모드 지정 가능:

| 모드                  | 동작                                                          |
| -------------------- | ------------------------------------------------------------ |
| `default`            | Claude Code 기본. 프롬프트 뜰 수 있음 — 헤드리스에선 비추.       |
| `acceptEdits`        | 파일 편집 + 기본 fs 명령 자동 허용 (Bash `git` 같은 거)         |
| `bypassPermissions`  | ⚠ 모든 권한 체크 스킵. 신뢰하는 워크플로일 때.                  |
| `plan`               | 읽기 전용 계획 모드                                            |
| `dontAsk`            | allowlist 외 모두 거부 (CI 스타일로 잠긴 모드)                  |

코드 작성이 들어가는 워크플로는 워커에 `acceptEdits` 권장. 오케스트레이터가 도구 prompt에 자꾸 막히면 `bypassPermissions`로 올리세요.

### 작업 디렉토리 (workspace)

기본적으로 오케스트레이터와 워커들은 `app.js` 옆 `./workspace/` 안에서 작업합니다. 생성하는 파일 (예: 자동 생성된 `fizzbuzz.py`)이 여기 떨어집니다.

다른 디렉토리 (본인 프로젝트 등)에서 작업하게 하려면 실행 전에 `CLAUDE_CWD` 환경변수 설정:

**macOS / Linux**

```bash
CLAUDE_CWD=/path/to/my/project ./start.sh
```

**Windows (cmd)**

```cmd
set CLAUDE_CWD=C:\path\to\my\project
start.bat
```

### 포트

기본 `8787`. 바꾸려면 `PORT=9000 ./start.sh` (Windows는 `PORT` 환경변수 set).

---

## 파일/폴더 구조

```
release-folder/
├── app.js              ← 번들된 서버 (수정 불가)
├── public/             ← UI 에셋 (수정 불가)
├── examples/           ← 시드 데이터, 첫 실행 시 data/로 복사됨
├── data/               ← 본인 팀/워커/세션/설정 (자동 생성)
│   ├── agents.json
│   └── sessions/
│       └── <session-uuid>.jsonl   ← 세션별 채팅+활동 로그
└── workspace/          ← Claude/워커가 만드는 파일 (자동 생성)
```

`data/`와 `workspace/`는 gitignored — 자유롭게 수정/삭제해도 됨.

---

## 트러블슈팅

**"Claude is not logged in" 배너** — 터미널에서 `claude` 한 번 실행, 로그인 후 페이지 새로고침.

**"Claude CLI not installed" 배너** — <https://claude.com/code> 에서 설치 → 셸 재시작 → 재시도.

**채팅에 "claude exited (1)..."** — 권한 또는 인증 이슈. `claude auth status`로 로그인 확인. 도구 호출이 계속 실패하면 오케스트레이터 권한을 `bypassPermissions`로 변경.

**워커가 워크플로 무시 / 위임 안 함** — 각 워커의 `description`이 트리거 키워드를 포함하는지 확인 ("Use this team for any code change..." 식). 그리고 팀에 `planner / coder / reviewer` 기본 kind들이 있어야 자동 워크플로가 동작합니다.

**포트 점유 충돌** — `PORT=...` 로 다른 포트 사용.

**완전히 처음부터 다시** — 서버 끄고 `data/` (선택적으로 `workspace/`도) 삭제, 다시 실행.

---

## 비용 & 프라이버시

- 모든 Claude 호출은 **본인** 머신에서 **본인** Claude Code 로그인을 통해 Anthropic으로 직접 갑니다. 중간에 거치는 서버 없음.
- 사용량은 본인 Pro/Max 플랜에서 차감 (Claude Code에 API 키를 설정해뒀다면 거기서).
- 채팅 히스토리, 에이전트 정의, 워커 출력 모두 본인 디스크의 `data/`에만 저장. 어디로도 업로드되지 않음.
- `examples/` 안의 예제 데이터는 개발 중에 만들어진 거고 참고용으로 포함됩니다. 삭제해도 됩니다 — `data/`가 비어있을 때만 다시 시드.

---

## 한계 / 알려진 이슈

- **소스 코드는 포함되지 않음.** 데모용 사전 빌드 번들입니다.
- 같은 서버에 여러 브라우저 탭을 띄우면 한 백엔드 연결을 공유 — 동작은 하지만 세션 간 동시 실행은 안 됨 (세션별 큐는 있음)
- "예정 (pending)" 미리보기는 오케스트레이터가 지시를 따라야 동작. 가끔 plan 태그를 빼먹습니다.
- 모바일 레이아웃 없음
- 왼쪽 패널 너비 조정은 가능한데 새로고침하면 초기화

---

## 라이센스

MIT — `LICENSE` 참고.
