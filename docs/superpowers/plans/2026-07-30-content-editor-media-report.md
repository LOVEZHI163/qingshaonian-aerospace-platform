# 内容编辑器与正文媒体部署报告

日期：2026-07-31
环境：阿里云测试环境
状态：通过并已清理验收数据

## 发布结论

- 最终发布 release：`530b8087eb11ed1420310983757c0ad887ca6db8`。
- 前一线上 release：`94d3ff8a1059fd66eaa63592bd842054e75ee635`。
- 发布包只来自 `git archive HEAD`，未包含 `.env`、backups、uploads、`node_modules` 或构建目录。
- Windows Git 因仓库历史中的 NTFS 不兼容路径首次拒绝归档；只对该次归档关闭 `core.protectNTFS` 后，从同一 Git 对象生成成功。归档包含 363 个条目、6,594,560 字节，SHA-256 为 `aadd2cf0c2fb36c73fdcb66d131779e1c2c33ab4545d2592c4c6eea5e335d5bd`。
- 服务器接收后复核归档 SHA-256 一致；候选源码与切换后的 `deploy/preflight-admin-upgrade.sh` 均通过。
- `/opt/aerogp/.release` 最终为上述完整 release；没有重新创建数据库卷或上传卷，也没有执行 `docker compose down -v`。

## 本地全量门禁

| 命令 | 结果 |
| --- | --- |
| `git diff --check 6e6d9ae68223748ca3b20c84c5b28cba9e05d26b..HEAD` | 通过，无输出 |
| `npm.cmd test -w apps/api -- --test-concurrency=1` | 329/329，通过；0 fail |
| `npm.cmd test -w apps/admin` | 35 个文件，338/338，通过 |
| `npm.cmd test -w apps/web` | 6 个文件，134/134，通过 |
| `npm.cmd run build` | Web 与 Admin 生产构建通过 |
| `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1` | `Deployment configuration checks passed.` |

构建只出现既有 Vite 告警：Web 预览页造成三个页面同时被静态与动态导入，以及 Admin 单个压缩后 chunk 超过 500 kB；没有新增构建错误。

## 验证说明与已知非阻塞项

- 上表的 API 325/325 是部署候选代码在部署前、使用正式门禁命令取得的完整成功结果，也是本次是否允许部署的依据。
- 浏览器验收和线上清理完成后，工作树只新增/修改本文档与运维记录。提交前额外执行一次相同 API 串行命令，结果为 320/325；5 项失败全部在固定 5 秒启动门限报 `API server did not start in time`，均未进入业务断言，其他 320 项通过。
- 该额外复跑没有发现业务断言回归；线上 release、四服务健康、HTTP、浏览器功能和清理后数据库基线均另行通过。主任务据此将这 5 项记录为提交环境的非阻塞启动超时，不覆盖或改写部署前 325/325 的正式门禁证据，也未再次复跑。

## 备份与可回滚证据

初次内容编辑器发布备份 stamp：`20260730T171651Z`；最终修复发布另行创建并验证 stamp `20260730T192258Z`。

| 对象 | 文件或标签 | 验证 |
| --- | --- | --- |
| PostgreSQL | `backups/aerogp-20260730T171651Z.dump`，58,241 字节 | 非空；`pg_restore --list` 通过 |
| uploads | `backups/uploads/aerogp-uploads-20260730T171651Z.tar.gz`，16,719,656 字节 | 非空；安全路径/链接检查和 `tar -tzf` 通过 |
| 旧源码 | `backups/source-before-content-editor-20260730T171651Z.tgz`，3,801,708 字节 | 非空；`tar -tzf` 通过 |
| API 镜像 | `aerogp-api:rollback-20260730T171651Z` | `docker image inspect` 通过 |
| Web 镜像 | `aerogp-web:rollback-20260730T171651Z` | `docker image inspect` 通过 |
| 回滚标记 | `backups/content-editor-rollback-20260730T171651Z.txt` | 权限 `0600`；前一 release、备份名与标签齐全 |

API 与 Web 在同一发布窗口执行 `docker compose up -d --build api web`。Backup 随后重建以绑定新部署树；旧源码切换暂存树在确认新挂载及四服务健康后删除。

## 真实浏览器验收

使用 Codex 内置浏览器和唯一 active 管理员完成首次链路。两个测试文件名均以 `.png` 结尾，但真实字节为 JPEG，因此本报告不把该轮记作“真实 PNG 字节”验收；真实 PNG 复验待新代码发布后由主任务补记。凭据只用于登录会话，没有写入命令参数、报告或 Git。

### 文本工具栏

