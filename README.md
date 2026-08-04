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
                               └───────────┬────────────┘      （内部 API を直接呼ぶ）
                                           │ Cookie が失効していたら
                                           ↓
                                    Discord Webhook
                                （「ログインしてください」と通知）
```

**このツール自身は Mend にログインできません。** セッション Cookie はブラウザ拡張が cookiejar-server に保存したものを使います。失効したら Discord に通知が飛ぶので、**人間がブラウザで developer.mend.io を開いてログインし直せば、拡張が自動で cookiejar を更新します**。CLI 側に GitHub のパスワードや TOTP を持たせる必要はありません。

### なぜ内部 API を直接叩くのか

developer.mend.io の**公開 API は GitHub Secrets 管理専用**です（[Developer Platform API 1.0](https://api-docs.mend.io/developer-platform/1.0) の `/repos|orgs/.../secrets` 系 8 エンドポイントのみ）。リポジトリ一覧の取得・Renovate の enabled/disabled 状態の取得・scan のトリガーに相当する公開 API は存在しません。

- Mend の UI は非公開の内部 API を Cookie 認証で叩いています（[renovate#31306](https://github.com/renovatebot/renovate/discussions/31306)）
- Mend Renovate CE/EE（self-hosted）には `POST /api/v1/repos/{org}/{repo}/-/jobs/run` がありますが、SaaS 版では使えません
- ログインは GitHub OAuth のみ

そのため、**UI が叩いている内部 API を直接呼ぶ**方式を採っています。`x-app-id: 1` ヘッダと `mend_session` Cookie が必要です。

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
| `MEND_TRIGGER_INTERVAL_MS` | | `1000` | scan トリガー間に挟む待機時間（ミリ秒）。0 で無効 |
| `LOG_FORMAT` | | | `json` で常に JSON Lines（既定は非 TTY 時に自動） |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | | 設定するとトレースを OTLP/HTTP で送信（例: `http://otel-collector:4318`）。未設定なら計測は無効 |
| `OTEL_SERVICE_NAME` | | `renovate-rerunner` | トレースの `service.name` |
| `OTEL_SDK_DISABLED` | | | `true` でエンドポイント設定時も計測を無効化 |

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_RESOURCE_ATTRIBUTES` などの標準環境変数も SDK の既定通りに解釈されます。org 単位の処理・GitHub/Mend/cookiejar への各 API 呼び出しが span として記録され、属性には org 名・リポジトリ名・件数・HTTP ステータス・終了コードのみを含め、認証情報は含めません。

個別リポジトリの scan 失敗（409/500/ネットワークエラー）は `mend.trigger_scan` span を ERROR にせず、属性（`rerunner.trigger.ok` / `http.response.status_code` など）で表現します。失敗の集計はルート span の `rerunner.failed_count` と終了コードで行うため、トレースで失敗を追う場合はそちらを参照してください。

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

`bun run observe` で、cookiejar のセッションを使ってリポジトリ一覧 API の疎通確認とレスポンス構造の確認ができます。Mend 側の構造変更で CLI が `MendUiError` で停止した場合の再調査に使ってください。

scan のトリガー（`POST /renovate/job/add`）は実際に Renovate ジョブが走るため、このスクリプトからは実行しません。トリガー時の通信を再調査する場合は、ブラウザの DevTools で developer.mend.io の Network タブを開き、UI 上で「Run Renovate scan」を 1 件だけ実行して確認してください。

## Docker

```bash
docker build -t renovate-rerunner .

docker run --rm --env-file .env renovate-rerunner --dry-run
```

ベースは `oven/bun:1.3-alpine` で、**128MB** です。内部 API を直接叩く方式に切り替えたため Playwright は不要になりました。

## Kubernetes

`kubernetes_manifests` リポジトリに CronJob として定義されています。cookiejar-reader と同じ `default` namespace に置き、クラスタ内 DNS で接続します。

- `GITHUB_TOKEN` と `DISCORD_WEBHOOK_URL` は OpenBao の `k8s/local/renovate-rerunner-secret` から ExternalSecret 経由で渡ります
- 誤爆防止のため `--limit` を付けて起動します

## 既知の制約

- **cookiejar は Cookie の有効期限を保存しません。** サーバー側の `entity.Cookie` に `MaxAge` フィールドが無く、保存前に破棄されるためです。よって取得した Cookie は必ずセッション Cookie として扱われ、**期限による失効の事前判定はできません**。失効しているかどうかは実際に API を呼んで 401/403 が返るかで判定しています。
- **Mend の内部 API が変わると壊れる可能性があります。** 公開 API が無いため内部 API に依存しています。壊れた場合は黙って続行せず明確なエラーで停止するので、`bun run observe` で再調査してください。
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

内部 API クライアント（`src/mend/client.ts`）は fetch を差し替えたユニットテストでカバーしています。CI で実行しないのは `scripts/`（対話的な調査用）だけです。テストの対象は純粋関数と、依存性注入で差し替え可能な境界です。特に以下がこのツールの中核で、テストもそこに集中しています。

- `src/match.ts` — GitHub と Mend の突合ロジック
- `src/cookiejar/cookie-string.ts` — Reader が返す Cookie ヘッダー文字列と Cookie 配列の相互変換
