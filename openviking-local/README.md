# 本机 OpenViking 与联动启动

目标环境为 Windows x64、Python 3.12。以下命令在本目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

双击「Configure API.cmd」配置百炼 Embedding。记忆整理读取本机 DSH 已配置的 DeepSeek 凭据，也可用环境变量 `DEEPSEEK_API_KEY` 指定。服务默认监听 `127.0.0.1:1933`，记忆数据库和配置保存在本机。配置完成后，可用「Connection status.cmd」检查状态。

从仓库根目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File openviking-local/start-dsh-web.ps1`，或将这条命令放进自己的桌面 BAT。启动器等待 OpenViking 就绪后打开 DSH Web，默认端口为 3080。如果已配置指挥台桥接和 MCP 隧道，则一起启动隧道。关闭启动窗口或按 Ctrl+C 会一起停止所启动的服务。

使用联动启动前，先通过各组件的停止命令关闭独立运行的实例，并停用原来的独立登录自启。浏览器可独立关闭。后台日志保存在各组件的 `runtime/` 目录。
