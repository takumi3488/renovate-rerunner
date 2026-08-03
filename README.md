# renovate-rerunner

GitHub 組織のリポジトリのうち、**GitHub 上ではアーカイブされていないのに [developer.mend.io](https://developer.mend.io) 上で Renovate が disabled になっている**ものを検出し、「Run Renovate scan」を実行する CLI です。

Mend は理由が明示されないまま Renovate を disabled にすることがあり（[renovate#40646](https://github.com/renovatebot/renovate/discussions/40646)）、放置すると依存更新が静かに止まります。本ツールはその検出と再スキャンを自動化し、Kubernetes の CronJob として定期実行することを想定しています。

## 仕組み

```
  ブラウザ + 拡張                    ┌──────────────────────────────┐
  putting-cookie-in-jar ───────────→ │       cookiejar-server       │
  （人間がログインすると自動保存）      │  Writer: HTTP / Reader: gRPC │
                                     └──────────────┬───────────────┘
                                        Cookie を読む │ 更新されたら書き戻す
                                                     ↓
  GitHub REST API ──────────→ ┌────────────────────────┐
  （非 archived な repo 一覧）  │    renovate-rerunner   │ ──→ developer.mend.io
                               └───────────┬────────────┘      （Playwright で UI 操作）
                                           │ Cookie が失効していたら
                                           ↓
                                    Discord Webhook
                                （「ログインしてください」と通知）
```

**このツール自身は Mend にログインできません。** セッション Cookie はブラウザ拡張が cookiejar-server に保存したものを使います。失効したら Discord に通知が飛ぶので、**人間がブラウザで developer.mend.io を開いてログインし直せば、拡張が自動で cookiejar を更新します**。CLI 側に GitHub のパスワードや TOTP を持たせる必要はありません。

### なぜ Playwright が必要なのか

developer.mend.io の**公開 API は GitHub Secrets 管理専用**です（[Developer Platform API 1.0](https://api-docs.mend.io/developer-platform/1.0) の `/repos|orgs/.../secrets` 系 8 エンドポイントのみ）。リポジトリ一覧の取得・Renovate の enabled/disabled 状態の取得・scan のトリガーに相当する公開 API は存在しません。

- Mend の UI は非公開の内部 API を Cookie 認証で叩いています（[renovate#31306](https://github.com/renovatebot/renovate/discussions/31306)）
- Mend Renovate CE/EE（self-hosted）には `POST /api/v1/repos/{org}/{repo}/-/jobs/run` がありますが、SaaS 版では使えません
- ログインは GitHub OAuth のみ

そのため Mend 側は認証済みブラウザから UI を操作しています。内部 API が判明すれば Playwright を捨てられます（`bun run observe` 参照）。

## 前提

1. **[cookiejar-server](https://github.com/takumi3488/cookiejar-server) が動いていること**（Writer と Reader の両方）
2. **[putting-cookie-in-jar](https://github.com/takumi3488/putting-cookie-in-jar) が `developer.mend.io` を対象に含んでいること**、かつその拡張を入れたブラウザで一度 Mend にログイン済みであること
3. GitHub の Personal Access Token（classic なら `repo`、fine-grained なら対象 org へのアクセスと `Metadata: Read-only`）

## セットアップ

```bash
bun install
```

`.env` を作成します（Bun が自動で読み込みます）。

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_ORGS=my-org,another-org

# ローカルから動かす場合、クラスタ内 DNS には届かないので実際の到達先に合わせる
COOKIEJAR_READER_ENDPOINT=http://localhost:50051
COOKIEJAR_WRITER_ENDPOINT=https://cookiejar.onara.boo
```

## 使い方

まず `--dry-run` で検出結果を確認してください。

```bash
bun run start -- --dry-run
```

問題なければ実行します。**引数なしだと検出した全件に scan がトリガーされます。**

```bash
# まず 1 件だけ試す
bun run start -- --limit 1

# 全件実行
bun run start
```

### フラグ

| フラグ | 説明 |
|---|---|
| `--dry-run` | scan をトリガーせず、対象リポジトリの一覧だけを表示する |
| `--org <a,b>` | `GITHUB_ORGS` を上書きする |
| `--limit <n>` | scan をトリガーする最大件数（org 横断の合計）。誤爆防止の安全弁 |
| `--verbose`, `-v` | debug レベルのログも出す |
| `--help`, `-h` | ヘルプを表示する |

### 環境変数

| 変数 | 必須 | 既定値 | 用途 |
|---|---|---|---|
| `GITHUB_TOKEN` | ✓ | | GitHub PAT |
| `GITHUB_ORGS` | ✓ | | 対象 org（カンマ区切り） |
| `COOKIEJAR_READER_ENDPOINT` | | `http://cookiejar-reader.default.svc.cluster.local:50051` | Reader（gRPC）の接続先 |
| `COOKIEJAR_WRITER_ENDPOINT` | | `https://cookiejar.onara.boo` | Writer（HTTP）の接続先 |
| `COOKIEJAR_HOSTS` | | `developer.mend.io` | Cookie を読み出す host。カンマ区切りで複数指定でき、先頭が Mend の host |
| `COOKIEJAR_WRITE_BACK` | | `true` | 更新された Cookie を書き戻すか |
| `COOKIEJAR_TIMEOUT_MS` | | `10000` | cookiejar への通信タイムアウト |
| `DISCORD_WEBHOOK_URL` | | | ログインが必要になったときの通知先。未設定なら通知しない |
| `MEND_BASE_URL` | | `https://developer.mend.io` | EU リージョンなどで変更 |
| `MEND_REPO_LIST_PATH` | | `/orgs/github/{org}/repos` | リポジトリ一覧のパス |
| `MEND_HEADLESS` | | `true` | `false` でブラウザを表示してデバッグ |
| `LOG_FORMAT` | | | `json` で常に JSON Lines（既定は非 TTY 時に自動） |

`COOKIEJAR_HOSTS` に `developer.mend.io,github.com` のように複数指定すると、GitHub の Cookie もブラウザに注入されます（拡張は github.com も対象にしているため）。

> **注意**: cookiejar に保存される際の host キーは「Cookie の `domain` 属性の実際の値」です。Mend の Cookie が host-only なら `developer.mend.io`、`Domain` 属性付きなら `.developer.mend.io` になります。既定値で Cookie が見つからない場合は `COOKIEJAR_HOSTS` を調整してください。

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 正常（検出 0 件 / 全件成功 / dry-run） |
| 1 | 一部の scan トリガーが失敗、または org 単位で処理できなかった |
| 2 | 検出したが全件失敗 |
| 3 | 継続不能（設定不備・GitHub 認証エラー・Mend セッション失効・cookiejar 到達不能） |

## 内部 API の調査

Mend の UI 構成は公開されていないため、リポジトリ一覧のパス（`MEND_REPO_LIST_PATH`）やテーブル構造の既定値は暫定です。実物を確認するには：

```bash
bun run observe
```

cookiejar から Cookie を取ってブラウザを開き、リポジトリ一覧の表示と「Run Renovate scan」クリック時の通信を `./.mend/observed-api.json` と `./.mend/observe.har` に記録します。**scan は実際に Renovate ジョブを起動するので、必ず 1 リポジトリだけで試してください。**

内部 API のエンドポイントが判明すれば Playwright を捨てて `fetch` だけで動かせるようになり、イメージサイズが劇的に小さくなります。

## Docker

```bash
docker build -t renovate-rerunner .

docker run --rm --ipc=host --env-file .env renovate-rerunner --dry-run
```

`--ipc=host`（または `--shm-size=1gb`）は、コンテナ既定の `/dev/shm`（64MB）が小さく Chromium がクラッシュしやすい問題への対処です。

ベースは `node:24-bookworm-slim` に **Chromium Headless Shell だけ**を入れた構成で、**1.4GB** です。Playwright 公式イメージ（`mcr.microsoft.com/playwright`）は全ブラウザ同梱で 2.9GB あり、後から `rm` してもベースのレイヤーは残るため pull サイズが減りません。CronJob として毎回 pull されるので、必要なものだけを入れる構成にしています。

- `playwright install` は **`npx`（node）で実行**しています。`bunx` 経由だと ARM64 Docker で Bun 1.2 以降ほぼ確実にハングする既知の不具合（[oven-sh/bun#16708](https://github.com/oven-sh/bun/issues/16708)）があるためです
- **`Dockerfile` の `playwright@x.y.z` と `package.json` の `playwright` のバージョンは必ず一致させてください**
- headless shell しか入っていないため、**コンテナ内では `MEND_HEADLESS=false` が使えません**（headful デバッグはローカルで行ってください）
- 非 root（`runner`, uid 1001）で実行します

## Kubernetes

`kubernetes_manifests` リポジトリに CronJob として定義されています。cookiejar-reader と同じ `default` namespace に置き、クラスタ内 DNS で接続します。

- `GITHUB_TOKEN` と `DISCORD_WEBHOOK_URL` は OpenBao の `k8s/local/renovate-rerunner-secret` から ExternalSecret 経由で渡ります
- 誤爆防止のため `--limit` を付けて起動します

## 既知の制約

- **cookiejar は Cookie の有効期限を保存しません。** サーバー側の `entity.Cookie` に `MaxAge` フィールドが無く、保存前に破棄されるためです。よって取得した Cookie は必ずセッション Cookie として扱われ、**期限による失効の事前判定はできません**。失効しているかどうかは実際に Mend を開いてログイン画面にリダイレクトされるかで判定しています。
- **Mend の UI 変更で壊れる可能性があります。** 公開 API が無いため UI に依存しています。壊れた場合は黙って続行せず明確なエラーで停止するので、`bun run observe` で再調査してください。
- 判別できない Renovate ステータス文字列が現れた場合、**scan の対象にはせず** warn ログを出します。Mend が新しいステータスを返し始めたときに誤って scan を撃たないためです。
- Cookie の更新は、ブラウザ拡張が対象サイトを開いている間のポーリングに依存します。人間が Mend を開かない限り Cookie は更新されません。

## 開発

```bash
bun test          # ユニットテスト
bun run fmt       # フォーマットチェック（biome）
bun run fmt:fix   # フォーマット適用
bun run lint      # lint（oxlint）
bun run typecheck # 型チェック（tsgo）
```

proto から gRPC クライアントを再生成する場合：

```bash
bunx buf generate   # proto/ → src/gen/
```

Playwright を使う部分（`src/mend/auth.ts`, `src/mend/client.ts`, `scripts/`）は CI で実行しません。テストの対象は純粋関数と、依存性注入で差し替え可能な境界です。特に以下がこのツールの中核で、テストもそこに集中しています。

- `src/match.ts` — GitHub と Mend の突合ロジック
- `src/cookiejar/cookie-string.ts` — Reader が返す Cookie ヘッダー文字列と Playwright の Cookie 配列の相互変換
