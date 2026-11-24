# 規則

ボードの運用の README (GitHub Project の README) を、機械で確かめられる形にしたもの。値 (Status の名前、上限など) は `~/.claude/scrum/config.json` から読む。

重さで知らせ方が変わる。

| 重さ | 知らせ方 |
|---|---|
| 高 | TechLead のターンの終わりを一度だけ止める。待機中なら起こす |
| 中 | 新しく出たら、次のフック (ツールの呼び出しの後、プロンプト) で入れる。待機中なら起こす |
| 低 | セッションの始まりの要約と `scrum lint` にだけ出す |

## ボード

| 規則 | 重さ | 条件 | 直し方 |
|---|---|---|---|
| B-WIP-OVER | 高 | 開いている issue の作業中が上限 (`wipLimit`) を超えている | 止まっているものから見直し、バックログに戻す |
| B-DOING-NO-ASSIGNEE | 高 | 作業中なのに担当が無い | 担当を付ける。決められなければバックログへ |
| B-CLOSED-NOT-DONE | 中 | 閉じた issue の Status が完了でない | Status を完了にする |
| B-OPEN-DONE | 中 | 開いている issue が完了 | 閉じるか、作業中・バックログに戻す |
| B-PR-STATUS | 中 | PR に Status が付いている | 指摘に出る `gh project item-edit ... --clear` |
| B-NO-STATUS | 中 | 開いている issue に Status が無い | Status をバックログにする |
| B-OFF-BOARD | 中 | 開いている issue がボードに無い | ボードに足し、Status をバックログにする |
| B-UNREADABLE | 中 | issue・PR の項目の中身 (番号) が読めない。このあいだ B-OFF-BOARD は判じない | `scrum refresh`。続くなら `~/.claude/scrum/log/fetch-failed-*` を見る |
| B-SNAPSHOT-STALE | 中 | ボードの控えが `refreshSeconds` の3倍より古い (取り直しに失敗している) | `~/.claude/scrum/log/errors.log` と `fetch-failed-*` を見る |
| B-NEXT-BLOCKED | 中 | 次にやるが止まっている (理由がなし以外) | バックログに置き、理由を残す |
| B-JUDGE-OWNER | 中 | 判断待ちなのに Owner が `ownerUser` でない (その人のビューに出ない) | Owner を `ownerUser` にする |
| B-SINCE-MISSING | 中 | 止まっているのに止まり始めた日が無い | 止まり始めた日を入れる |
| B-REASON-MISSING | 低 | 止まっている理由が空 | 理由を「なし」にする |
| B-SINCE-STRAY | 低 | 理由がなしなのに日が残っている | 止まり始めた日を消す |
| B-BLOCK-STALE | 低 | 止まり始めてから `staleBlockDays` 日を超えた | 待つ先を確かめる |

`excludeAuthors` の作者の issue (別の開発主体) は検査しない。

B-OFF-BOARD は、控えを取るとき、ボードのページの一覧に出なかった開いた issue を 1 件ずつ読んで (`projectItems`)、ボードに入っていれば項目として足してから判じる。ボードに入っている項目が、一覧にも総数にも出ない状態が、足されてから何時間も続くことがあるが、そのときもボードに入っている issue に誤って出ない。開いた PR の項目が一覧に出ないときも、同じ読みで足す (B-OFF-BOARD を出す対象は issue のままで、ボードに入っていない開いた PR は、足さず、指摘もしない)。1 件ずつ読むのに失敗したときは、控えを書き換えない (`src/adapters/github/off-board.ts`)。

直し方は、設定の `scripts` にボードを書き換えるスクリプトがあれば、そのコマンドで出す (例: `set-status 123 完了`)。無ければ文で出す。スクリプトの引数の形は `src/config.ts` の `BoardScripts` に書いてある。

## 部下の稼働

稼働は `~/.claude/sessions` (Claude Code のセッションの記録) と、部下のフックが書く心拍 (`~/.claude/scrum/team`) から決める。同じ名前のセッションが複数あれば、名前を後から取ったほうを正とする (ListAgents と同じ)。

