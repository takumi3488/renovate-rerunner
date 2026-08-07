# 依存解決ステージ
FROM oven/bun:1.3@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /app

COPY package.json bun.lock* ./

# --production で devDependencies（biome / oxlint / buf / tsgo）を除外する。
# proto の生成物は src/gen にコミットしてあるのでビルド時に buf は要らない。
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --production

# ランタイムステージ
#
# 内部 API を直接叩く方式に切り替えたため Playwright は不要になり、
# イメージは 100MB 台になった。
FROM oven/bun:1.3-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock* ./
COPY proto ./proto
COPY src ./src
COPY scripts ./scripts

# root で動かさない。
RUN adduser -D -u 1001 runner
USER runner

ENTRYPOINT ["bun", "run", "src/index.ts"]
