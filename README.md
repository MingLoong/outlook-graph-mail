# GongXi Mail (廾匸邮箱)

使用 Microsoft OAuth2 进行邮箱收取的 API 服务。

## 技术栈

- **后端**: Fastify 5 + TypeScript + Prisma 6
- **数据库**: PostgreSQL
- **缓存**: Redis
- **前端**: React + Ant Design + Vite

## 项目结构

```
├── server/                      # 后端服务
│   ├── src/
│   │   ├── config/             # 环境配置
│   │   ├── lib/                # 核心库
│   │   ├── plugins/            # Fastify 插件
│   │   ├── modules/            # 业务模块
│   ├── prisma/                 # 数据库 Schema
│   └── package.json
├── web/                         # 前端管理面板
├── scripts/                     # 离线包启动脚本
├── docker-compose.yml           # 生产部署（拉取 GHCR 镜像）
├── docker-compose.build.yml     # 本地源码构建覆盖
├── .env.example                 # Compose / 部署环境变量模板
└── Dockerfile
```

## 快速开始

### Docker Compose 部署（推荐）

默认从 GitHub Container Registry 拉取已发布镜像，并启动 **app + PostgreSQL + Redis**。应用监听 **8898**。

#### 1. 准备环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少修改以下项（生产环境禁止使用示例默认值）：

| 变量 | 要求 |
|------|------|
| `JWT_SECRET` | ≥ 32 字符随机串 |
| `ENCRYPTION_KEY` | **恰好 32** 字符 |
| `ADMIN_PASSWORD` | 强密码（不可为 `admin123`） |
| `POSTGRES_PASSWORD` | 数据库密码（勿含 `@` `:` 等 URL 特殊字符） |

可选：

| 变量 | 说明 | 默认 |
|------|------|------|
| `IMAGE_TAG` | 镜像标签，如 `2.0.0` / `latest` | `latest` |
| `APP_PORT` | 宿主机映射端口 | `8898` |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `POSTGRES_HOST_PORT` | 宿主机 Postgres 端口 | `127.0.0.1:15432` |
| `CORS_ORIGIN` | 跨域来源（逗号分隔） | 空 |

#### 2. 启动

若 GHCR 包为私有，需先登录（公开包可跳过）：

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
```

```bash
# 拉取镜像并后台启动
docker compose up -d

# 查看状态 / 日志
docker compose ps
docker compose logs -f app
```

#### 3. 访问与健康检查

- 管理面板 / API：http://localhost:8898  
- 健康检查：

```bash
curl http://localhost:8898/health
# {"success":true,"data":{"status":"ok"}}
```

#### 4. 常用运维命令

```bash
# 指定版本部署
# 在 .env 中设置 IMAGE_TAG=2.0.0 后：
docker compose pull
docker compose up -d

# 停止（保留数据卷）
docker compose down

# 停止并删除数据卷（危险：清空数据库）
docker compose down -v

# 仅重启应用
docker compose restart app
```

#### 5. 从源码本地构建（可选）

不拉 GHCR、用当前仓库 Dockerfile 构建：

```bash
cp .env.example .env   # 同样需要配置密钥
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

#### 6. 服务说明

| 服务 | 容器名 | 说明 |
|------|--------|------|
| `app` | `ogm-app` | 应用（Fastify + 静态前端），端口 `APP_PORT→8898` |
| `postgres` | `ogm-postgres` | PostgreSQL 16，数据卷 `postgres_data` |
| `redis` | `ogm-redis` | Redis 7，仅内网，数据卷 `redis_data` |

应用启动时会执行 `prisma db push` 同步表结构。日志目录挂载为卷 `app_logs`。

> **安全提示**：不要把生产 `.env` 提交进 Git。`JWT_SECRET` / `ENCRYPTION_KEY` / `ADMIN_PASSWORD` / `POSTGRES_PASSWORD` 必须通过环境或 `.env` 注入。