| 規則 | 重さ | 条件 | 直し方 |
|---|---|---|---|
| T-IDLE | 高 | 部下が `idleMinutes` 分以上空いている | 仕事を振る (`dispatch` が有効なら、受け入れが無い空きにはハーネスが渡す。下の「空いた部下に次の仕事を渡す」)。意図した待ちなら `scrum ack T-IDLE <名前> --for 1h --reason "<オーナー>の答え待ち"`。T-IDLE の受け入れは最長 1 時間で、理由は「`ownerLabel` の答え待ち」か「枠 HH:MM」から選ぶ。コンテキストの余力は理由にできない |
| T-WAITING | 高 | 部下が `waitingMinutes` 分以上、許可の確認で止まっている | `ownerLabel` の人に知らせる。TechLead から許可を代わりに出させない |
| T-BUSY-UNTRACKED | 低 | 部下が `untrackedMinutes` 分以上動いているのに、担当の作業中が無い | 今の作業の issue に担当を付ける |

## 空いた部下に次の仕事を渡す (A-DISPATCH、LLM を通さない)

設定の `dispatch.enabled` が true のときだけ動く (既定は動かない)。空いた部下を見つけて仕事を振るのは TechLead の判断ではなく、ハーネスの仕事である。

部下が `idleMinutes` 分以上空き、次のどれにも当たらないとき、ハーネスが次の issue を決めて渡す (止まっていない自分の作業中の issue があれば、渡さずに促す。下の「促し」)。

- 有効な T-IDLE の受け入れがある。「枠 HH:MM」の受け入れは、枠の始まりの 15 分前までは止めない
- 前に新しい issue を渡した後、その人が一度も動いていない (空きが渡した時刻より前から続いている)
- 設定の `dispatch.members` (無ければ `members`) に入っていない

**選ぶ順** (決まった順で、LLM は通さない)。

1. ボードの「次にやる」で、担当がその人
2. バックログで、担当がその人 (止まっている理由がなし)
3. 担当なしの「次にやる」

同じ区分の中は、ボードの数の欄 (`dispatch.orderField`、小さいほど先、空は最後)、次に、今動いている人の少ない Epic の子、最後は番号の順。

**飛ばすもの**: 止まっている理由がなし以外、作業中が `wipLimit` に届いているとき (何も渡さない)、`dispatch.skipLabels` のラベルが付いたもの (渡さない印)、題が `release/<番号>` で始まるもの (リリースの issue は人が手で切り出すので、渡す文が合わない)、`defaultRepo` 以外の issue (ボードを書き換えるスクリプトが番号だけで指すため)、PR、閉じた issue、`excludeAuthors` の作者の issue。

**渡し方**: `scripts.setAssignee` と `scripts.setStatus` で、担当をその人、Status を作業中にし (スクリプトは `dispatch.scriptDir` から探す)、決まった文面をその人のセッションに送る (部下の Stop と SessionStart の待機プロセスが、TechLead と同じく asyncRewake の exit 2 で起こす)。文面は、issue の番号と題、`origin/<dispatch.baseBranch>` から切ること、PR の宛先、マージする人 (`techlead`)、`dispatch.notes`。同じ issue を 2 人に渡さないよう、錠の中で控えを読み直す。スクリプトが失敗したら記録も控えの書き換えもせず、5 分は試さない。

