# ============================================================================
# sb.sb 论坛 RSS 推送 —— 多阶段构建（go 无依赖，纯 Bun 编译）
#
# 构建阶段：oven/bun:latest 交叉编译，基于当前构建机架构原生执行，无需 QEMU
#   可通过 build-arg 覆盖 BUN_SUFFIX：""（debian glibc） 或 "-musl"（alpine）
# 运行阶段：可覆盖 RUNTIME_IMAGE（debian:trixie-slim 或 alpine）
# ============================================================================
ARG BUN_IMAGE=oven/bun:latest
ARG RUNTIME_IMAGE=debian:trixie-slim
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS build
WORKDIR /app
# 仅拷贝构建所需文件，保持上下文最小化
COPY package.json tsconfig.json ./
COPY src ./src

ARG TARGETARCH
ARG BUN_SUFFIX=""
# bun 目标名映射：amd64 -> x64，arm64 -> aarch64
RUN ARCH=$(case "$TARGETARCH" in amd64) echo x64;; arm64) echo aarch64;; esac) \
    && bun build src/index.ts \
       --compile \
       --target="bun-linux-${ARCH}${BUN_SUFFIX}" \
       --outfile=/out/sb-bot

# ------- 运行阶段 -------
FROM --platform=$TARGETPLATFORM ${RUNTIME_IMAGE}

# CA 证书：Telegram / 论坛均走 HTTPS，debian/alpine 镜像默认不含
RUN set -eux; \
    if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache ca-certificates; \
    else \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates \
        && rm -rf /var/lib/apt/lists/*; \
    fi

COPY --from=build /out/sb-bot /usr/local/bin/sb-bot

WORKDIR /data
USER 65534
ENTRYPOINT ["/usr/local/bin/sb-bot"]