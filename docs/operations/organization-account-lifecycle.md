# 组织账号生命周期运维手册

本文供平台管理员和服务器运维人员使用，适用于组织资质审核、报名资格、临时密码、组织删除以及相关备份与回滚。示例中的路径和文件名是占位符，不包含任何真实密码、密钥或令牌。

## 权限与状态

- 组织注册完成后默认为“待审核”。待审核负责人可以登录、修改密码、查看审核进度和重新提交资质，但不能进入赛事工作台、管理成员或发起报名。
- 平台管理员审核通过且组织状态为“启用”后，负责人自动获得该组织的全部管理权限，不需要逐场委派。
- 普通用户必须且只能存在一条有效成员关系，并且所属组织已审核通过、状态为启用，才能报名。无有效组织时接口返回 `403 ACTIVE_ORGANIZATION_REQUIRED`。
- 组织待审核、被驳回或被停用时，负责人业务接口分别返回 `ORGANIZATION_REVIEW_PENDING`、`ORGANIZATION_REJECTED` 或 `ORGANIZATION_DISABLED`。

## 临时密码

平台管理员可以为普通用户或组织负责人重置密码。系统生成临时密码，并设置 `mustChangePassword=true`；用户下次登录后只能先修改密码或退出登录。

- 管理员可以在用户修改前重复查看当前临时密码。
- 系统只保存普通密码的哈希，管理员不能查询用户的正常密码。
- 临时密码以 AES-256-GCM 加密后保存；日志、审计摘要和普通用户 DTO 不得包含临时密码、密码哈希、密钥或会话令牌。
- 用户成功修改密码后，加密的临时密码字段会被清除，管理员再次查看应得到 404。
- 重置或修改密码会使旧会话失效；不要把临时密码写入工单、群聊、命令历史或部署日志。

## 加密密钥配置与轮换

`TEMP_PASSWORD_ENCRYPTION_KEY` 必须是 Base64 编码的 32 字节随机值，只能保存在服务器 `/opt/aerogp/.env`，文件权限应为 `600`。不得提交到 Git，也不要在终端打印它。

首次配置或轮换前先备份数据库并确认当前需要交付的临时密码已经安全送达。轮换后，旧密钥加密的临时密码无法读取；对仍处于 `mustChangePassword=true` 的账号，应由平台管理员重新生成临时密码。

以下命令在服务器内部生成密钥且不输出其内容：

```bash
set -eu
cd /opt/aerogp
umask 077
tmp=
cleanup_key_update() {
  test -z "$tmp" || rm -f -- "$tmp"
}
trap cleanup_key_update EXIT HUP INT TERM
test -r .env
key="$(openssl rand -base64 32 | tr -d '\n')"
tmp="$(mktemp .env.XXXXXX)"
grep_status=0
grep -v '^TEMP_PASSWORD_ENCRYPTION_KEY=' .env > "$tmp" || grep_status=$?
if [ "$grep_status" -gt 1 ]; then
  rm -f "$tmp"
  unset key
  exit "$grep_status"
fi
printf '\nTEMP_PASSWORD_ENCRYPTION_KEY=%s\n' "$key" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
tmp=
unset key
trap - EXIT HUP INT TERM
chmod 600 .env
docker compose up -d --wait api
```

轮换完成后，用一个专门的测试账号执行“管理员重置 → 重复查看 → 用户登录并修改密码”，确认全过程正常，再处理其他待改密账号。

## 删除组织的影响

删除组织是平台管理员专属操作。界面必须显示二次确认，并说明保留范围。

删除后：

- 组织账号、组织主体、资质文件和当前成员关系被删除或清理；
- 历史报名、成绩和证书继续保留；
- 历史记录使用组织名称快照展示，并明确标记“原组织已删除”；
- 已删除组织不能重新进入工作台、邀请成员或产生新报名；
- 资质文件和其他受控文件的清理失败会进入文件清理日志，不得因为物理文件删除失败而伪造业务删除成功。

删除前应导出该组织相关报名和证书清单，并确认数据库及上传卷备份可用。删除后抽查历史报名、成绩、证书和审计记录。

## 发布前备份

先通过项目的 `backup` 容器创建并校验 PostgreSQL 自包含备份，再备份和校验完整上传卷：

