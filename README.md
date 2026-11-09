# DSH Plugin Suite

面向 Windows 上 DSH Web 的本地工具集。各插件可以独立安装。

| 组件 | 功能 | 目录 |
| --- | --- | --- |
| DSH 指挥台 | 从 Codex 或 ChatGPT 经 MCP 发起、跟踪和核对原生 DSH 任务 | [dsh-desktop](dsh-desktop/) |
| 思考摘要 | 每段思考结束后显示中文摘要，可选择摘要模型 | [dsh-thinking-summary](dsh-desktop/integrations/dsh-thinking-summary/) |
| 任务账本 | 查看任务与检查点，手动恢复，全量整理历史，智能验收及经验入库 | [dsh-workspace-ledger](dsh-desktop/integrations/dsh-workspace-ledger/) |
| 联动启动 | 从同一个窗口启动和停止 DSH Web、OpenViking 与 ChatGPT MCP 隧道 | [openviking-local](openviking-local/) |

## 安装 DSH Web 插件

本仓库以 DSH `0.2.2-rc.1` 和 Node.js 24 为验证环境。先在本机初始化 DSH 的 Web profile。在仓库根目录用 PowerShell 执行：

```powershell
$summary = (Resolve-Path './dsh-desktop/integrations/dsh-thinking-summary').Path.Replace('\','/')
$ledger = (Resolve-Path './dsh-desktop/integrations/dsh-workspace-ledger').Path.Replace('\','/')
dsh plugin --profile web add "file:$summary"
dsh plugin --profile web add "file:$ledger"
```

重启 DSH Web 并刷新。思考摘要在设置页选择模型，任务账本在会话顶部打开。经验入库需要单独运行 OpenViking。

## 验证源码

```powershell
node --test dsh-desktop/test/*.test.mjs
node --test dsh-desktop/integrations/dsh-thinking-summary/test/*.test.mjs
node --test dsh-desktop/integrations/dsh-workspace-ledger/test/*.test.mjs
node --test openviking-local/test/config.test.mjs
```

插件测试使用本机 DSH 依赖。DSH 安装在 npm 默认位置以外时，可通过 `DSH_INSTALL` 指定其包目录。

## 来源

思考摘要基于 [Rosmarinus-Young/dsh-thinking-summary](https://github.com/Rosmarinus-Young/dsh-thinking-summary)，保留 [MIT 许可证](dsh-desktop/integrations/dsh-thinking-summary/LICENSE)。任务账本借用了 [dsh-board](https://github.com/fenglufa/dsh-board) 的数据模型，详见[来源说明](dsh-desktop/integrations/dsh-workspace-ledger/UPSTREAM.md)。指挥台的 DSH 宿主桥接基于 [BeforeWave/dsh-with-chatgpt](https://github.com/BeforeWave/dsh-with-chatgpt)，保留 [MIT 许可证](dsh-desktop/vendor/LICENSE)。

密钥、运行状态和 OpenViking 数据保存在本机，按各组件说明重新配置。