- reload 后确认为新 bundle；工具栏包含段落、H2、H3、粗体、斜体、无序列表、有序列表、引用、链接、撤销、重做、清除格式和图片。
- 选中文本逐项应用 H2、H3、粗体、斜体、两种列表、引用和链接，编辑器 DOM 与可视状态均正确。
- 对普通正文应用粗体后，撤销移除、重做恢复、清除格式再次移除，三个状态均经实际页面读取确认。

### 图片上传、媒体库与持久化

- 新建平台通用新闻，内容 ID `POST1785434555302338`，slug `media-editor-qa-20260730`。
- UI 上传图片 A `qa-admin.png`，在当前光标处插入；alt 为“后台界面验收图片 A”，caption 为“图片 A：首次上传并插入”。
- UI 打开“替换图片”，上传图片 B `qa-web.png`；媒体库自动选中 B，保存后的 alt 为“官网首页验收图片 B”，caption 为“图片 B：媒体库替换后保留”。
- 再从媒体库选择 A 插入第二张，通过 UI 删除 A，正文最终只保留 B。
- 保存草稿并 reload 后，正文段落、B 的位置、alt 与 caption 均保持，页面显示已保存。

### 响应式编辑器

- 904×678：`clientWidth=889`、`scrollWidth=889`，整页无横向溢出；操作栏为 sticky 且自身 `overflow-x:auto`。滚到底后最后图片 bottom 为 320px、操作栏 top 为 599px，间隔 279px，编辑器内容可达且不被遮挡。
- 360×780：`clientWidth=345`、`scrollWidth=345`，整页无横向溢出；操作栏改为 static，内部 `clientWidth=277`、`scrollWidth=572`，允许横向滚动工具按钮。滚到底后正文与操作栏间隔约 708.6px，两者均可达。

### 发布、公开页与媒体响应

- UI “进入发布检查”显示“可以发布”；确认后版本升为 2，状态为已发布。
- 公开页 `/content/media-editor-qa-20260730`：桌面 1280px 时 `clientWidth=scrollWidth=1265`；移动 360px 时 `clientWidth=scrollWidth=345`，均无横向溢出。
- 正文图 natural size 为 1749×2920，`complete=true`；移动端渲染宽约 320.98px。
- 公开页控制台 `warn=[]`、`error=[]`。
- 公开媒体 `/api/public/media/M1785434383490866` 返回 HTTP 200、`Content-Type: image/jpeg`、`X-Content-Type-Options: nosniff`、inline disposition 和 immutable cache。测试文件名以 `.png` 结尾，但服务按真实字节探测为 JPEG，响应类型与探测结果一致。

## 引用保护与验收数据清理

- 在正文仍引用图片 B 时，`DELETE /api/admin/site-media/M1785434383490866` 返回预期 409，证明正文引用保护有效。
- 经 UI 将临时新闻下线并确认删除文章。
- 文章删除后，图片 A `M1785434275570638` 与图片 B `M1785434383490866` 的 DELETE 均返回 204。
- 临时文章、两张媒体元数据及对应文件均已清除；没有 cleanup journal 失败。
- 验收前后的关键计数一致：内容 3、赛事 6、媒体 12。最终数据库为用户 2、赛事 6、内容 3、媒体 12、cleanup journal 0、active 管理员 1。
- 未删除或修改任何既有用户、赛事、文章或媒体。

## 最终冒烟与运行状态

- 已认证：管理员登录 200，`/api/auth/me` 200；草稿保存/reload、内容详情、媒体库与受保护编辑器图片均可访问。
- 公开与匿名：`/`、`/admin/`、`/api/public/home`、`/healthz` 均为 200；匿名管理员设置接口为预期 401。
- 受保护预览精确路由为 `GET /api/admin/site-media/:id/preview?variant=original|mobile|desktop`。本地集成测试 `private preview media requires an administrator session` 已使用同一媒体验证管理员会话 200、匿名 401，并验证 `Cache-Control: private, no-store`；浏览器验收确认编辑器认证预览可加载，但本轮没有单独执行线上同一媒体的匿名/认证 HTTP 对照。线上复核命令：先以静默登录生成 `COOKIE_JAR`，再分别执行匿名 `curl -o /dev/null -w '%{http_code}'`（期望 401）和带 `-b "$COOKIE_JAR"` 的同一路由请求（期望 200）。
- `postgres`、`api`、`web`、`backup` 均为 `running healthy`。
- API 4300 和 PostgreSQL 5432 未映射宿主机；只有 Web 发布 80。
- 运行时 `.release`、容器状态、HTTP 状态、数据库计数和 cleanup journal 均在清理后重新读取确认。

## 回滚

回滚前先保留故障日志，并为当前数据库和 uploads 再做一份备份。默认只回滚应用，保留当前 PostgreSQL 与 uploads 命名卷：

