<p align="center">
  <img src="assets/dori-mattermost.png" alt="Mattermost 로고 셔츠를 입고 노트북을 든 강아지 Dori" width="320">
</p>

# dori-mattermost

[dori-superagent](https://github.com/sisyphuslabs/dori-superagent)의 Dori mode에 Mattermost 연결을 더하는 추가 패키지입니다. 이 저장소에는 Mattermost 부분만 들어 있고, Dori 본체는 설치할 때 원본 저장소에서 받습니다.

## 무엇이 추가되나

| 명령 | 하는 일 |
|---|---|
| `dori send mattermost` | 채널에 글 쓰기, 스레드 답장, 파일 첨부, 글 수정 |
| `dori inbound mattermost --loop 0.25` | 사장님(owner)의 새 글과 수정을 15초마다 읽어 `INBOUND` 줄로 출력하고, 새 글에 eyes 반응 |
| `dori typing mattermost` | 답을 쓰는 동안 "입력 중" 표시 |
| `dori presence mattermost` | 봇을 접속 중(online)으로 유지 |
| `dori thread mattermost` | 스레드 상태를 `[working]`, `[waiting]`, `[done]` 표시로 관리 (Mattermost 스레드에는 이름이 없어서 Dori의 상태 글 앞에 붙임) |
| `dori download mattermost` | 받은 파일 저장, 음성 메모는 `dori transcribe`로 이어서 변환 |
| `dori boot` | `MATTERMOST authenticated ...` 줄로 봇 인증 확인 |

스레드 참조 형식은 `mattermost:<채널 ID>:<루트 글 ID>`입니다. 명령별 자세한 설명은 설치 후 `~/.dori/src/skills/dori-mode/references/scripts.md`에 있습니다.

## 구성

- `overlay/`: Dori 체크아웃에 그대로 복사되는 새 파일 (Mattermost 클라이언트, 받기, CLI, boot 확인, 테스트)
- `patches/dori-superagent.patch`: 기존 Dori 파일 7개에 Mattermost를 연결하는 수정 (CLI 연결부, boot, 파일 다운로드용 http, 문서)
- `UPSTREAM`: 이 패치를 만든 Dori 커밋
- `install.sh`: 설치, 업데이트, 제거

## 설치

필요한 것: git, Bun 1.4.4 이상, herdr, gh (Dori 본체 요구사항과 같음)

```sh
git clone https://github.com/AkaKSR/dori-mattermost
bash dori-mattermost/install.sh
```

Dori가 없으면 원본 설치 스크립트로 먼저 설치한 뒤 Mattermost 부분을 덧씌웁니다. 다시 실행하면 Mattermost 부분을 뺐다가 Dori를 원본 최신으로 올리고 다시 넣습니다. 원본이 바뀌어 패치가 맞지 않으면 아무것도 덮어쓰지 않고 멈춥니다.

제거: `bash dori-mattermost/install.sh --remove`

## 설정

1. Mattermost에서 봇 계정을 만들고(System Console > Integrations > Bot Accounts) 토큰을 파일로 저장합니다: `chmod 600 ~/.dori/mattermost.token`
2. 봇을 Dori가 읽고 쓸 채널에 초대합니다.
3. 셸 환경(`~/.zshenv` 등)에 넣습니다:

```sh
export DORI_MATTERMOST_URL=https://mattermost.example.com
export DORI_MATTERMOST_TOKEN_FILE="$HOME/.dori/mattermost.token"   # 또는 DORI_MATTERMOST_TOKEN
export DORI_MATTERMOST_OWNER_ID=<사장님 사용자 ID>                # 이 사람의 글만 요청으로 받음
export DORI_MATTERMOST_IGNORE=town-square                           # 읽지 않을 채널 이름이나 ID (쉼표 구분)
export DORI_MATTERMOST_BLOCKED=<채널 또는 루트 글 ID,...>           # 절대 쓰지 않을 곳 (보내면 종료 코드 3)
```

사용자 ID는 `curl -H "Authorization: Bearer <토큰>" $DORI_MATTERMOST_URL/api/v4/users/username/<아이디>`의 `id`입니다.

4. `~/.dori/config.json`의 `hooks`에 lane 보고와 완료 처리를 연결합니다:

```json
"hooks": {
  "threadReply": ["dori", "send", "mattermost", "--thread", "{thread}", "--text", "{text}"],
  "threadDone": ["dori", "thread", "mattermost", "{thread}", "--status", "done", "--note", "{text}"]
}
```

5. `dori boot`에서 `MATTERMOST authenticated`가 나오면 준비가 끝난 것입니다. herdr 안의 코딩 에이전트에게 "Dori mode"라고 말하면, 에이전트가 `dori inbound mattermost --loop 0.25`를 받기 감시로 띄우고 Mattermost로 대화합니다.

## 라이선스

Dori 본체는 원본의 Sustainable Use License를 따르며 이 저장소에 포함되어 있지 않습니다. 패치에는 원본 파일의 수정 위치를 찾기 위한 앞뒤 몇 줄만 들어 있습니다.
