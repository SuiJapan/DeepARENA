# Deep Arena dapp

Next.js App Router で構成した Deep Arena の dapp です。

## ページ

| URL | 役割 |
| --- | --- |
| `/` | arena のメイン画面 |
| `/portfolio` | wallet ごとの portfolio 表示 |
| `/ranking` | arena ranking 表示 |

`/arena` route は使いません。
`/` が arena の canonical route です。

## 主な構成

```text
app
├── page.tsx
├── portfolio/page.tsx
├── ranking/page.tsx
├── providers.tsx
└── api/**/route.ts
features
└── ...
lib
└── ...
```

`app/api/**/route.ts` は Next.js の API endpoint です。
実処理は `lib/server` または feature 側の server module に寄せます。

## 開発

repository root から実行します。

```bash
pnpm --filter dapp dev
```

ブラウザで `http://localhost:3000` を開きます。

## 検証

```bash
pnpm --filter dapp test
pnpm check:ts:ci
pnpm --filter dapp build
```

UI 変更を確認する場合は、開発サーバーで `/`、`/portfolio`、`/ranking` を確認します。
