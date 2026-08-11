# 公共官网全宽抽屉导航终审集中修复报告

- 日期：2026-08-12
- 工作树：`C:\Users\xiang\Documents\青少年航空网站\.worktrees\content-repost-import`
- FIX_BASE：`afe5a57f04f7b6a5bfd3040b610ccc91295b9d90`
- 分支：`codex/public-drawer-navigation`
- 提交主题：`fix(web): close drawer navigation review gaps`
- 范围：仅处理终审列出的 1 个 Critical、4 个 Important、2 个 Minor；未新增运行时依赖、未改权限模型。

## 结论

七项终审发现均已有覆盖测试与实现。最终聚焦套件 95/95、前端全量测试 186/186、API sitemap 定向测试 2/2、monorepo build 均通过。生产构建预览已在 1440×900 与 390×844 做真实浏览器验收：桌面键盘可打开并进入二级导航，Escape 恢复到可见触发器；移动端可见完整七项主导航/登录入口和简称“温州少航”，无横向裁切。

## 发现逐项处理

### 1. Critical：桌面唯一抽屉触发器被隐藏

- 改动：
  - `apps/web/src/styles/navigation.css:36-38`：拆开 `.mobile-brand-name` 与 `.menu-trigger`；触发器在桌面基础样式即为 `display:grid`、44×44、可聚焦，移动断点不再是唯一显示来源。
  - `apps/web/src/components/SiteHeader.jsx:160-175`：沿用语义化 `button`、`aria-expanded`、`aria-controls`、Enter/Space 激活和 Escape 焦点恢复；恢复目标现在在 1440px 可见。
  - `apps/web/src/__tests__/PublicMegaDrawer.test.jsx:157-168`：新增桌面 Enter/Escape 回归。
  - `apps/web/src/__tests__/BuildClean.test.js:15-16`：生产 CSS 契约禁止再次把触发器与移动品牌一起隐藏，并要求基础触发器为 grid。
- RED：CSS 契约在基础样式 `.mobile-brand-name, .menu-trigger { display:none; }` 处失败。
- GREEN：聚焦行为 92/92；BuildClean 2/2；1440px Chrome 真实键盘证据见“浏览器验收”。

### 2. Important：移动端缺完整主导航、登录与简称

- 改动：
  - `apps/web/src/components/SiteHeader.jsx:12,155-160`：移动头部简称固定为“温州少航”，移至未被 `.site-navigation` 隐藏的头部区域。
  - `apps/web/src/components/SiteHeader.jsx:195-202`：把与桌面相同的动态 `primaryLinks` 和 active 栏目传给抽屉，避免 IA 漂移。
  - `apps/web/src/components/PublicMegaDrawer.jsx:121-141`：增加“移动端主导航”，顺序为用户登录、首页、关于大赛、赛事资讯、获奖查询、联系我们、报名入口；业务入口继续使用现有 `/admin/?view=...` 契约。
  - `apps/web/src/styles/navigation.css:56,77-85`：移动主导航仅在 `max-width:1120px` 显示；简称可见；抽屉保持垂直滚动。
  - `apps/web/src/__tests__/PublicMegaDrawer.test.jsx:170-191`、`Accessibility.test.jsx:104-120`：断言移动 IA、登录参数、顺序、简称和 active。
- RED：组件测试找不到“温州少航”和 `navigation[aria-label="移动端主导航"]`。
- GREEN：聚焦行为 92/92；390px 生产 CSS 浏览器显示全部七项，每项高度 44px。

### 3. Important：空 article 与详情失败无友好降级

- 改动：
  - `apps/web/src/lib/public-event-content.js:52-77,127`：清理空段落/空项目名，过滤没有 paragraphs/items/contact 的 section，空 projects/groups 不再生成卡片。
  - `apps/web/src/pages/EventInformationPage.jsx:9-35`：详情请求增加当前请求守卫；失败只存安全状态，不保存或渲染技术错误。
  - `apps/web/src/pages/EventInformationPage.jsx:69-75`：显示“暂时无法加载赛事详情，请稍后重试。”及“重新加载”按钮。
  - `apps/web/src/__tests__/PublicPages.test.jsx:359-389`：500 响应带 `SQL connection refused`，断言页面不泄露 SQL、无空项目/组别卡，并在点击重试后成功显示赛项。
  - `apps/web/src/lib/__tests__/public-event-content.test.js:32-40`：空数组模型必须得到 `sections: []`。
- RED：模型返回两张空 section；页面找不到友好 alert/重试入口。
- GREEN：聚焦行为 92/92；错误重试用例通过且技术文本未出现在 DOM。

### 4. Important：联系电话缺少 `tel:` 语义

