# PaperLeaf v0.0.2 GitHub Docker 发布内容

v0.0.2 完成后，在版本目录下新建独立的 Docker 发布目录作为 GitHub 仓库根目录。该目录只复制容器运行所需文件，不将本地开发目录直接初始化为 Git 仓库。

## 发布目录包含

- `server.mjs`、`public/`、`package.json`（Docker 镜像安装运行依赖所必需）
- `docker/Dockerfile`、`docker/docker-compose.yml`、`docker/.env.example`
- `README.md`、`.gitignore`、`docker/Dockerfile.dockerignore`
- 经确认可公开或私有发布的截图及第三方许可文件

## 明确排除

- `data/`、`library/`、`.env` 和任何 SQLite WAL/SHM 文件
- `tests/`、`extension/`、`scripts/` 及本地 npm 开发依赖
- 根目录 `docs/`、`backup/`、`dependencies/`、`sample/`、`skill/`
- 未经单独确认的截图、账号、Token、Cookie、文章快照或其他个人资料

## 发布前核验

1. 检查发布目录的 `git ls-files`，确认仅有上述白名单文件。
2. 检查文本中不含真实账号、邮箱、Token、密码或个人路径。
3. 使用独立的 `.gitignore` 排除 `data/`、`Library/`、`docker/.env` 与数据库日志。
4. 在 Docker 构建、健康检查与 README 部署步骤验证通过后，再创建私有 GitHub 仓库并推送对应版本标签。
