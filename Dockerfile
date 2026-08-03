# 依存解決ステージ
FROM oven/bun:1.3 AS deps
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
FROM oven/bun:1.3-alpine AS runtime
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
