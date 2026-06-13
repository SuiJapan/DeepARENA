# DeepARENA

DeepARENA は、Sui 上で行う BTC 予測ゲーム用の dApp です。現在は `mock` モードをデフォルトにして、
コントラクト連携の実行フローや画面構成を確認しやすい形で検証できるようにしています。

## プロダクトの概要

- **目的**: プレイヤーが Binary（UP/DOWN）と Vertical Range（BREAK/RANGE）で予測建玉を行い、
  スコアやランキングで対戦感覚の参加体験を作る。
- **コア構成**:
  - `contract`: Move コントラクト（arena / binary / range / predict_adapter / events）。
  - `dapp`: Next.js のフロントエンド。
- **接続モジュール**: DeepBook Predict は `predict_adapter` 経由で扱い、フロントは `mock` / `contract` の2種類のクライアントを差し替えて動作。
- **主な画面**:
  - **Arena**: BTC ラウンド情報、Binary/RANGE のエントリー、PLP Sandbox、チャート、リアルタイム価格。
  - **Portfolio**: 保有建玉・履歴の確認。
  - **Ranking**: 全体ランキングと競技状況の確認。
- **関連ドキュメント**:
  - [01_predict_adapter（DeepBook Predict連携）](/Users/numa/Documents/GitHub/DeepARENA/docs/01_predict_adapter.md:1)
  - [02_events（イベント定義）](/Users/numa/Documents/GitHub/DeepARENA/docs/02_events.md:1)
  - [04_binary（Binary取引）](/Users/numa/Documents/GitHub/DeepARENA/docs/04_binary.md:1)
  - [05_range（Range取引）](/Users/numa/Documents/GitHub/DeepARENA/docs/05_range.md:1)

## 現在の使い方

### 1. 環境準備

- Node.js >= 20
- pnpm（推奨: `pnpm@10.27.0`）
- Move を検証する場合は `sui` CLI

```bash
pnpm install
```

### 2. アプリ起動（ローカル）

```bash
pnpm dev
```

- ブラウザで `http://localhost:3000` を開く。
- `Wallet` を接続し、Arena/Portfolio/Ranking の各画面を切り替える。
- Arena 画面では、
  - Binary（UP/DOWN）
  - Range（RANGE/BREAK）
  - PLP Sandbox の操作
  - チャートの軸表示や価格更新を確認できる。

### 3. 動作確認コマンド（任意）

```bash
pnpm check              # TS + Move の総合チェック
pnpm check:ts           # TypeScript/biome + typecheck
pnpm check:move         # sui move build/test
pnpm build              # 全体の build
pnpm test               # 全体のテスト
```

### 4. 環境変数（必要時）

デフォルトは `mock` 設定が利用されます。実運用寄りのコントラクト接続に切り替える場合は以下を使います。

- `NEXT_PUBLIC_DEEP_ARENA_NETWORK=contract`
- `NEXT_PUBLIC_DEEP_ARENA_PACKAGE_ID`
- `NEXT_PUBLIC_ARENA_OBJECT_ID`
- `NEXT_PUBLIC_PLP_SANDBOX_PACKAGE_ID`
- `SUI_FULLNODE_URL`（RPC URL を上書き）

## 今後のステップ

- コントラクト環境の本番向け固定化（ネットワーク別 config の明確化と検証手順の整備）。
- 取引失敗時の UX 強化（エラー表示、再試行、Wallet 操作フローの改善）。
- イベント監視を使った監査性の高いアラートと操作履歴の見える化。
- スコアリングとランキング更新ロジックの仕様文書化と、プレイ履歴の保存方針の明確化。
- PR/Issue ベースで仕様変更時に README と docs の同時更新をルール化。
