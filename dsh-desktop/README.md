# DSH 指挥台

桥接保留 Web profile 原生 `cordis` 预设。MCP 的 `bridge_health` 只做连接检查。`send_task` 创建原生 DSH 会话，`wait_task` / `get_status` 跟踪，`get_result` 取回已完成任务的结果。派发结果不明时需核对后再重试。

## 配置本机桥接

先运行一次 DSH Web，完成本机模型与工作区配置，再从仓库根目录运行：

```powershell
node dsh-desktop/server/attach-web.mjs "D:/your-workspace"
```

可在工作区路径后传入可选的本机 HTTP 代理地址供隧道使用。安装器为 Web profile 的补丁文件创建备份，写入回环地址 `127.0.0.1:3473` 的控制入口，生成本地控制凭据到用户目录的 `.dsh-desktop/config.json`。已有桥接或配置时会停止并提示。请保留仓库的路径，宿主配置引用了此处的源码。

重启 DSH Web 后运行 `node dsh-desktop/server/doctor.mjs` 验证。将本目录作为本地 Codex 插件目录使用，或将 `node server/stdio.mjs` 作为本地 stdio MCP 命令。自定义客户端可以用环境变量 `DSH_DESKTOP_CONFIG` 指定配置文件。

## ChatGPT 网页端

需要已创建的 Secure MCP Tunnel 和对应 Runtime API Key，以及 OpenAI 的 `tunnel-client.exe`。将客户端放在本目录的 `tools/` 下。双击「First-time setup.cmd」，按提示输入隧道 ID 与 Runtime API Key。密钥使用 Windows 当前用户 DPAPI 保存。

启动连接后，可在「Connection status.cmd」确认隧道轮询状态。使用联动启动器时，先关闭原先独立的连接与登录自启。原有 ChatGPT 自定义 MCP 连接可继续使用同一个隧道 ID。

宿主桥接来源为 [BeforeWave/dsh-with-chatgpt](https://github.com/BeforeWave/dsh-with-chatgpt)。本仓库保留其[许可证](vendor/LICENSE)。
