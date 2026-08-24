# PaperLeaf · 纸笺 v0.0.2

PaperLeaf（中文名：纸笺）是一个用于保存、净化和离线阅读网页的个人阅读服务。v0.0.2 基于 v0.0.1 独立演进，以 Docker Compose 作为标准部署方式，同时保留 Node.js 本地启动与自动化验收能力。

> 本版本的截图将在功能验收后单独保存到 `docs/assets/v0.0.2/`；不继承 v0.0.1 的个人截图。

## 功能范围

| 模块 | 已实现功能 |
| --- | --- |
| 网页保存 | 保存原始 URL；抓取公开网页；提取标题、描述和正文；净化为安全 HTML 快照；抓取失败时保留失败原因并可重试 |
| 本地文章库 | 每篇文章保存独立 HTML 和已下载图片；远程图片下载失败时保留原地址；原网址失效后仍可阅读已归档内容 |
| 阅读器 | 三栏阅读页、目录跳转、阅读进度保存及恢复、已读/未读切换、收藏、归档、重新抓取、查看自动归档 PDF、图片放大、高亮与笔记 |
| 组织管理 | 全部、未读、归档、收藏四个视图；标签、收藏夹、标题搜索、列表和卡片视图切换 |
| 笔记管理 | 顶部“笔记”工作区；文章标题、笔记内容或高亮片段的分维度检索；双栏查看；原位编辑；跳回对应文章高亮位置 |
| 数据管理 | 批量导入 URL；导出 UTF-8 JSON 或 CSV；管理员新增/禁用用户；用户修改密码与退出登录 |
| API | Token 创建、明文查看、撤销；Hermes 兼容的保存和查询接口 |
| Edge 扩展 | Manifest V3 扩展，从当前标签页一键保存 URL 和标题 |
| 合规边界 | 不包含个人微信登录、Cookie 托管、模拟客户端或规避平台风控的抓取能力 |

## 当前交付状态

| 范围 | 状态 |
| --- | --- |
| 文章首页、阅读器、设置与独立笔记管理 | 已实现并完成本地 Web 回归。 |
| 时间轴 | 待开发，不包含页面、事件表或查询接口。 |
| 收藏夹与标签集中管理 | 待开发；当前仅有首页筛选和文章属性编辑。 |
| Hermes API、微信公众号订阅、Edge 扩展 | 本轮未测试。 |

需求、实现状态与待决冲突见 [`../docs/v0.0.2/代码审查与冲突清单.md`](../docs/v0.0.2/代码审查与冲突清单.md)。

## 运行架构

```text
浏览器 / Edge 扩展 / Hermes
             |
        PaperLeaf 服务 (3080)
          |            |
../data/paperleaf.sqlite    ../Library/{用户名}/{文章名称}/
                            {文章名称}.html + {文章名称}.pdf + image-*.*
```

- SQLite 保存账户、Token、文章元数据、状态、阅读进度和高亮笔记；Token 认证哈希与用于所属用户查看的 AES-GCM 密文分开保存。
- 运行数据与文章文件库均与版本代码分离。默认本地路径分别为项目根目录的 `data/` 与 `Library/`；Docker 中分别映射为 `/app/data` 和 `/var/lib/paperleaf/library`。
- 每次成功收录或重新抓取，都会把净化后的网页内容保存为 `{文章名称}.html`，并由 Chromium 自动生成同目录的 `{文章名称}.pdf`；阅读器顶部“查看 PDF”只打开已生成的本地归档文件。

## Docker Compose 部署

### 前置条件

- Docker Engine 24+ 和 Docker Compose v2。
- 至少保留项目根目录 `data/` 与 `Library/` 的写入权限和备份策略。
- Node.js 仅用于本地开发和测试；容器自身使用 Node 24，不依赖宿主机 Node。

### 首次启动

将本版本目录与同级的 `data/`、`Library/` 一起放到 Docker 主机；Docker 构建、Compose 与部署环境变量模板均集中在 `docker/`，应用源码保留在版本根目录。Compose 将同级的运行数据与文章文件库映射到容器持久化路径。

1. 在 `v0.0.2/` 目录复制环境变量模板：

   ```powershell
   Copy-Item docker/.env.example docker/.env
   ```

2. 编辑 `docker/.env`。默认用户名为 `admin`、默认密码为 `admin123`；可修改 `PAPERLEAF_ADMIN_USER` 与 `PAPERLEAF_ADMIN_PASSWORD`，Compose 会将它们传入容器用于首次初始化。`.env` 不应提交或上传到公开位置。

3. 从 `v0.0.2/` 启动：

   ```powershell
   docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --build
   docker compose --env-file docker/.env -f docker/docker-compose.yml ps
   ```

4. 打开 `http://<服务器地址>:3080`，使用 `docker/.env` 中的管理员账户登录。

服务只暴露一个端口：`${PAPERLEAF_PORT:-3080}` 到容器内 `3080`。健康检查接口为 `/api/health`。

### 可直接使用的 Compose YAML

本仓库的 [docker-compose.yml](docker/docker-compose.yml) 位于 `docker/`。保留该目录与上一级的 `server.mjs`、`public/`、`package.json` 的相对关系，即可直接执行下方启动命令：

