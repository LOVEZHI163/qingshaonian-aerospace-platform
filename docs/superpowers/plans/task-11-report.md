# Task 11：官网登录入口与响应式体验交付报告

## 状态

- 状态：已完成。
- 功能提交：`b415e2b test: preserve public user login entry`
- 本报告：独立提交，未包含任何业务代码变更。

## 交付内容

- 官网桌面头部保留清晰的“用户登录”入口；链接始终指向 `/admin/`，并使用 `data-router-ignore="true"`，不会被公开站点客户端路由拦截。
- 移动导航菜单打开后，用户登录入口可访问，并在“报名入口”之前出现；公开报名 CTA 的链接与功能未改变。
- 管理端与账户端保持蓝白品牌体系，补足窄屏布局：顶部赛事选择、侧栏导航、表单、分页、工具栏和操作按钮均在不隐藏关键功能的前提下可操作。

## 响应式断点

| 视口 | 验收内容 |
| --- | --- |
| 桌面（>900px） | 管理端保留固定侧栏与双栏工作区；账户端保留侧栏和主内容区。 |
| 768px / ≤900px | 管理端切为单列；顶部赛事选择器独占一行且可收缩；账户端切为单列，导航与所有功能保留。 |
| 320px / ≤480px | 主内容和认证页缩小内边距；侧栏导航、工具栏、表单动作与分页纵向排列；触控按钮最小高度 44px；表格使用可横向滚动容器，不删减列或操作。 |

## 自动化验证

```powershell
npm.cmd test -w apps/web -- --run
# 6 files, 133 passed

npm.cmd test -w apps/admin
# 33 files, 305 passed

npm.cmd run build
# web 与 admin Vite production build passed

git diff --check
# clean
```

## Review Fix Round 2

- 补齐内容列表真实的“官网预览”链接：`.content-list-row-actions a` 在 `@media (max-width: 480px)` 下使用 `inline-flex`、`align-items: center` 和 `min-height: 44px`，使链接的完整触控区域生效。
- 扩展 `ResponsiveStyles.test.js`，精确锁定该 selector 的 display、垂直居中和触控高度规则。

### Round 2 验证

```powershell
npm.cmd test -w apps/admin -- src/__tests__/ResponsiveStyles.test.js
# 1 file, 1 passed

npm.cmd run build -w apps/admin
# Vite production build passed

git diff --check
# clean
```

新增的官网回归用例验证：菜单打开后，“用户登录”具有 `/admin/` 和 `data-router-ignore="true"`，且 DOM 顺序在“报名入口”之前。

## 自审

- 未改变官网 logo SVG、公开导航、赛事展示或公开报名 CTA。
- 未修改 API、账户/赛事业务状态、权限逻辑或数据结构。
- 未通过隐藏列、隐藏操作或禁用入口换取窄屏布局；数据表继续允许横向滚动。
- 未引入新依赖。

## 已知警告

`npm.cmd run build` 成功，但 web 的 Vite reporter 保留三条既有 chunk 提示：`HomePage.jsx`、`EventDetailPage.jsx`、`ContentDetailPage.jsx` 同时被动态和静态导入，因此不会被移入独立 chunk。该任务未触及这些导入关系，未新增构建错误或失败。

## Review Fix Round 1

- 阻塞项：原 320px 规则只覆盖了部分表单动作按钮，`.mini`、认证页签、赛事页签、工具栏和卡片中的其他实际 `<button>` 未获得统一的 44px 最小触控高度。
- 修复：在 `@media (max-width: 480px)` 中增加通用 `button { min-height: 44px; }`，因此覆盖所有实际按钮；不影响 checkbox 等 `input` 控件。
- 链接式操作：凭证链接、站点预览回退链接和文件操作控件同时采用 44px 最小高度与 inline-flex 垂直居中，避免仅文字区域可触达。
- 新增 `apps/admin/src/__tests__/ResponsiveStyles.test.js` 静态回归，锁定 480px 下的通用按钮及三类链接式操作规则。

### Round 1 验证

```powershell
npm.cmd test -w apps/web -- --run
# 6 files, 133 passed

npm.cmd test -w apps/admin
# 34 files, 306 passed

npm.cmd run build
# web 与 admin Vite production build passed

git diff --check
# clean
```
