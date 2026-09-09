# sb.sb 论坛 RSS 推送

> 基于论坛公开的 RSS，自动将新帖推送到 Telegram 频道，并提供支持正则的关键词订阅机器人。
>
> 发布帖：[《📢 新帖推送频道》](https://sb.sb/t/187/)（作者 [@ss](https://sb.sb/u/297/)，上线日期 2026-08-21）

<p align="center">
  <strong>论坛新帖实时推送 · 关键词正则订阅 · 零爬虫</strong>
</p>

<p align="center">
  <a href="https://github.com/dianso/sb.sb/releases/latest"><img src="https://img.shields.io/github/v/release/dianso/sb.sb?sort=semver&style=flat-square&label=Release" alt="Release"></a>
  <a href="https://github.com/dianso/sb.sb/actions/workflows/ci.yml"><img src="https://github.com/dianso/sb.sb/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/dianso/sb.sb/pkgs/container/sb.sb"><img src="https://img.shields.io/badge/ghcr.io-dianso%2Fsb.sb-informational?logo=docker&style=flat-square" alt="GHCR"></a>
</p>

***

## 📦 获取 · 部署

预编译二进制与容器镜像均已发布：

- **GitHub Release**（amd64 / arm64 / Alpine / Windows）：https://github.com/dianso/sb.sb/releases/latest
- **容器镜像（ghcr.io）**：
  - Debian 版（glibc）：`docker pull ghcr.io/dianso/sb.sb:latest`
  - Alpine 版（musl）：`docker pull ghcr.io/dianso/sb.sb:alpine`

> 容器镜像由 [CI](https://github.com/dianso/sb.sb/actions/workflows/ci.yml) 自动构建，覆盖 amd64 / arm64 双架构。

### Docker 运行

```bash
docker run -d --name sb-bot --restart=always \
  -e SB_DB_HOST=... -e SB_DB_PASSWORD=... \
  -e SB_TELEGRAM_TOKEN=... -e SB_TELEGRAM_CHAT_ID=... \
  ghcr.io/dianso/sb.sb:latest
```

> **部署前请先准备好 PostgreSQL**：本服务将帖子、关键词订阅与推送记录持久化到 PostgreSQL（连接参数见下方「快速开始 · 环境要求」）。表结构会在首次启动时自动创建（`ensureSbTable()`），无需手工执行 SQL，但需保证配置的数据库账号具备建表权限。

***

## 特性

- **新帖推送频道**：论坛有新帖自动推送到 Telegram 频道，随时订阅随时退订。
- **关键词订阅机器人**：私聊机器人订阅关键词（支持正则），只有新帖命中你关心的词才单独推送给你。
- **不使用爬虫**：全程严格按照论坛对外公开的 RSS 订阅，未直接抓取任何页面数据。
- **低占用**：RSS 每 5 分钟更新一次，后端轮询周期内仅做轻量解析 + 本地去重，对源站和自身带宽都友好。

***

### 订阅入口

| 类型       | 链接 / 账号                    | 说明                   |
| -------- | ------------------------- | ---------------------- |
| 推送频道     | https://t.me/sb_sb_bbs     | 论坛所有新帖实时推送          |
| 关键词机器人  | https://t.me/sb_sb_bbs_bot | 私聊订阅关键词，命中才推送（含正则） |

### 机器人命令

| 操作                 | 说明          |
| ------------------ | ----------- |
| 直接发送任意文本            | 添加关键词（支持正则） |
| /list             | 查看已订阅的关键词   |
| /del <编号>         | 按编号删除关键词   |
| /start / /help  | 使用说明       |

> 示例：私聊发送 vps，之后标题包含 vps 的新帖就会推给你；发送 vps|gpt 可匹配其中任意关键词。

***

## 运行机制

论坛公开 RSS --(每 3 分钟轮询)--> 解析参数 --> PostgreSQL 去重入库 --> 新帖推送 TG 频道 + 关键词命中私聊推送

- **数据来源**：订阅全站 rss.xml 及各分类节点的 go/<分类>/rss.xml（共 15 个分类源）。
- **去重**：guid 为主键，INSERT ... ON CONFLICT (guid) DO NOTHING RETURNING 仅返回真正新插入的行，天然区分「新帖」与「已见帖」。
- **条件请求**：携带 ETag 发起 If-None-Match，内容无变化时源站返回 304，零解析成本。
- **推送解耦**：pushed_at IS NULL 的记录每轮重试，TG 发送失败不丢消息。
- **关键词匹配**：新帖标题 + 分类对全部用户关键词做不区分大小写的正则匹配，命中且未推送过的私聊发送，全量去重防重推。

***

## 技术栈

| 技术                  | 说明                                    |
| ------------------- | ------------------------------------- |
| Bun                 | 运行时 + SQL（Bun.SQL 连接 PostgreSQL）     |
| TypeScript          | strict 类型基线                           |
| PostgreSQL          | 帖子、关键词订阅、推送记录的持久化存储                |
| Telegram Bot API    | getUpdates 长轮询接收指令 + sendMessage 推送 |

***

## 快速开始

### 环境要求

- Bun 1.4+
- PostgreSQL（单机即可，库可通过 ensureSbTable() 自动建表，无需手动执行 SQL）

### 配置

复制 .env.example 为 .env 并填入真实凭据（Bun 启动时自动加载）。

- 非敏感参数（host / port / user / name）缺失时回退默认值便于开发；敏感凭据（密码、token、频道）只从 env 读取，缺失即为空并启动时报错退出，避免凭据明文写入代码。
- 密钥请勿提交到版本库，.env 已在 .gitignore 中排除。

### 运行

bun install
bun run start   # 独立常驻进程

### 脚本

| 命令                   | 说明             |
| -------------------- | -------------- |
| bun run start        | 启动推送服务         |
| bun run typecheck    | TypeScript 类型检查 |

***

## 数据表

| 表                     | 说明                             |
| -------------------- | ------------------------------ |
| sb_posts             | 帖子（guid 主键，含推送状态）           |
| sb_keywords          | 用户关键词订阅（chat_id + keyword 唯一） |
| sb_keyword_pushes    | 关键词推送记录（guid + chat_id 防重推）   |

***

## 说明

- 当初看到论坛官方暂时没有推送功能，就用 AI 写了一个；官方若后续提供该能力，以官方为准。
- 本项目为独立进程，不依赖任何主服务；config / error / task 等均为本地实现。
- 有问题欢迎到发布帖回复反馈：https://sb.sb/t/187/