```yaml
# Compose 服务定义；paperleaf 是 Compose 内部的服务标识。
services:
  paperleaf:
    # 构建应用镜像。
    build:
      # 构建上下文为 v0.0.2 源码目录；保持 docker/ 与源码目录的当前相对结构。
      context: ..
      # Dockerfile 相对于构建上下文的位置。
      dockerfile: docker/Dockerfile
    # 容器命名规则：PaperLeaf_v<版本号>，便于区分多个版本。
    container_name: PaperLeaf_v0.0.2
    # Docker 或宿主机重启后自动恢复服务；手动停止时不自动启动。
    restart: unless-stopped
    # 容器对外端口映射；左侧可在 docker/.env 通过 PAPERLEAF_PORT 修改，右侧固定为应用端口 3080。
    ports:
      - "${PAPERLEAF_PORT:-3080}:3080"
    # 应用运行环境变量。
    environment:
      # 监听容器内全部网卡，Docker 才能转发宿主机请求。
      HOST: 0.0.0.0
      # 应用在容器内固定监听的端口；应与 ports 右侧保持一致。
      PORT: 3080
      # 容器内的 SQLite 数据目录；由下方 data 数据卷持久化，通常无需修改。
      PAPERLEAF_DATA_DIR: /app/data
      # 首次初始化时创建的管理员用户名；默认 admin，可在 docker/.env 修改。
      PAPERLEAF_ADMIN_USER: ${PAPERLEAF_ADMIN_USER:-admin}
      # 首次初始化时创建的管理员密码；默认 admin123，可在 docker/.env 修改。
      PAPERLEAF_ADMIN_PASSWORD: ${PAPERLEAF_ADMIN_PASSWORD:-admin123}
      # 容器内的文章归档目录，保存 HTML、PDF 和文章图片；由下方 Library 数据卷持久化。
      PAPERLEAF_ARCHIVE_DIR: /var/lib/paperleaf/library
    # 将宿主机的持久化目录挂载到容器；不要改为 Docker 匿名卷，以免升级时难以定位与备份数据。
    volumes:
      # 宿主机 data：SQLite、用户设置和 Token 加密密钥；对应 PAPERLEAF_DATA_DIR。
      - ../../data:/app/data
      # 宿主机 Library：每篇文章的 HTML、PDF 与本地图片；对应 PAPERLEAF_ARCHIVE_DIR。
      - ../../Library:/var/lib/paperleaf/library
    # Docker 健康检查配置。
    healthcheck:
      # 访问应用健康接口，HTTP 成功即判定本次检查通过。
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3080/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
      # 每 30 秒检查一次。
      interval: 30s
      # 单次检查最多等待 5 秒。
      timeout: 5s
      # 容器启动后的前 10 秒不计入失败次数。
      start_period: 10s
      # 连续失败 3 次后将容器标记为 unhealthy。
      retries: 3
```

配套 `.env` 至少包含以下内容：

```dotenv
PAPERLEAF_PORT=3080
PAPERLEAF_ADMIN_USER=admin
PAPERLEAF_ADMIN_PASSWORD=admin123
```

在 `v0.0.2/` 目录执行：

```powershell
   docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --build
   docker compose --env-file docker/.env -f docker/docker-compose.yml ps
```

### 持久化与备份

`docker/docker-compose.yml` 使用两个宿主机目录挂载，目录相对于该 Compose 文件：

| 宿主机路径 | 容器路径 | 内容 | 备份要求 |
| --- | --- | --- | --- |
| `../../data` | `/app/data` | SQLite 数据库及其 WAL 文件 | 必须与应用停止或 SQLite 一致性策略配合备份 |
| `../../Library` | `/var/lib/paperleaf/library` | 同名 HTML、同名 PDF 与本地图片 | 必须和 `data/` 一起备份 |

恢复时同时还原 `data/` 和 `Library/`，再执行 `docker compose --env-file docker/.env -f docker/docker-compose.yml up -d`。不要只恢复数据库或只恢复文章文件库。

### NAS 部署建议

- 将整个 `PaperLeaf/` 根目录放到 NAS 的 Docker 项目路径，保留 `v0.0.2/`、`data/`、`Library/` 和 `docs/` 的相对关系。
- 反向代理负责 HTTPS；不要将未配置 HTTPS 的管理端直接暴露至公网。
- 通过 `.env` 配置端口和初始密码，不在 Compose 文件中写明文密码。
- 更新前备份 `data/`、`library/` 和当前版本目录；确认 `docker compose ps` 显示 `healthy` 后再清理旧镜像或旧版本。

## Edge 扩展

1. 在 Web 设置页创建一个具有 `items:write` 权限的 Token。
2. 在 Edge 打开 `edge://extensions`，开启“开发人员模式”。
3. 选择“加载解压缩的扩展”，选择 `v0.0.2/extension/`。
4. 在扩展弹窗填写服务地址和 Token，然后保存当前标签页。

扩展将 Token 保存于 `chrome.storage.local`，服务端仅接受扩展发起的受 Token 鉴权请求。NAS 部署时必须为公网访问配置 HTTPS。

## 版本内文件

| 路径 | 用途 |
| --- | --- |
| `server.mjs` | Node HTTP 服务、SQLite、抓取、归档与 API |
| `public/` | Web 前端静态资源 |
| `extension/` | Edge Manifest V3 扩展 |
| `scripts/` | 合规数据维护脚本 |
| `docker/` | Dockerfile、Compose 配置、Docker 构建忽略规则与部署环境变量模板 |
| `assets/screenshots/` | README 系统截图 |

需求文档、开发日志和组件规范属于本地项目文档，不随后续 GitHub Docker 发布仓库上传。发布时需创建独立 Docker 发布目录并重新核验上传边界。
