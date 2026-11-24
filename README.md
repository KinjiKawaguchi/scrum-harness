# scrum-harness

Claude Code でスクラムを回すときに、TechLead のセッションが GitHub Project のボードのずれと部下の空きに「自分から見に行かなくても」気づくようにするハーネス。

検出は決まった処理のスクリプトがする。Claude Code のフックが、その結果を TechLead の文脈に差分だけ入れる。直すのはモデル。

## しくみ

```
[集める: トークンを使わない]                  [判定: 純粋関数]      [気づかせる: フック]
ボードの控え (GraphQL、5分ごと + 書き込み直後) ─┐
~/.claude/sessions と部下の心拍 ───────────────┼→ 規則 (docs/rules.md) → TechLead の文脈 / statusline
意図した例外 (scrum ack) ───────────────────────┘
```

| フック | TechLead | 部下 | チームの外 |
|---|---|---|---|
| SessionStart (起動・再開・圧縮の後) | 全体の要約を入れる。待機を始める | 心拍 | 何もしない |
| UserPromptSubmit | 新しい指摘を入れる | 心拍 | 何もしない |
| PreToolUse (Bash) | Status を変えるスクリプト (`scripts.setStatus` など) で、作業中の上限超えと PR への Status を拒否する | 同じ | 同じ |
| PostToolUse | ボードを触るコマンドの後: 控えを直し、触った issue の指摘とマージの案内を入れる。それ以外は待機プロセスの印があるときだけ新しい指摘を入れる | 何もしない | 何もしない |
| Stop | 止めたことのない高い指摘があれば一度だけ止める。待機を始める (asyncRewake) | 心拍 | 何もしない |
| Notification (permission_prompt) | — | 許可待ちの心拍 | 何もしない |

**動きの記録 (`activity`)**: TechLead、部下、窓口のどのセッションでも、PostToolUse のフックが、最後の記録から 10 分以上たっていれば、`events.jsonl` に `activity` を 1 行足す。UserPromptSubmit、SessionStart、Stop では足さない (週の上限の間も、予定の実行の入力でこれらのフックは通るが、PostToolUse はツールの結果なので通らない) (`bin/scrum` のシェルの層で、node は起こさない)。チームの外のセッションは足さない。これは、全セッションが止まっていた時間を、`watch` が動いているかに関わらず、読めるようにするため (`docs/rules.md` のスプリントの節)。

待機 (`scrum watch`) は TechLead の Stop と SessionStart から `asyncRewake` で起動する。部下の Stop と SessionStart でも、設定の `dispatch.enabled` が true のときだけ起動し、空きが続いて有効な受け入れが無ければ、次の issue を決めてボードを書き換え、その文で部下のセッションを起こす (docs/rules.md の A-DISPATCH、LLM は通さない)。窓口 (`alerts.liaison` の名前のセッション) も、`alerts.enabled` が true のときだけ起動し、止まりの検知 (E-STALL、Q-EMPTY) が決めた文で窓口を起こす (docs/rules.md の「止まりの検知とオーナーへの通知」)。30秒ごとにボードの控え (5分より古ければ取り直す) と稼働を見て、知らせていない中以上の指摘が出たら exit 2 で TechLead を起こす。TechLead が作業中なら起こさず、印 (`notify/pending`) を置いて次のツールの呼び出しで入れる。最長50分で終わり、次の Stop で始め直す。ソースが更新されたら、古いコードのまま動き続けないよう、その時点で終わる。

負荷の高い Mac でツールの呼び出しのたびに node を起こさないよう、`bin/scrum` がセッションの役を見て振り分ける。チームの外と、部下と窓口のツールの呼び出しはシェルだけで終わる (30〜60ミリ秒)。

## 導入

```sh
pnpm install                     # 型検査とテストのためだけ。動かすのは node 24 だけで足りる
cp config.example.json ~/.claude/scrum/config.json   # ボードとチームに合わせて直す
bin/scrum refresh && bin/scrum lint                  # 指摘を確かめる
bin/scrum install                # ~/.claude/settings.json にフックを足す (控えを取る)
```

外すときは `bin/scrum uninstall`。settings.json の変更は動いているセッションにもそのまま効く。

設定 (`config.json`) の主な項目:

| 項目 | 内容 |
|---|---|
| `projectId`、`repos`、`defaultRepo` | 点検するボードとリポジトリ |
| `fields`、`statuses`、`reasonNone`、`reasonJudge`、`statusFieldId` | ボードの項目名と選択肢の名前 |
| `ownerUser`、`ownerLabel` | 判断を下す人の Owner の値と、文で呼ぶときの名前 |
| `techlead`、`members` | TechLead と部下のセッションの名前 (ListAgents に出る名前) |
| `scripts` | ボードを書き換えるスクリプトの名前 (任意)。直し方に出し、フックが実行を読む |
| `wipLimit`、`idleMinutes` など | 検査の強さ (任意) |
| `links` | 開いている PR を、指す issue の本文の、印 (`<!-- scrum-harness:prs -->` と `<!-- /scrum-harness:prs -->`) の間に並べる (任意。`enabled` が true のときだけ動く)。`intervalMinutes`、`maxEditsPerRun`、`skipAuthors`、`skipBranchPrefixes`。docs/rules.md の「PR と issue の紐づけ」 |
| `alerts` | 止まりの検知とオーナーへの通知 (任意。`enabled` が true のときだけ動く)。`liaison` (窓口のセッションの名前)、`epicStallMinutes`、`emptyEscalateMinutes`、`isDesktopEnabled`、`parkedLabels` (積んである Epic の印のラベル)、`epicPushMinutes` (同じ Epic をオーナーに通知する間隔)、`emptyPushMinutes` (渡せる issue が無い同じ部下をオーナーに通知する間隔)。docs/rules.md の「止まりの検知とオーナーへの通知」 |
| `dispatch` | 空いた部下に次の仕事を渡す (任意。`enabled` が true のときだけ動く)。`baseBranch`、`skipLabels`、`orderField`、`members`、`scriptDir`、`linkedBranchPrefix` (渡すときに issue に紐づいたブランチを作る)、`notes`。docs/rules.md の「空いた部下に次の仕事を渡す」 |