- 改动：
  - `apps/web/src/content/wz-aerospace-2026.js:18-20`：固定赛事由段落字符串改为 `{ name, phones }` 结构。
  - `apps/web/src/lib/public-event-content.js:21-82`：固定/通用/平台联系人统一提取号码，保留显示格式，移除空格、连字符和括号后生成 `tel:`；联系人文字独立保留。
  - `apps/web/src/pages/EventInformationPage.jsx:81-97`：渲染“联系人：…”和可拨号电话链接。
  - `apps/web/src/lib/__tests__/public-event-content.test.js:42-92`、`PublicPages.test.jsx:391-411`：覆盖 `0577-12345678`、`138 0013 8000`、仅以空格分隔的两个号码与固定赛事两个号码。
- RED：模型 `contact` 为 `undefined`，页面只有纯文本、找不到联系人文本和电话链接。
- 独立自审补充 RED：`张老师 0577-12345678 13800138000` 被旧宽泛正则合并成 `tel:05771234567813800138000`（1 failed / 5 passed）。修复为移动电话、固话和本地号的定长候选后，两个号码分别生成拨号链接。
- GREEN：`0577-12345678 → tel:057712345678`、`138 0013 8000 → tel:13800138000`，联系人“赛事组委会”或“张老师”保留；该模型套件 6/6。

### 5. Important：缺少真实赛事 A→B 切换与乱序响应测试

- 改动：
  - `apps/web/src/__tests__/PublicPages.test.jsx:281-358`：用首页返回的两场公开赛事，先真实点击 `/projects` 切换器验证请求 B、URL 更新、A 赛项移除；再让 B 先返回、A 后返回验证 A 不污染当前页面。
  - `apps/web/src/pages/EventInformationPage.jsx:13-30`：cleanup 同时设置 `current=false` 并 abort；即使测试/中间层忽略 AbortSignal，旧响应也不能回写。
- RED：顺序切换用例已覆盖正常路径；乱序用例中 A 的迟到响应把 B 详情清空，`B 乱序赛项` 消失。
- GREEN：两项切换测试均通过，请求 B 带 AbortSignal，最终只保留 B 赛项。

### 6. Minor：动态长串窄屏溢出

- 改动：
  - `apps/web/src/styles/navigation.css:64`：动态赛事主题补 `min-width:0; overflow-wrap:anywhere`。
  - `apps/web/src/styles/event-information.css:3,20-23`：动态摘要、项目文字、联系人容器及电话链接补同样约束。
  - `apps/web/src/__tests__/BuildClean.test.js:18-21`：生产 CSS 契约覆盖上述四类文本。
- RED：CSS 契约加入后，旧规则缺少这些属性。
- GREEN：BuildClean 2/2；390px 根与正文均 `scrollWidth=clientWidth=390`。

### 7. Minor：一级导航 active 未按路由族映射

- 改动：
  - `apps/web/src/lib/public-navigation.js:31-54`：集中映射：首页只精确 `/`；`/about`、`/rules`、`/registration-process`、现有 `/registration-guide`、`/projects`、`/contact` → “关于大赛”；`/announcements`、`/news`、`/history` → “赛事资讯”。
  - `apps/web/src/components/SiteHeader.jsx:26,181-190`：桌面和移动主导航共用同一个 active label。
  - `apps/web/src/__tests__/Accessibility.test.jsx:74-90`：逐路由断言且每次只有一个 `aria-current="page"`。
- RED：`/rules`、`/registration-process`、`/projects`、`/contact`、`/announcements`、`/history` 共 6 个参数化分支失败。
- GREEN：全部路由族分支通过；首页保持精确匹配。

## TDD 证据

### RED 1：聚焦行为

命令：

```text
npm test -w apps/web -- --run src/lib/__tests__/public-event-content.test.js src/__tests__/PublicMegaDrawer.test.jsx src/__tests__/Accessibility.test.jsx src/__tests__/PublicPages.test.jsx
```

关键输出（退出码 1）：

```text
Test Files  4 failed (4)
Tests       12 failed | 80 passed (92)
public-event-content: 2 failed（空 sections、结构化电话）
PublicMegaDrawer: 1 failed（移动完整 IA/简称）
Accessibility: 6 failed（路由族 active）
PublicPages: 3 failed（乱序响应、友好重试、电话渲染）
```

正常 A→B 切换测试在 RED 阶段已通过；同批乱序测试失败，证明新增覆盖能够捕获真实竞态而不是只检查 mock。

### RED 2：生产 CSS

命令：

```text
npm test -w apps/web -- --run src/__tests__/BuildClean.test.js
```

关键输出（退出码 1）：

```text
Test Files  1 failed (1)
Tests       1 failed | 1 passed (2)
失败位置：.mobile-brand-name, .menu-trigger { display: none; }
```

触发器可见、移动主导航显示及四类长串折行断言均在实现前写入同一生产 CSS 契约。

### GREEN：聚焦行为

```text
Test Files  5 passed (5)
Tests       95 passed (95)
Duration    3.70s
```

