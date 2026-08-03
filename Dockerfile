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
# Playwright 公式イメージ（mcr.microsoft.com/playwright）は全ブラウザ同梱で 2.9GB あり、
# 後から rm しても元のレイヤーは残るため pull サイズが減らない。CronJob として毎回 pull される
# ことを考えて、Debian slim に Chromium Headless Shell だけを入れて 1.4GB に抑えている。
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# headless shell と Chromium の実行に必要なシステムライブラリだけを入れる。
# playwright install は bunx ではなく node の npx で実行する。bunx 経由だと ARM64 の Docker で
# Bun 1.2 以降ほぼ確実にハングする既知の不具合があるため（oven-sh/bun#16708、未修正）。
# バージョンは package.json の playwright と必ず一致させること。
RUN npx --yes playwright@1.62.1 install --with-deps --only-shell chromium \
    && rm -rf /root/.npm /var/lib/apt/lists/* /tmp/*

COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock* ./
COPY proto ./proto
COPY src ./src
COPY scripts ./scripts

# root で Chromium を動かさない。ブラウザは /ms-playwright に置いてあるので誰でも読める。
RUN useradd --create-home --shell /bin/bash runner \
    && chmod -R a+rX /ms-playwright
USER runner

ENTRYPOINT ["bun", "run", "src/index.ts"]
