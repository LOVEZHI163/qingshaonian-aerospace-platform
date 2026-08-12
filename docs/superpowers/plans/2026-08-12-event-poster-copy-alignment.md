# Event Poster Copy Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将桌面端赛事海报悬浮文案下移并缩小标题，使信息层与海报自身构图对齐，同时保持移动端和交互行为不变。

**Architecture:** 保持 `FeaturedEvent` DOM 和链接契约不变，只通过首页样式的桌面断点调整信息层布局。使用现有组件测试验证结构和可访问行为，并增加一个消费真实样式的布局契约测试保护桌面偏移与移动端重置。

**Tech Stack:** React、CSS、Vitest、Testing Library、Vite、Docker Compose

## Global Constraints

- 不改变赛事数据、报名权限或按钮跳转。
- 桌面文案下移约 40–50 像素并缩小标题。
- 手机端继续使用海报上、信息下的固定布局。
- 必须先看到新增测试因旧布局失败，再修改生产样式。

---

### Task 1: 调整桌面悬浮文案布局

**Files:**
- Modify: `apps/web/src/styles/home.css`
- Test: `apps/web/src/pages/HomePage.test.jsx`

**Interfaces:**
- Consumes: `FeaturedEvent` 中现有 `.featured-event-interaction`、`.featured-event-copy` 和 `.featured-event h2`。
- Produces: 桌面端对齐样式；移动断点继续覆盖为现有纵向信息布局。

- [ ] **Step 1: 写失败测试**

新增测试，加载真实 `home.css` 后断言桌面规则具有约 `48px` 的顶部安全偏移、较收敛的标题字号上限，并断言移动断点仍把交互层恢复为普通文档流。

- [ ] **Step 2: 验证测试按预期失败**

Run: `npm test -w apps/web -- --run src/pages/HomePage.test.jsx`

Expected: FAIL，旧样式缺少新的桌面安全偏移或标题字号约束。

- [ ] **Step 3: 最小实现**

在桌面规则中为 `.featured-event-copy` 增加约 `48px` 的向下偏移，并收敛 `.featured-event h2` 字号；在现有移动断点中明确取消偏移，保持移动信息区布局。

- [ ] **Step 4: 验证相关与全量测试**

Run: `npm test -w apps/web -- --run src/pages/HomePage.test.jsx`

Run: `npm test -w apps/web -- --run`

Run: `npm run build`

Expected: 全部 PASS，构建成功。

- [ ] **Step 5: 提交并部署**

提交测试和样式，备份服务器当前版本，通过现有发布脚本更新 API/Web，运行远程冒烟检查，确认正式站新样式可用。
