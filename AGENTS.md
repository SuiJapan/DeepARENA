# Repository Guidelines

## 基本方針

作業を始める前に、必ず現在のリポジトリの状態を確認してください。古い前提や記憶に頼らず、実際のコード、テスト、設定ファイル、ドキュメントを根拠に判断します。

このファイルには、コードベースを見れば分かるフォルダ構成やコマンド一覧を詳しく書かず、判断を誤りやすいルール、設計方針、レビュー基準を中心に記載します。詳細は `docs`、設定ファイル、schemas、既存実装、テストを確認してください。

## 作業前の確認

実装前に、対象領域に関係する設定ファイル、schemas、docs、既存テスト、README、近い実装パターンを確認してください。

フォルダ名やファイル名だけで責務を推測せず、実装内容とテストを確認してから変更してください。設定や script は更新される可能性があるため、検証コマンドも記憶ではなく現在の設定から選んでください。

## 実装の品質原則

untyped なコードを書かず、境界での検証と型安全性を重視してください。使用言語を問わず、次を守ってください。

- 外部入力は境界で検証する。HTTP request、environment variable、永続化された state、queue message、fixture、外部 API response を、検証せずに信頼しない。
- parse / normalize / business logic を分離する。
- 決定的な変換処理は、小さな pure function に分ける。
- 隠れた global state を避け、依存関係は可能な限り明示的に渡す。
- 重要な設定不備や不正値は fail-closed にする。安全でない fallback をしない。
- success path だけでなく、malformed input、retry、failure path、boundary condition をテストする。
- 型チェックや lint を通すために設定を弱めない。

## TypeScript 実装ルール

TypeScript は untyped JavaScript として書かず、境界での検証と型安全性を重視してください。「実装の品質原則」に加えて、次を守ってください。

- `any` は原則使わない。外部入力には `unknown` を使い、明示的に parse / validate する。
- HTTP request、environment variable、DB row、queue message、fixture JSON、外部 API response は境界で検証する。
- parse / normalize / business logic を分離し、決定的な変換処理は小さな pure function に分ける。
- 重要な env 不備や不正値は fail-closed にする。安全でない fallback をしない。
- success path だけでなく、malformed input、retry、failure path、boundary condition をテストする。
- 新しい runtime dependency は必要性を説明できる場合のみ追加する。

package の挙動を変えた場合は、package-local test と影響する root-level check を更新してください。

## Move 実装ルール

Move（Sui Move を想定）は最小権限を原則にしてください。

- まず private `fun` で実装する。
- package 内部で共有する処理には `public(package)` を使う。
- `public` / `entry` は、外部 API として意図した関数に限定する。
- `public(friend)` は使わない。
- `entry` は薄い入口にする。引数検証、権限確認、イベント発火、返り値制約の吸収に留め、コア状態遷移は private または `public(package)` に委譲する。
- 外部公開 API を内部実装モジュールに分散させない。accessors、admin、user entry など外部から触る入口は専用モジュールへ寄せる。
- off-chain data は、contract 側で署名、status、version、payload constraints を検証できる場合のみ信頼する。
- object ownership、capability、admin authority は明示的に扱う。
- `#[test_only]` helper は使ってよいが、production API を test convenience に合わせて歪めない。

contract から見える挙動（contract-visible behavior）を変更する場合は、Move test を追加するか、追加できない理由を明記してください。

Move ファイルや `Move.toml` / `Move.lock` を変更した場合は、`sui move build`（必要に応じて `--lint`）と `sui move test` を実行し、warning / error を修正対象として扱ってください。

## テストと検証

検証コマンドは、現在のリポジトリ設定（`package.json` などの script 定義）を確認して選んでください。記憶や推測でコマンドを発明しないでください。

コード変更時は、まず対象範囲の狭いテストを実行し、その後に影響範囲を覆う check / typecheck / test を実行してください。

完了報告には、実行したコマンド、成功 / 失敗、実行していない重要な検証、既知の制限、follow-up が必要な項目を含めてください。実際に実行していない検証を「通った」と書かないでください。

## Git / PR ルール

commit message 作成では `draft-commit-message` を必ず使用してください。PR 準備では `prepare-pr` を必ず使用してください。

issue 作成では `prepare-issue` を必ず使用してください。新規実装や修正を実装する前に issue を起票し、その issue を `gh-issue-implement` で実装する流れを基本にしてください。

## 依存関係

新しい dependency はデフォルトでは追加しないでください。まず standard library と既存 dependency で実装できないか検討してください。

dependency を追加する場合は、既存実装では不十分な理由、security / maintenance risk、package size や build への影響、runtime dependency か dev dependency かを説明してください。

## セキュリティとローカル設定

secret、API key、private credential、local MCP auth、個人用 agent 設定、ローカルマシン固有の path、不要な生成物はコミットしないでください。

project-shared な agent 設定は、repository workflow として共有する意図が明確な場合のみコミットしてください。個人用 override は untracked のままにし、ローカル生成物も untracked にしてください。
