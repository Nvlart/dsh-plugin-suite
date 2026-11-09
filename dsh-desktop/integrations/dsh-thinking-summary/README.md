# dsh-thinking-summary

DSH Web 插件：中文思考摘要。让看不懂英文思考过程的用户也能跟上模型的工作节奏：

- 在原生 **"Deep diving"** 状态文字右侧实时显示"下一步计划"（思考刚结束即出现，命令执行前可见）；
- 在消息流中**每段思考的正下方**插入摘要卡片（计划 + 详细摘要，卡片直接显示内容、无标题行）；
- 摘要由配置的模型生成。支持 `off` 时关闭思考，否则使用提供商默认设置，失败按配置重试；
- 只处理插件激活后新产生的消息，历史消息不受影响。

## 安装

前提：已安装 DSH（`@deepseek-ai/dsh`），且 `pnpm`、`git` 在 PATH 中。

```bash
dsh plugin --profile web add "file:./dsh-desktop/integrations/dsh-thinking-summary"
```

安装后**重启 `dsh web`**（插件集合变更在重启后生效）。

> 该命令会转发给 pnpm 把插件装进 profile 目录，然后自动把它加入
> `dsh.profile.bundles` 插件层（因为本包声明了 `dsh.bundle`），无需手工配置。
> 在本仓库根目录执行。

## 更新

```bash
dsh plugin --profile web add "file:./dsh-desktop/integrations/dsh-thinking-summary"
```

然后重启 `dsh web`。

## 卸载

```bash
dsh plugin --profile web remove dsh-thinking-summary
```

然后重启 `dsh web`。

## 设置

Web 界面 → 设置 → **思考摘要** 标签页：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 在 Deep diving 右侧显示计划 | 开 | 关闭后原生状态文字保持原样 |
| 显示思考摘要卡片 | 开 | 关闭后不再在消息流插入卡片 |
| 计划长度上限 | 36 字 | 12–48，超出按标点边界截断 |

设置写入后立即生效，无需重启。

## 数据流

```
session/event 日志（assistant/chunk 提前还原思考文本）
  → 推理块结束即触发
  → 摘要模型（按能力优先关闭思考）
  → 计划（后缀显示）+ 摘要（流内卡片）
```

客户端通过 `/thinking-summary/api/*`（同源路由）轮询 Host 状态。

## 开发

```bash
# 本地联调：在 profile 中以文件方式安装（pnpm 会复制文件，改完需重跑或同步）
dsh plugin --profile web add file:.
```

发布新版本：提交改动 → 打标签（如 `v1.1.0`）→ `git push && git push --tags`，用户执行 `update` 即可升级。