**促し**: 空いた人が、止まっていない (理由がなし) 自分の作業中の issue を持っていれば、新しい issue は渡さず、「作業中の #N を進める」と促す文を送る (ボードは書き換えない)。作業中を増やさないため、また CI やレビューの待ちで空いて見える人に別の仕事を足すと両方が遅れるため。最後に送ってから `idleMinutes` ごとに、**作業が進まないまま** 2 回まで (新しい issue を渡した直後も、`idleMinutes` 待つ)。作業が進んだかは、促した時点と、いまの issue の印を比べて決める。印は、ボードの Status、止まっている理由、担当、止まり始めた日と、gh で読む issue のコメントの数、紐づいたブランチの先頭、その issue の PR の番号と状態と先頭のコミット (gh が読めないときは、ボードの印だけで比べる)。PR は、ほかの人の PR を拾わないよう絞る: 紐づいたブランチ (仕事を渡したときに作る) があれば、そのブランチから出た PR だけ、無ければ、題の括弧の中かブランチ名の先頭の番号が、その issue と合う PR だけ。印が変われば、数え直す。**作業が進んでいる間は、促さない**: 前に見た印から変わった (コメントが増えた、PR に push した) か、最後に印が変わってから `idleMinutes` たっていなければ、促しの上限より先に、待つ。見た印は、部下ごと、issue ごとに `~/.claude/scrum/cache/dispatch-seen.json` に残し、A-NUDGE-IGNORED も、同じ印 (ボードの印は今のボード、gh の印は最後に見た分) で比べる。促しの後、短い 1 ターンで空きに戻り、空きの区間が変わっても、数え直さない (直近 3 時間の、その人のその issue への促しを数える)。作業中が止まっている (理由がなし以外) か、無ければ、次を渡す。作業中が `wipLimit` に届いていても、促しは送る (上限は新しい issue を渡すときだけ見る)。

| 規則 | 重さ | 条件 | 直し方 |
|---|---|---|---|
| A-DISPATCHED | 中 | 空いた部下に仕事を自動で渡した (渡してから 2 時間だけ出る)。誰に何を渡したか付き | 渡し方が合わないときは、担当と Status を直して本人に伝える。何もしなければ、そのまま進む |
| A-NUDGE-IGNORED | 中 | 作業が進まないまま促しを 2 回送り (直近 3 時間、その人のその issue)、いまも空き (続いた促しごとに 1 件) | 作業中が本当に待ちなら、止まっている理由を付けさせる (付くと次の仕事が渡る)。そうでなければ、本人に直接伝える |

**当てた後に、gh の印が読めていることを見る**: gh の印が読めないと、ボードの印だけで比べるので、コメントや PR の動きは「進んだ」に数えない。当てた後の最初の促しの後で、`~/.claude/scrum/log/dispatches.jsonl` の、その促しの記録の `progress.github` が `null` でないこと (コメントの数などを含む JSON の文字列になっていること) を見る。`null` なら、gh の認証 (`gh auth status`) と、待機プロセスの PATH で `gh` が呼べるかを見る。gh の失敗の標準エラーは、待機プロセスが起こす文には混ざらず、`errors.log` に残る。

**書き込みの守りと数え方**: 渡す前に、ボードへの書き込みの守り (`checkGuard`) を通す。作業中の数え方は、守りと渡す側で同じ (除く作者の作業中も数える)。守りを通らなければ、渡さない。

**T-IDLE の受け入れの検査**: 最長 1 時間と、決まった理由 (完全一致の「`ownerLabel` の答え待ち」か「枠 HH:MM」) の検査は、`dispatch.enabled` に関係なく、当てた直後から有効になる (`scrum ack T-IDLE` は、検査を通らないものを断る)。保存された受け入れも、この検査を通らないもの (検査を入れる前に作られた、長い期限、余力などの理由、理由の後ろに文字があるもの) は、自動で渡すのも、T-IDLE の指摘も止めない。

**当てた後に、すでに空いている部下を 1 回動かす** (`scrum dispatch --once [<名前>...]`): 待機は、部下の Stop と SessionStart でしか始まらないので、`dispatch.enabled` を true にした時にすでに空いている部下は、次の Stop まで渡されない。この手は、待機の外から 1 回だけ、渡す相手 (名前を渡せばその人だけ) に、選んで、ボードを書き換え、送る文を出す。部下のセッションを起こすことはできないので、出た文を、その部下のセッションに SendMessage で送る。送らない人は、理由 (空きではない、空きが短い、受け入れがある、渡せるものが無い、上限) を 1 行で出す。

