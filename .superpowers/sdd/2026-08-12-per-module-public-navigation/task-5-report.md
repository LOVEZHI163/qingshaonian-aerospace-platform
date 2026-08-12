# Task 5 report — 统一后台内容类别名称

## 实现结果

- 新增 `apps/admin/src/lib/content-type-labels.js`，集中维护后台内容类型选项及标签。
- 后台内容列表、内容编辑、转载导入和发布检查统一显示：
  - `announcement` → 通知公告
  - `news` → 新闻动态
  - `work` → 优秀作品
  - `recap` → 赛事回顾
  - `guide` → 参赛指南
- 表单选项、保存载荷和 API 内部值保持原值及批准顺序不变。
- 标签回退使用自有属性检查，未知类型（包括 `toString` 等原型键）安全显示原始字符串。
- 空列表引导更新为“创建新闻动态、通知公告或赛事资料”。

## TDD 证据

### RED

首次运行 4 个真实组件测试：89 项中 10 项按预期失败。失败直接证明旧界面仍显示“公告、新闻、作品、回顾、指南”，空状态仍显示旧称；`toString` 类型还会错误渲染为原型函数文本。

修正发布检查测试定位后，单文件 20 项中 6 项按预期失败，全部为标签或安全回退不符合要求。

### GREEN

- 聚焦组件测试：4 个文件，89/89 通过。
- 后台全量测试：50 个文件，581/581 通过。
- 后台生产构建：122 modules transformed，成功。
- 根项目生产构建：web 55 modules、admin 122 modules，成功。
- `git diff --check`：通过，无输出。

## 已知非阻塞提示

- 全量测试仍输出项目既有的 jsdom `Not implemented: navigation to another Document` 提示。
- 构建仍输出项目既有的 web 动态/静态重复导入和 admin 大 chunk 提示。
- 本任务未部署。