### 打标签发布（Docker 镜像 + 版本包）

推送 `v*` 标签会触发 GitHub Actions，自动：

1. 编译前后端
2. 打包 `tar.gz` / `zip` 版本包并上传到 GitHub Release
3. 构建并推送 Docker 镜像到 `ghcr.io/trumpleond/outlook-graph-mail`

```bash
git tag v2.0.0
git push origin v2.0.0
```

拉取镜像：

```bash
docker pull ghcr.io/trumpleond/outlook-graph-mail:2.0.0
# 或
docker pull ghcr.io/trumpleond/outlook-graph-mail:latest
```

Compose 中通过 `.env` 的 `IMAGE_TAG` 选用版本，例如 `IMAGE_TAG=2.0.0`。

## 开发质量检查

```bash
# 前端
cd web
npm run lint
npm run build

# 后端
cd ../server
npm run lint
npm run lint:fix
npm run build
npm run test
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| NODE_ENV | 环境 | development |
| PORT | 端口 | 8898 |
| DATABASE_URL | PostgreSQL 连接 | - |
| REDIS_URL | Redis 连接 | - |
| CORS_ORIGIN | 允许跨域来源（逗号分隔） | 开发环境默认放开 |
| JWT_SECRET | JWT 密钥 (≥32字符) | - |
| JWT_EXPIRES_IN | Token 过期时间 | 2h |
| ENCRYPTION_KEY | 加密密钥 (32字符) | - |
| ADMIN_USERNAME | 默认管理员用户名 | admin |
| ADMIN_PASSWORD | 默认管理员密码（生产禁止使用默认值） | - |
| ADMIN_LOGIN_MAX_ATTEMPTS | 管理员连续失败最大次数 | 5 |
| ADMIN_LOGIN_LOCK_MINUTES | 登录失败锁定分钟数 | 15 |
| ADMIN_2FA_SECRET | 可选管理员 TOTP Base32 密钥 | - |
| ADMIN_2FA_WINDOW | TOTP 时间窗口（步长） | 1 |
| API_LOG_RETENTION_DAYS | API 日志保留天数 | 30 |
| API_LOG_CLEANUP_INTERVAL_MINUTES | API 日志清理间隔（分钟） | 60 |
| MAIL_CACHE_TTL_API_SECONDS | 外部 API 邮件缓存 TTL（秒，0=禁用读缓存） | 60 |
| MAIL_CACHE_TTL_PANEL_SECONDS | 管理面板邮件缓存 TTL（秒，0=禁用读缓存） | 180 |
| MAIL_CACHE_RETENTION_DAYS | 邮件缓存保留天数（定时清理） | 7 |
| MAIL_CACHE_CLEANUP_INTERVAL_MINUTES | 邮件缓存清理间隔（分钟） | 360 |

## 枚举约定

为避免前后端不一致，所有枚举统一使用大写：

| 类型 | 枚举值 |
|------|--------|
| 管理员角色 | `SUPER_ADMIN` / `ADMIN` |
| 管理员/API Key 状态 | `ACTIVE` / `DISABLED` |

## 邮件拉取策略（分组级）

邮箱分组支持配置 `fetchStrategy`，同组邮箱统一使用该策略：

| 策略 | 行为 |
|------|------|
| `GRAPH_FIRST` | 先 Graph，失败后回退 IMAP |
| `IMAP_FIRST` | 先 IMAP，失败后回退 Graph |
| `GRAPH_ONLY` | 仅 Graph，不回退 |
| `IMAP_ONLY` | 仅 IMAP，不回退 |

说明：
- `IMAP_ONLY` 与所有第三方 IMAP 邮箱不支持“清空邮箱（process-mailbox）”，该操作依赖 Graph API（仅 Outlook 账号可用）。
- 拉取策略仅对 **Outlook 账号**生效；第三方 IMAP 邮箱始终走密码/授权码直连，与策略无关。

## 第三方邮箱支持

除 Outlook（OAuth2）外，支持通过 **IMAP 密码/授权码** 接入第三方邮箱：

| 提供商 | IMAP 服务器 | 认证方式 | 说明 |
|--------|------------|----------|------|
| `outlook` | outlook.office365.com | OAuth2 (clientId + refreshToken) | 原有方式 |
| `gmail` | imap.gmail.com | 应用专用密码 | 需在 Gmail 设置中开启 IMAP 并生成应用专用密码 |
| `qq` | imap.qq.com | 授权码 | 需在 QQ 邮箱设置中开启 IMAP 服务获取授权码 |
| `163` | imap.163.com | 授权码 | 需在 163 邮箱设置中开启 IMAP 服务 |
| `126` | imap.126.com | 授权码 | 需在 126 邮箱设置中开启 IMAP 服务 |
| `yahoo` | imap.mail.yahoo.com | 应用密码 | 需在 Yahoo 账户安全设置中生成应用密码 |
| `aliyun` | imap.aliyun.com | 登录密码/授权码 | 阿里邮箱 |
| `custom` | 自定义 | 密码 | 手动填写 IMAP 服务器地址和端口 |

### 特性

- **域名自动识别**：批量导入时选择「智能识别」，按邮箱域名（如 `@gmail.com`、`@qq.com`）自动判断账号类型，支持混合文件导入。
- **文件夹映射**：不同提供商的垃圾箱/已删除文件夹名不同（如 Gmail 垃圾箱为 `[Gmail]/Spam`、QQ 为 `Junk`），系统按提供商自动映射，`mailbox=junk` 参数在所有提供商下通用。
- **管理面板**：添加邮箱时选择提供商后自动填充 IMAP 配置；输入邮箱地址失焦后自动识别提供商。
- **Token 刷新**：批量/单个 Token 刷新仅作用于 Outlook 账号，第三方 IMAP 邮箱自动跳过。

### 批量导入格式

| 提供商 | 每行格式 |
|--------|----------|
| Outlook | `邮箱----clientId----refreshToken` 或 `邮箱----密码----clientId----refreshToken` |
| 第三方 IMAP | `邮箱----密码`（自定义 IMAP 为 `邮箱----密码----imap地址----imap端口`） |

## 邮件缓存（PostgreSQL）

每次请求都全量拉取并解析几十封邮件既慢又容易触发提供商风控（163/QQ 尤甚）。系统在 PostgreSQL 中缓存邮件，并对第三方 IMAP 使用 **UID 增量同步**：

| 机制 | 说明 |
|------|------|
| 缓存命中 | TTL 内的重复请求直接返回缓存（毫秒级），不再连接邮件服务器 |
| UID 增量 | 记录每账号每文件夹的 `UIDVALIDITY + lastUid`，后续只拉取新邮件；UIDVALIDITY 变化（邮箱重置等）自动整夹重建 |
| 追平 | 增量抓取结果占满 limit 时自动触发一次全量拉取，避免遗漏较早邮件 |
| 结果合并 | 增量新邮件与缓存行去重合并，按时间倒序取前 N，展示与调用方无感知 |
| 强制刷新 | 管理面板「收取新邮件」按钮 / 外部 API `no_cache=1`：跳过缓存读取强制实时拉取（仍会写回缓存） |
| 失效 | 清空邮箱、删除账号时自动清除对应缓存；缓存只在抓取成功时写入，失败不会污染 |
| 清理 | 定时任务按 `MAIL_CACHE_RETENTION_DAYS` 清理过期缓存 |

TTL 语义：**新邮件未入缓存，收验证码场景第一次查询必然真实拉取**；TTL 只影响"短时间内重复看同一收件箱"。可通过环境变量调整或设 0 禁用。

## API 文档

### 外部 API (`/api/*`)

需要在 HTTP Header 中携带 API Key：`X-API-Key: sk_xxx`

#### 接口列表

| 接口 | 说明 | 注意事项 |
|------|------|----------|
| `/api/get-email` | 获取一个未使用的邮箱地址 | 会标记为当前 Key 已使用 |
| `/api/mail_new` | 获取最新邮件 | - |
| `/api/mail_text` | 获取最新邮件文本 (脚本友好) | 可用正则提取内容 |
| `/api/mail_all` | 获取所有邮件 | - |
| `/api/process-mailbox` | 清空邮箱 | `data.deletedCount` 为删除数量 |
| `/api/list-emails` | 获取系统所有可用邮箱 | - |
| `/api/pool-stats` | 邮箱池统计 | - |
| `/api/reset-pool` | 重置分配记录 | 释放当前 Key 占用的所有邮箱标记 |

#### 使用流程

1. **获取邮箱**：
   ```bash
   curl -X POST "/api/get-email" -H "X-API-Key: sk_xxx"
   # {"success": true, "data": {"email": "xxx@outlook.com"}}
   ```

2. **获取邮件内容 (推荐)**：
   自动提取验证码（6位数字）：
   ```bash
   curl "/api/mail_text?email=xxx@outlook.com&match=\\d{6}" -H "X-API-Key: sk_xxx"
   # 返回: 123456
   ```

3. **获取完整邮件 (JSON)**：
   ```bash
   curl -X POST "/api/mail_new" -H "X-API-Key: sk_xxx" \
     -d '{"email": "xxx@outlook.com"}'
   ```

#### 参数说明

**通用参数**：
| 参数 | 说明 |
|------|------|
| email | 邮箱地址（必填） |
| mailbox | 文件夹：inbox/junk |
| socks5 | SOCKS5 代理 |
| http | HTTP 代理 |
| no_cache | 跳过缓存读取，强制实时拉取（1/true）。收验证码等需要第一时间拿到最新邮件的场景推荐用此参数；仍会刷新缓存。 |

**`/api/mail_text` 专用参数**：
| 参数 | 说明 |
|------|------|
| match | 正则表达式，用于提取特定内容 (例如 `\d{6}`) |

## 操作日志 Action 命名

`/admin/dashboard/logs` 中 `action` 字段使用以下固定值：

| Action | 含义 |
|--------|------|
| `get_email` | 分配邮箱 |
| `mail_new` | 获取最新邮件 |
| `mail_text` | 获取邮件文本 |
| `mail_all` | 获取所有邮件 |
| `process_mailbox` | 清空邮箱 |
| `list_emails` | 获取邮箱列表 |
| `pool_stats` | 邮箱池统计 |
| `pool_reset` | 重置邮箱池 |

## API Key 权限键

API Key 的 `permissions` 使用与上表一致的 action 值（如 `mail_new`、`process_mailbox`）。  
未配置 `permissions` 时默认允许全部接口。

## 生产配置要求

- 使用仓库根目录 `.env.example` 复制为 `.env` 后填写；`JWT_SECRET`、`ENCRYPTION_KEY`、`ADMIN_PASSWORD`、`POSTGRES_PASSWORD` 必须注入且不可使用示例默认值。
- 如启用 2FA，`ADMIN_2FA_SECRET` 也必须通过外部环境变量注入。
- 不要在 `docker-compose.yml`、`.env`、代码仓库中写死生产密钥；`.env` 已在 `.gitignore` 中忽略。
- `server/.env.example` 仅作本地开发参考，Compose 部署以根目录 `.env` 为准。
- 如需跨域访问，配置 `CORS_ORIGIN`（如 `https://admin.example.com,https://ops.example.com`）。
- 生产模式会在启动时对前端静态资源生成 `.gz/.br` 预压缩文件，并优先下发压缩版本。
- 服务会按 `API_LOG_RETENTION_DAYS` 与 `API_LOG_CLEANUP_INTERVAL_MINUTES` 自动清理历史 API 日志。

## License

MIT
