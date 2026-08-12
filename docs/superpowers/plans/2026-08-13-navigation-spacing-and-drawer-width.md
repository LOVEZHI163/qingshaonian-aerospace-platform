# 主导航间距与抽屉宽度调整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将桌面端主导航间距扩大到 32px，并将模块抽屉宽度收窄到 152px，同时保持响应式布局稳定。

**Architecture:** 仅修改公共网站导航样式，不改变 React 组件结构、路由或交互状态。使用现有 CSS 解析回归测试固定尺寸值，再通过真实浏览器验证关键视口。

**Tech Stack:** React、CSS、Vitest、jsdom、Vite、Docker Compose、Caddy

## Global Constraints

- 桌面主导航使用 `gap: 2rem`。
- 桌面模块抽屉使用 `inline-size: 9.5rem`。
- 不改变导航文字、字号、字重、居中方式、悬停和键盘交互。
- 不改变移动端信息架构。
- 1294px 下导航不得换行、不得与右侧操作按钮重叠。

---

### Task 1: 调整导航尺寸并部署

**Files:**
- Modify: `apps/web/src/styles/navigation.css`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`

**Interfaces:**
- Consumes: 现有 `.primary-navigation-links` 与 `.public-mega-drawer` 样式规则。
- Produces: `gap: 2rem` 的桌面主导航和 `inline-size: 9.5rem` 的模块抽屉。

- [ ] **Step 1: 写入失败的样式回归测试**

```jsx
expect(navigation.gap).toBe("2rem");
expect(drawer["inline-size"]).toBe("9.5rem");
```

- [ ] **Step 2: 运行聚焦测试并确认按预期失败**

Run: `npm test -w apps/web -- --run src/__tests__/Accessibility.test.jsx`

Expected: FAIL，当前值分别为 `1.5rem` 与 `11rem`。

- [ ] **Step 3: 编写最小样式实现**

```css
.primary-navigation-links {
  gap: 2rem;
}

.public-mega-drawer {
  inline-size: 9.5rem;
}
```

- [ ] **Step 4: 运行聚焦测试、Web 全量测试和构建**

Run: `npm test -w apps/web -- --run src/__tests__/Accessibility.test.jsx`

Expected: 40/40 PASS。

Run: `npm test -w apps/web -- --run`

Expected: 204/204 PASS。

Run: `npm run build`

Expected: Web 与 Admin 均构建成功。

- [ ] **Step 5: 浏览器验证关键视口**

在 1294px、1121px 和 390px 视口分别验证：

- 1294px 主导航计算间距为 32px，五项顶部坐标一致，与右侧按钮有正向间隔。
- 1121px 无横向溢出或重叠。
- 390px 无横向溢出，沿用既有移动端导航规则。
- 展开“关于大赛”和“赛事资讯”时，抽屉计算宽度为 152px，长文字保持单行可读。

- [ ] **Step 6: 提交实现**

```bash
git add apps/web/src/styles/navigation.css apps/web/src/__tests__/Accessibility.test.jsx
git commit -m "style(web): refine navigation spacing and drawer width"
```

- [ ] **Step 7: 备份、部署与线上校验**

部署前生成数据库、上传文件、源代码和当前镜像回滚点；使用 `git archive` 将提交部署到 `/opt/aerogp`，执行预检、镜像构建和健康等待。

Run: `EXPECTED_RELEASE=<commit> BASE_URL=https://aerogp.cn /bin/sh deploy/verify-release.sh`

Expected: 版本一致，健康检查及公开页面均返回预期状态。

Run: `ADMIN_TEST_PASSWORD=<server credential> BASE_URL=https://aerogp.cn /bin/sh deploy/remote-smoke-test.sh`

Expected: 完整冒烟测试通过，测试数据清理成功。

