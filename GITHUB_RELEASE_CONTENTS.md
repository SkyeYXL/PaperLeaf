# PaperLeaf v0.0.1 Docker 发布范围

本仓库是 PaperLeaf（纸笺）v0.0.1 的 Docker 发布版本，仅包含运行服务所需的源代码、容器配置、开源图标许可说明和获作者授权发布的界面截图。

## 仓库包含

- `server.mjs` 与 `public/`：服务端和 Web 前端
- `Dockerfile`、`docker-compose.yml`、`.env.example`：容器部署配置
- `assets/screenshots/homepage-list.png`：获作者授权发布的首页截图
- `README.md`：部署、备份和 API 使用说明

## 部署后创建但不提交

- `data/`：SQLite 数据库、会话、Token、用户偏好和文章元数据
- `library/`：每篇文章的 HTML 快照、下载图片和后续 PDF 文件
- `.env`：部署者自己的端口和初始管理员密码

## 明确不包含

- 本地开发依赖、npm 脚本、测试、浏览器扩展和维护脚本
- 本地开发文档、备份、未获授权发布的历史截图及任何其他个人资料
- 已抓取文章、数据库、Token、Cookie、账号或密码

提交前执行 `git status --ignored`，确认只有本说明列出的发布文件进入版本控制。