### GREEN：生产 CSS/构建契约

```text
Test Files  1 passed (1)
Tests       2 passed (2)
Duration    2.76s
```

## 浏览器验收（Browser skill）

### 环境

- 先执行 monorepo build，再启动 `npm run preview -w apps/web -- --host 127.0.0.1`。
- 目标：`http://127.0.0.1:4173/`，由 Vite preview 提供 `apps/web/dist`，加载生产 CSS bundle。
- 全部交互通过 `browser:control-in-app-browser` 指定的 Browser runtime；IAB 用于初始布局核对，因其后端不执行 Tab 默认焦点推进，按技能规则切换到已连接 Chrome 完成真实键盘序列。

### 1440×900 桌面

- `innerWidth/clientWidth/scrollWidth = 1440/1440/1440`，无横向溢出。
- `.menu-trigger`：`display:grid`，44×44，可见。
- 只用 Playwright `locator.press`，未用 click 或脚本 `.focus()` 冒充键盘：
  1. 自然 Tab 1 → “跳到主要内容”；Tab 2 → “网站首页”；Tab 3 → “打开赛事导航”。
  2. Enter → `aria-expanded=true`，抽屉 `aria-hidden=false / hidden=false / inert=false`。
  3. 继续 Tab 的可访问名称依次为“用户登录、首页、关于大赛、赛事资讯、获奖查询、联系我们、报名入口、报名入口”；第 8 次 Tab 的活动链接满足 `closest(#public-mega-drawer)=true` 且 `closest(.public-mega-drawer-main-navigation)=true`，已进入二级导航。
  4. 在二级链接上 Escape → 活动元素恢复为可见的“打开赛事导航”；抽屉 `aria-hidden=true / hidden=true / inert=true`。

### 390×844 移动

- 头部简称：文本“温州少航”，`display:block` 且可见。
- 桌面 `.site-navigation`：`display:none`；移动主导航容器：`display:grid`。
- 移动主导航可见链接及 href：
  - 用户登录 → `/admin/`
  - 首页 → `/`
  - 关于大赛 → `/about`
  - 赛事资讯 → `/news`
  - 获奖查询 → `/admin/?view=certificates`
  - 联系我们 → `/contact`
  - 报名入口 → `/admin/?view=eventCenter`
- 七个链接实测高度均为 44px。
- 抽屉 `clientHeight=772`、`scrollHeight=1377`、`overflowY=auto`；打开期间 `body overflow=hidden`。
- `document` 与 `body` 均为 `clientWidth=scrollWidth=390`，`horizontallyClipped=false`。

## 最终验证命令与关键输出

### 前端全量

```text
npm test -w apps/web -- --run
Test Files  10 passed (10)
Tests       186 passed (186)
exit 0
```

### API sitemap 定向

```text
npm test -w apps/api -- --test-name-pattern=sitemap test/public-site-routes.test.js
tests 2 / pass 2 / fail 0
exit 0
```

### Monorepo build

```text
npm run build
web: 54 modules transformed, built in 587ms
admin: 121 modules transformed, built in 2.69s
exit 0
```

admin 构建仍打印既有动态/静态重复导入和 >500kB chunk 提示，无构建错误；本轮未扩展处理。

### 差异检查

```text
git diff --check
无输出，exit 0
```

## 自审

- 未新增依赖、路由、后台权限或 API 契约。
- 移动与桌面主导航由同一 `primaryLinks` 数据传入，业务入口参数一致。
- 旧请求的 `current` 守卫与 AbortController 双重防止跨赛事回写。
- 电话仅从已公开 contact 字段或批准副本建模，技术错误文本不进入状态或 DOM。
- 独立自审发现并通过新增 RED 修复了“两个号码仅以空格分隔”时的合并边界；复查结论为无剩余 Critical/Important/Minor。
- `/contact → 关于大赛` 按本次终审明文路由族契约保留；未采纳与该契约相反的自审建议。
- 响应式重复导航由生产 CSS 在互斥断点显示；关闭抽屉继续使用 `hidden`、`inert`、`aria-hidden`。
- 未解决项：无。

## 最终验证稳定性补丁

- RED：`BuildClean.test.js` 的真实生产 build 用例沿用 Vitest 默认 5000ms；完整套件耗时 7875ms、单独复现耗时 5052ms，均仅因测试超时失败，构建断言没有失败。
- 最小修复：只为该重型用例设置 `{ timeout: 30_000 }`，未提高全局超时，第二个轻量 cleaner 用例保持不变，生产代码未改动。
- GREEN（单用例）：`npm test -w apps/web -- --run src/__tests__/BuildClean.test.js -t "emits responsive navigation and event information rules in the production CSS bundle"` → 1 passed / 1 skipped，退出码 0。
- GREEN（完整 Web）：`npm test -w apps/web -- --run` → 10 files / 186 tests passed，退出码 0。