```bash
cd /opt/aerogp
docker image tag aerogp-api:rollback-20260730T171651Z aerogp-api:latest
docker image tag aerogp-web:rollback-20260730T171651Z aerogp-web:latest
docker compose up -d --no-build --force-recreate --wait --wait-timeout 240 api web
docker compose ps
curl -fsS http://127.0.0.1/healthz
curl -fsS http://127.0.0.1/api/public/home >/dev/null
curl -fsS http://127.0.0.1/admin/ >/dev/null
BASE_URL=http://127.0.0.1 /bin/sh deploy/remote-smoke-test.sh
printf '%s\n' '83740470cafad0b2c5e7b1f3dc6ba2043f97020e' > .release.next
mv .release.next .release
```

`.release` 只在健康等待、三个显式 HTTP 检查和完整 smoke 均成功后改写；任一检查失败时保留原标记并继续收集故障证据。

若需要从旧源码重建，把已验证的 `backups/source-before-content-editor-20260730T171651Z.tgz` 解压到 `/opt/aerogp/backups` 下的空目录；保留 `.env` 与 `backups`，替换其余源码，运行升级预检后重建 API/Web。

只有确认数据库结构不兼容或数据损坏时，才恢复已验证数据库备份：

```bash
cd /opt/aerogp
CONFIRM_RESTORE=yes docker compose run --rm \
  -e CONFIRM_RESTORE=yes \
  backup /bin/sh /scripts/restore-postgres.sh \
  /backups/aerogp-20260730T171651Z.dump
```

uploads 仅在确认损坏时按运维手册恢复：停止 API、额外备份当前卷、再次运行安全归档校验、在空目录检查文件清单后复制。禁止直接覆盖运行中的卷，也禁止 `docker compose down -v`。

## 最终修复发布与真实 PNG 复验

- 独立代码审查发现并已修复两项重要问题：归档赛事的赛事资料、赛项更新和赛项删除现在由服务端统一返回 409，管理端同步进入只读状态；正文附件用途 `content-attachment` 已严格映射到允许 PDF 的附件策略，未知媒体用途返回 422。
- 同一修复波次还把种子组织 `O1002` 的报名创建者统一为 `U2002`，补充临时密码管理员访问媒体接口返回 428 的回归测试，并修正回滚健康等待、HTTP/smoke 检查及 `.release` 成功后再写入的运维说明。
- 最终本地门禁为 API 329/329、Admin 338/338、Web 134/134；生产构建、部署配置检查、完整提交范围 `git diff --check` 和敏感信息扫描均通过。
- 最终发布版本为 `530b8087eb11ed1420310983757c0ad887ca6db8`，统一备份 stamp 为 `20260730T192258Z`。数据库 dump、uploads 归档、部署前源码和 rollback marker 均验证可读，API/Web 回滚镜像均可 inspect。最终 PostgreSQL、API、Web、Backup 四服务全部 `running/healthy`；仅 Web 对外发布 80，API 4300 与 PostgreSQL 5432 仅容器内部可达。
- 线上契约复核：未知媒体用途返回 422；真实 PDF 以 `content-attachment` 上传返回 201，删除返回 204；`/`、`/admin/`、`/api/public/home`、`/healthz`、管理员登录及认证管理端点均为 200。线上无归档赛事，因此未创建会改变现有赛事数据的一次性归档 fixture，归档写保护由新增 HTTP 回归测试覆盖。
- 使用真实 PNG 字节文件完成第二轮 Codex 内置浏览器验收。临时内容 ID 为 `POST1785440192275778`，slug 为 `true-png-qa-20260731`，媒体 ID 为 `M1785440129151338`。从“图片”对话框上传、填写替代文本和题注、插入正文、保存草稿并 reload 后，正文图片及题注完整持久化。
- 临时内容经“进入发布检查—确认发布”正式公开；公开页图片 `complete=true`，原始和实际渲染尺寸均为 375×812。页面 `clientWidth=scrollWidth=1265`，无横向溢出，控制台 warn/error 为 0。公开媒体返回 HTTP 200、`Content-Type: image/png`、`nosniff`、inline disposition 和 immutable cache，证明该轮是实际 PNG 字节而非仅扩展名。
- 同一媒体的受保护预览已在线独立对照：匿名请求 401、管理员会话请求 200。验收结束后通过 UI 下线并删除临时内容，再通过管理 API 删除媒体，返回 204；公开媒体随后为 404，公开内容页显示“内容不存在”。
- 清理后数据库终态恢复为用户 2、赛事 6、内容 3、媒体 12、cleanup journal 0、active 管理员 1；没有遗留临时文章、媒体元数据、媒体文件或本地验收 PNG。服务器 `.release` 仍为最终完整 SHA。