渡した記録は `~/.claude/scrum/log/dispatches.jsonl` と `events.jsonl` (`dispatched`)。止めるときは `dispatch.enabled` を false にする。

## PR と issue の紐づけ

PR から issue、issue から PR に、たどれるようにする。3 つの道があり、このハーネスは前の 2 つを持つ。

1. **渡すときに、issue に紐づいたブランチを作る** (設定の `dispatch.linkedBranchPrefix`。無ければ作らない)。部下に仕事を渡すとき、`<prefix>/<番号>` を `origin/<dispatch.baseBranch>` の先頭から、GitHub の createLinkedBranch で作る。そのブランチから出した PR は、ベースが既定のブランチでなくても (develop 宛てでも)、issue の Development の欄に出る (issue の側の `linkedBranches[].ref.associatedPullRequests` に PR が出ることを、API で読んで見た)。issue にすでに紐づいたブランチがあれば、作らずに、最初のものを渡す (文面に、土台が古いことがあるので origin に遅れていないかを見てから作業する、と書く)。この gh の呼び出しは、渡す錠の中なので、1 回 15 秒で打ち切る (最大 2 回)。作れなかったときも、渡すことは止めず、文面に「用意できなかった」と書く。PR の側からは、この紐づけで issue に飛べない (`closingIssuesReferences` が空)。PR の本文に `#N` を書かせる (文面にも書く)
2. **PR を issue の本文の、印の間に並べる** (設定の `links`、`scrum link-prs`)。紐づいたブランチから作られなかった PR (すでにあるもの、積んだもの) を補う。
   - **何を読むか**: 開いている PR の、題の括弧の中の `#N` (`feat: x (#123)`)、ブランチ名の先頭の番号 (`feat/456-...`。番号の後ろが `-`、`_`、`/` か終わりのときだけ)、本文の `Closes`、`Fixes`、`Resolves`、`Refs` で始まる行の `#N` (コードの囲みの中は読まない)。本文のどこかの `#N` は読まない (文脈のために書いた番号で、1 つの PR が何本もの issue に並ぶため)
   - **どう書くか**: issue の本文の `<!-- scrum-harness:prs -->` と `<!-- /scrum-harness:prs -->` の間だけを、`進行中の PR (自動): #<番号> (題) / #<番号> (題)` の 1 行にする。印の外は 1 文字も変えない (人が書いた「## 進行中の PR」の節も触らない。印が無ければ、本文の最後に印の組を足す)。指す PR が無くなれば、印の組を消す。同じ内容なら書き換えない。題は、末尾の `(#N)` を括弧ごと外し、`#N` と `@` を除き、60 字で切る (別の issue への言及と、メンションの通知を足さないため)
   - **壊さないための守り**: 印の片方だけ、2 組以上、順が逆の本文と、閉じていないコードの囲みがある本文 (足した印が囲みの中に入って読めず、流すたびに足されるため) は、書き換えず、`scrum link-prs` の出力と `events.jsonl` (`link-broken`) に出す。コードの囲みの中の印は数えない。書く直前に、その issue の本文を読み直し、計画を作ったときと違えば (人が直した)、その回は書かない (`link-skipped`)。閉じた issue も書かない。書く前の本文は `log/links-before.jsonl` に残す (巻き戻せるように)。本文は `-f` で渡す
   - Dependabot の作者、`release/` と `sync/` のブランチは数えない (`links.skipAuthors`、`links.skipBranchPrefixes`)。TechLead の待機プロセスが `links.intervalMinutes` (既定 30 分) ごとに流し、1 回に書き換えるのは、リポジトリ全体で `links.maxEditsPerRun` (既定 20) 件まで (設定のリポジトリの順に、issue の番号の小さい順。人が直していて飛ばした分も数える)。`scrum link-prs --dry-run` で、書き換える予定だけを見られる
3. PR の本文に開いている issue の番号を必ず書かせる検査は、ハーネスではなく、各リポジトリの CI が持つ

## 止まりの検知とオーナーへの通知 (E-STALL、Q-EMPTY、LLM を通さない)

設定の `alerts.enabled` が true のときだけ動く (既定は動かない)。誰に何を伝えるかはハーネスが決め、窓口のセッションは決まった文を送る手になるだけで、判断はしない。

| 規則 | 重さ | 条件 | 直し方 |
|---|---|---|---|
| E-STALL | 高 | 動く人が要る Epic (バックログ、次にやる、作業中の開いた子を持つ。子がすべてバックログでも入る) を、いま動いている人 (作業中の子の担当で、セッションが作業中の人) がいない状態が `alerts.epicStallMinutes` (既定 60) 分続いた | 担当を動かす。作業中の子がすべてオーナーの判断待ち (`reasonJudge`) なら、待っている問いを添えてオーナーに伝わる |
| Q-EMPTY | 高 | 空いて、受け入れも無く、渡す相手に入っている部下に、渡せる issue が無い (次にやる と バックログのどちらにも候補が無いか、作業中が `wipLimit` に達している)。見つけた時から出る (理由が変われば、その時から数え直す。作業中が上限で空いていた人が、渡せる issue が無いに変わったら、Q-EMPTY-OWNER の 30 分はそこから数える)。**`dispatch.enabled` が true のときだけ動く** (渡す相手と、渡せるかの判定が、dispatch の設定を使うため) | 次にやる か、その人の担当のバックログに issue を並べる (担当と順を付ける)。並べるのは TechLead |
| Q-EMPTY-OWNER | 高 | 渡せる issue が尽きた (候補が無い) Q-EMPTY が `alerts.emptyEscalateMinutes` (既定 30) 分続いた。作業中が上限で渡せない Q-EMPTY は、渡すものが尽きたのではないので、TechLead だけに出し、これには数えない | issue を並べれば消える。オーナーにも伝わる (同じ人は `alerts.emptyPushMinutes`、既定 60 分に 1 回まで) |

次の Epic は数えない。子がリリース待ちか完了だけの Epic (作業は済んでいる)、Epic 自身がボードで閉じているもの、Epic 自身の作者が `excludeAuthors` (別の開発主体) のもの、意図して積んである Epic。積んである印は、Epic 自身に付いたラベル (`alerts.parkedLabels`、既定 `epic:parked`) で、付けるのは TechLead (付けるときに理由を Epic の本文に書く決まりで、ハーネスは本文を読まず、ラベルだけを見る)。ボードに無い Epic はラベルを読めないので、数える。止まった時刻は、待機プロセスが `~/.claude/scrum/cache/alerts-state.json` に覚える (動き出せば消え、また止まれば数え直す)。Epic の子の親とラベルは、`dispatch` か `alerts` が有効なときにボードから取る。

**伝え方** (TechLead への指摘は、ほかの指摘と同じく、待機の起こしとフックで入る)。

- **オーナーへの通知** (E-STALL と Q-EMPTY-OWNER): 窓口のセッションに「オーナーに PushNotification を 1 通送る (音は鳴らさない)。本文はこのまま」という文を送る。E-STALL で作業中の子がすべて判断待ちなら、待っている子の番号を添え、問いの文を 1 行足させる。同じ E-STALL のオーナーへの通知は、`alerts.epicPushMinutes` (既定 1440 分、1 日) に 1 回までにする。直前の通知の後に出る新しい E-STALL は、オーナーへは送らず、窓口に「通知済みなので送らない」と 1 行だけ伝える (TechLead には今の重さのまま伝わる)。間隔が過ぎても止まったままなら、そのときの新しい通知がオーナーに出る。同じ内容を、ハーネスが macOS の通知 (`osascript` の `display notification`、音なし) でも直接出す。窓口が作業中でも、オーナーに届くようにするため。本文は引数 (argv) で渡し、AppleScript の文字列には埋め込まない。`alerts.isDesktopEnabled` を false にすると、macOS の通知だけを止められる。
- **空きの 1 行**: 部下が `idleMinutes` 分空いた時点 (T-IDLE と同じ) で、窓口に 1 行を送る。T-IDLE の受け入れがあっても送る。受け入れの理由と終わり、ハーネスが送った仕事 (渡した、促した)、渡せる issue が無いことを書く。macOS の通知は出さない。
- **1 回の評価で出た通知は、1 通にまとめる**: 夜の間に止まった Epic が一度に E-STALL になっても、オーナーへの PushNotification は 1 通、macOS の通知も 1 つ。1 件ごとに 1 行で、止まっている理由 (オーナーの答え待ちの子、作業中の子の理由、作業中の子なしと子の数) を書く。E-STALL と Q-EMPTY-OWNER も同じ 1 通に入る。出した印は、まとめた分の全部に付ける
- **許可待ち (waiting) は、動いている人に数えない**。動いている人は、作業中の子の担当で、セッションが作業中 (busy) の人だけ
- 受け入れ (`scrum ack E-STALL <Epic> ...`、`scrum ack Q-EMPTY <名前> ...`) をした指摘は、オーナーへの通知も出ない。同じ通知は、直ってからまた起きるまで、重ねて送らない。

**検知を launchd で 5 分ごとに流す** (`scrum alerts`): 待機プロセスの寿命 (50 分) は E-STALL の上限 (60 分) より短く、全員が静かな夜は待機が止まるので、検知が止まる。`scrum alerts` (待機の 1 周と同じ。ボードの控えを取り直し、macOS の通知を、まだなら出す。LLM は通らない) を、`launchd/local.scrum-harness.alerts.plist` で 5 分ごとに流す。置き方 (launchd はログインシェルの PATH を引き継がないので、`launchd/render.sh` が node と gh の場所をいまのシェルから読み、雛形の `{{HOME}}`、`{{SCRUM_DIR}}`、`{{PATH}}` に入れる。置く前に、その PATH だけで node と gh が見つかることも見て、見つからなければ止まる):

```
bash launchd/render.sh > ~/Library/LaunchAgents/local.scrum-harness.alerts.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.scrum-harness.alerts.plist
launchctl kickstart -k gui/$(id -u)/local.scrum-harness.alerts
sleep 5; tail -n 3 ~/.claude/scrum/log/alerts-launchd.log
launchctl print gui/$(id -u)/local.scrum-harness.alerts | grep -E 'state|last exit code'
```

置いた後に 1 回通ったことを見る。ログに「止まりの検知を進めた」(`alerts.enabled` が false なら「alerts が有効でない」) が出て、`last exit code = 0` なら通った。「not found」が出たら、PATH を直して置き直す (`launchctl bootout gui/$(id -u)/local.scrum-harness.alerts` で外してから)。node か gh の場所を変えたとき (バージョン管理の道具を替えたときなど) も、置き直す。待機の寿命は変えない。

**窓口の待機**: `alerts.liaison` に窓口のセッションの名前を書くと、その名前のセッションの Stop と SessionStart の待機プロセスが、ボードを取り直し、止まりの検知を進め、窓口に送る通知が出たら exit 2 で窓口を起こす。TechLead と部下の待機プロセスも、同じ検知を進め、macOS の通知を出す (窓口が動いていなくても、オーナーに届く)。

記録は `events.jsonl` の `alert-desktop` と `alert-liaison`。止めるときは `alerts.enabled` を false にする。

## Requests to the owner (R-ANSWERED)

The team asks the owner for answers and decisions with requests, not with chat messages, so that the open questions stay visible. A request is a question (with options if useful) or a proposal (options and a Markdown document). It is stored in `<state dir>/requests/<id>.json`, one file each, and `scrum request` adds, lists, shows, replies to, and closes them. The owner answers through an Agency node (`scrum runtime`, see [agency-runtime.md](agency-runtime.md)).

- `scrum request add --from <name>` takes JSON on stdin: `title`, `context`, `kind` (`question` or `proposal`), `issue`, `to`, `options` (`key`, `text`, `isRecommended`, `detail`), and `blocks`. Put the people and issues that stop until the answer in `blocks`; a blocked idle member is then reported as waiting on the owner, with the question.
- `waiting` says whose turn it is: `owner` when the request is filed, `team` once the owner has answered, and `owner` again when the team replies with `scrum request reply`. When the team has acted on the answer it runs `scrum request close <id> --note "<what was done>"`. A closed request that the owner answers again reopens.

| Rule | Severity | Condition | Fix |
|---|---|---|---|
| R-ANSWERED | medium | The owner answered a request and it is not closed (one finding per request), with the chosen option and the text | Act on the answer, then `scrum request close <id>`. To ask a follow-up, `scrum request reply <id> --from <name> --text "<question>"` |

## スプリントの節目とストーリーポイント

設定の `sprint` があるときだけ動く。節目は1日に何回か置く区切り (例: 8:00、13:00、21:00)。

- **手間** = 作業中にいた間にまたいだ節目の数。作業中の期間は GitHub の Status の変化の記録 (issue の timeline) から取り、作業中を出入りした分も足す
- **止まっていた節目は数えない**。今止まっているもの (理由がなし以外) は止まり始めた日から、過去の分は節目の記録に残った理由から除く
- **全セッションが止まっていた節目も数えない**。`events.jsonl` に、チームの誰かが動いた記録 (`member-state`、`stop-blocked`、`woke`、`acked`、`activity`) が 2 時間以上無い間にある節目を除く。`activity` 以外は watch が書き、`activity` は、TechLead、部下、窓口のどのセッションでも、PostToolUse のフック (`bin/scrum`) が、最後の記録から 10 分以上たっていれば 1 行足す (watch が動いていなくても書かれる)。UserPromptSubmit、SessionStart、Stop では足さない。週の上限の間も、予定の実行の入力でこれらのフックは通るが、PostToolUse はツールの結果が出て初めて通るので、仕事をしていた印になる。最後の動きから今まで 2 時間以上たっていれば、その間も含める。launchd が誰も動いていなくても書く `finding-opened` と `finding-closed` は、動きに数えない。除いた数は、S-POINTS-OVER の文の「全セッションが止まっていて除いた節目 n」と、`scrum points` の手間の「(除いた節目 n)」に出る (理由で止まっていて除いた節目は、この数に入れない)。夜に全員が空いていた間も、記録からは週の上限で止まった間と区別できないので除かれる。節目の記録の `effort` には、記録した時点で分かっていた止まりだけが入り、あとから分かった止まりは、読み直したときの手間に入る
- **目安** = ポイントごとの節目の数 (`sprint.pointBudgets`、例: 1・2→1、3→2、5→3、8→5)
- **超過** = 手間 − 目安

| 規則 | 重さ | 条件 | 直し方 |
|---|---|---|---|
| S-POINTS-OVER | 中 | 作業中の issue の手間が目安を超えた (どれだけ超えたか付き)。**受け入れ (`scrum ack`) で消せるのは、超過を出した節目より後に、その issue のコメントの 1 行目に、超過の扱いの印が付いているときだけ** | 次の節目の振り返りで、見積もりを直すか、分けるか、手を足すか、見積もりのままにするかを決め、印を付ける |
| S-POINTS-MISSING | 中 | 作業中か次にやるの issue にストーリーポイントが無い | 節目の前にポイントを入れる |
| S-POINTS-INVALID | 低 | ストーリーポイントが段 (`pointBudgets` のキー) に無い | 段のどれかにする |
| S-CHECKPOINT | 中 | 節目を記録した (記録してから1時間だけ出る)。作業中と超過の件数付き | 振り返りと、次の節目までの順を決める |

**超過の扱いの印**。issue のコメントの 1 行目に、人が読む文より前に、機械が読む HTML コメントを 1 行置く。決めた理由は、2 行目からの人が読む文に 1 行で書く。

```
<!-- scrum:points-overrun decision=<reestimate|split|add-hands|keep> from=<前のポイント> to=<後のポイント> -->
```

- `reestimate` は見積もりを直した (`from` と `to` を変え、ボードのポイントも `to` にしておく)。`split` は分けた。`add-hands` は手を足した。`keep` は見積もりのままで、超えた分は待ちだった (`from` と `to` を同じにする。止まりとして入れていなかった待ちは、ボードの止まっている理由に入れる)
- 印は、超過を出した節目 (目安を超えて数えた最初の節目) より後の時刻のものだけを使う。前の見直しの印で、いまの超過を消さない
- `scrum ack S-POINTS-OVER <issue> --for … --reason …` は、上の印が見つかったときだけ記録する (印の中身を根拠 `basis` に残す。`scrum acks` に出る)。印が無い、印の中身が決めと合わない (`keep` で `from` と `to` が違う、`reestimate` で `from` と `to` が同じか、`to` がボードのポイントと違う)、issue のコメントを読めないときは、記録せず理由を出す。根拠の無い古い受け入れは、期限内でも指摘を消さない

**済んだときの予実差**。作業中だった issue が、完了かリリース待ちになったのを、控えを取り直したときに見つけたら、ポイント・目安・かかった節目 (止まっていた節目は除く) を `~/.claude/scrum/log/completions.jsonl` に 1 行で残す。かかった節目は、Status の変化の記録 (issue の timeline) を、済んだ issue だけ 1 回で問い合わせて数える。読めなければ、前の控えの記録に済んだ時刻を足して数え、「近似」と印を付ける。比べる相手の「前の控え」は、取り直しだけが書く控え (`~/.claude/scrum/cache/board-fetched.json`) で、フックが Status を直した後の控えではない (TechLead が `Status を書き換えるスクリプト (scripts.setStatus)` で済ませた issue は、フックが直した控えの上では最初から済んでいて、見つからないため)。記録に失敗したときはこの控えを進めず、次の取り直しでやり直す (すでに記録した issue は重ねない)。同じ issue が作業中と完了を行き来して何回か記録されても、出力には新しい 1 件だけを出す。`scrum points` と `scrum checkpoint` の出力の下に、済んだ issue を新しい順に最大 20 件と、ポイントごとの件数、かかった節目の中央値と幅、目安を超えた件数を出す。バックログなど作業中を通らずに済んだ issue は、記録しない。

節目は、時刻を過ぎたあと、チームのどのセッションのフックでも、まだ記録していなければ裏で記録を始める (`~/.claude/scrum/log/checkpoints.jsonl`)。TechLead のターンの区切りを待たないので、チームの誰かが動いていれば記録される。誰も動いていなければ、最初に誰かが動いたときに遅れて記録し、知らせには記録した時刻も書く。記録の前に控えが節目より古ければ取り直す。記録したとき、`sprint.overrunField` の欄 (Number) に超えた節目の数を書き、超えていなければ空にする。待機プロセスが止まっていたら、`scrum checkpoint` で最後の節目を記録できる。

## 書き込みの前に止めるもの (PreToolUse)

- `scripts.setStatus` / `scripts.bulkStatus` のスクリプトで、作業中を上限より増やす
- 同じスクリプトで、PR に Status を付ける

意図して超えるときは、コマンドに `SCRUM_GUARD=off` を付け、理由をスプリントの記録に残す。

## 意図した例外

`scrum ack <規則> <対象> (--for 2h | --until <時刻>) --reason "<理由>"` で期限まで黙らせる (T-IDLE は最長 1 時間で、理由は決まった言葉から選ぶ。上の T-IDLE の行)。`scrum acks` で一覧、`scrum report` でスプリントレビュー用のまとめに出る。