スプリントの節目とストーリーポイント (任意) を使うには、ボードに Number の欄を2つ (ストーリーポイント、超過) 足し、設定に `sprint` を書く:

```json
"sprint": {
  "checkpoints": ["08:00", "13:00", "21:00"],
  "utcOffset": "+09:00",
  "pointsField": "ストーリーポイント",
  "overrunField": "超過",
  "pointBudgets": { "1": 1, "2": 1, "3": 2, "5": 3, "8": 5 }
}
```

ポイントは節目の前に人が入れる。「超過」はハーネスだけが書く。数え方は docs/rules.md の「スプリントの節目とストーリーポイント」。

statusline に出すには、statusline のスクリプトの最後に足す:

```sh
SCRUM_LINE=$(echo "$input" | <clone 先>/bin/scrum statusline 2>/dev/null)
[ -n "$SCRUM_LINE" ] && echo "$SCRUM_LINE"
```

## 使い方

| コマンド | 内容 |
|---|---|
| `scrum lint [--refresh]` | 指摘の全件 |
| `scrum team` | TechLead と部下の稼働 |
| `scrum dispatch --once [<名前>...]` | 空いている部下に、1 回だけ、次の仕事を選んでボードに書き、送る文を出す (dispatch を有効にした直後の、すでに空いている部下のため。文は呼んだ人が SendMessage で送る) |
| `scrum ack <規則> <対象> --for 2h --reason "..."` | 意図した例外として黙らせる。T-IDLE は最長 1 時間で、理由は「<オーナー>の答え待ち」か「枠 HH:MM」。S-POINTS-OVER は、超過を出した節目より後の、超過の扱いの印 (docs/rules.md) が issue のコメントにあるときだけ |
| `scrum report --since YYYY-MM-DD` | スプリントレビュー用のまとめ (指摘が残った時間、部下の空き、止めた回数、例外) |
| `scrum points` | 作業中の issue のポイント・目安・手間・超過 (超えた順)。下に、済んだ issue の予実 (ポイント・目安・かかった節目) と、ポイントごとの中央値と幅 |
| `scrum alerts` | 止まりの検知 (E-STALL、Q-EMPTY) を 1 回進める。launchd (`launchd/scrum-alerts.plist`) が 5 分ごとに流す。置き方は docs/rules.md の「止まりの検知とオーナーへの通知」 |
| `scrum link-prs [--dry-run]` | 開いている PR を、指す issue の本文の、印 (`<!-- scrum-harness:prs -->` と `<!-- /scrum-harness:prs -->`) の間に並べる (links.enabled のときの待機も流す)。`--dry-run` は、書き換えず、予定と、飛ばす理由と、壊れた印だけを出す。docs/rules.md の「PR と issue の紐づけ」 |
| `scrum checkpoint` | まだ記録していない最後の節目を、今記録する |
| `scrum runtime` | Agency の台から呼ばれる (agency-runtime/1)。標準入力の JSON 1 件を読み、チームの状態 (TeamView) を返すか、判断待ちへの答えを当てる。[docs/agency-runtime.md](docs/agency-runtime.md) |

状態は `~/.claude/scrum/` に置く (`SCRUM_STATE_DIR` で変えられる)。エラーは `~/.claude/scrum/log/errors.log`。

## 開発

```sh
pnpm test        # node:test
pnpm typecheck   # tsc
```

ソースに特定のボードやチームの値は持たない。値は設定ファイルにだけ書く。

外のシステムとのつなぎ目は、ポートとアダプタに分けてある。依存は、アダプタから中心へだけ向く。

- `src/ports/`: 中心が外に求めるものの型 (ボードを読む・書く、操作の読み取り、issue、PR とブランチ、セッション、通知)。
- `src/adapters/<システム>/`: ポートの実装。`github/` (gh と設定のスクリプト)、`claude-code/` (`~/.claude/sessions`)、`macos/` (osascript)。
- `src/wiring.ts`: 設定からアダプタを作り、ポートとして中心に渡す。中心の機能のフォルダ (`board/`、`team/`、`sprint/` など) は、アダプタを import しない。
- 試験では `test/fake-ports.ts` の偽のポートを渡し、外に出ない。

## ライセンス

MIT と Apache-2.0 の、どちらか好きなほう ([LICENSE-MIT](LICENSE-MIT)、[LICENSE-APACHE](LICENSE-APACHE))。