```bash
set -eu
cd /opt/aerogp
database_output="$(docker compose run --rm -T backup /bin/sh /scripts/backup-postgres.sh once)"
database_container_path="$(printf '%s\n' "$database_output" | sed -n 's|^Created \(/backups/aerogp-[0-9TZ]*\.dump\)$|\1|p')"
test "$(printf '%s\n' "$database_container_path" | wc -l | tr -d ' ')" -eq 1
case "$database_container_path" in /backups/aerogp-*.dump) ;; *) exit 1 ;; esac
latest="backups/${database_container_path#/backups/}"
test -n "$latest" && test -s "$latest"
docker compose run --rm -T backup pg_restore --list "$database_container_path"

uploads_output="$(docker compose run --rm -T backup /bin/sh /scripts/backup-uploads.sh)"
uploads_container_path="$(printf '%s\n' "$uploads_output" | sed -n 's|^\(/backups/uploads/aerogp-uploads-[^[:space:]]*\.tar\.gz\)$|\1|p')"
test "$(printf '%s\n' "$uploads_container_path" | wc -l | tr -d ' ')" -eq 1
case "$uploads_container_path" in /backups/uploads/aerogp-uploads-*.tar.gz) ;; *) exit 1 ;; esac
latest_uploads="backups/${uploads_container_path#/backups/}"
test -n "$latest_uploads" && test -s "$latest_uploads"
docker compose run --rm -T backup /bin/sh /scripts/verify-uploads-backup.sh \
  "$uploads_container_path"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_archive="backups/release-archives/pre-org-lifecycle-$stamp"
install -d -m 700 "$release_archive"
cp -- "$latest" "$release_archive/postgres.dump"
cp -- "$latest_uploads" "$release_archive/uploads.tar.gz"
chmod 600 "$release_archive/postgres.dump" "$release_archive/uploads.tar.gz"
docker compose run --rm -T backup pg_restore --list \
  "/backups/${release_archive#backups/}/postgres.dump"
docker compose run --rm -T backup /bin/sh /scripts/verify-uploads-backup.sh \
  "/backups/${release_archive#backups/}/uploads.tar.gz"
```

上传卷归档包括报名作品、证书、组织资质和官网媒体。根备份目录中的自动备份文件仍按 7 天策略清理；本次发布的数据库与上传卷副本放在 `backups/release-archives/`，不匹配自动清理规则，应保留到用户明确授权清理。还应记录当前 `RELEASE_SHA`；发布包不得覆盖 `.env`、上传卷、证书目录或 `backups`。

## 回滚

出现故障时先停止写入操作，保留故障现场日志，再按以下顺序处理：

1. 使用发布前源码归档恢复 `apps`、`deploy` 和根构建文件，不覆盖 `.env`、上传卷及备份。
2. 将 `.env` 中的 `RELEASE_SHA` 改为已经验证过的上一版本提交，并重新构建、启动服务。
3. 仅在数据迁移造成不可兼容且确认会丢弃发布后的业务写入时，才恢复 PostgreSQL 备份。
4. 数据库恢复后再次校验上传文件引用、组织历史快照和文件清理日志。
5. 运行发布校验与远程烟测；两者都通过后才恢复业务入口。

恢复数据库的示例（必须把占位文件替换为已验证备份，并在维护窗口执行）：

```bash
cd /opt/aerogp
docker compose exec -T postgres sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < backups/VERIFIED-BACKUP.dump
```

回滚应优先使用 `backups/release-archives/` 中已复核的发布前副本；这些发布归档应保留到用户明确授权清理为止。

## 发布与冒烟检查

生产发布必须依次执行：

```bash
cd /opt/aerogp
EXPECTED_RELEASE="$(sed -n 's/^RELEASE_SHA=//p' .env)" \
  EXPECTED_SMS_REGISTRATION_ENABLED=false \
  EXPECTED_SMS_LOGIN_ENABLED=false \
  EXPECTED_SMS_PASSWORD_RESET_ENABLED=false \
  BASE_URL=https://aerogp.cn ./deploy/verify-release.sh
ADMIN_TEST_PASSWORD="${ADMIN_TEST_PASSWORD:?set securely for this shell}" \
  BASE_URL=https://aerogp.cn ./deploy/remote-smoke-test.sh
unset ADMIN_TEST_PASSWORD
```

烟测使用时间戳和进程号生成唯一测试资源，并通过 `trap` 清理。通过标准包括：

- 待审核组织工作台返回 `403 ORGANIZATION_REVIEW_PENDING`；
- 无组织普通用户报名返回 `403 ACTIVE_ORGANIZATION_REQUIRED`；
- 管理员重置后 `mustChangePassword=true`，且临时密码可重复查看；
- 烟测赛事删除后，管理员赛事列表不再包含该赛事 ID；
- 终端日志不出现临时密码、密钥或会话令牌。

## 审计与日常检查

平台管理员应定期检查以下审计动作及目标账号/组织/赛事是否一致：

- `organization.review`、组织停用/启用和组织删除；
- `user.password-reset`、`user.temporary-password-view` 和用户修改密码；
- 成员申请、邀请、接受、拒绝和移除；
- 报名创建、修改、审核、成绩和证书操作；
- 赛事归档、删除以及文件清理任务。

审计记录只能描述动作和目标，不得记录临时密码、密码哈希、加密密钥、Cookie 或 Token。发现异常查看、连续重置、跨组织访问或清理日志积压时，应立即暂停相关账号并保留日志、数据库和上传卷快照。
