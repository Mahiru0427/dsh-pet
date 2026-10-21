# 可选 Codex 工作状态适配（Draft / RFC）

本提案复用现有 standalone、动画、物理与素材，只新增显式启用的本地事件桥接。
DSH 默认入口、包名、默认数据目录、AI 设置与原安装方式不变；不启用时不订阅外部事件。

## 先确认维护边界

希望维护者确认：Codex 适配是否适合放在主仓可选入口，还是更适合外置伴随包？
本 PR 先提供可以独立验证的工作状态接缝；独立窗口启动器、Codex 登录模型/额度、聊天和平台通知留待边界确定后拆分提交，避免与 #159 的桌面打包重复。
上游核心和素材仍在本仓更新，不另交一份改名后的插件副本。此 PR 不包含安装包、二进制、重复素材、用户配置或账号数据。

## 手动启用

先按主仓流程安装依赖并构建。使用 **Node >= 22.12** 运行 hook，不把 Electron GUI 当作 Node。
为了避免与原 DSH 桌宠设置混用，建议在新的专用目录中运行 standalone，例如：

```sh
# macOS / Linux，路径可自行选择
DSH_HOME="$HOME/.dsh-pet-codex" \
DSH_PET_CODEX_EVENTS="$HOME/.dsh-pet-codex/events" \
node lib/standalone.js
```

```powershell
# Windows PowerShell
$env:DSH_HOME = Join-Path $env:LOCALAPPDATA 'DshPetCodex'
$env:DSH_PET_CODEX_EVENTS = Join-Path $env:DSH_HOME 'events'
node .\lib\standalone.js
```

`DSH_PET_CODEX_EVENTS` 必须是专用绝对路径，不能指向用户文档或任意 JSON 目录。
写入器和读取器均不自动启动其他应用。停止 standalone 后 hook 不会把它重新拉起；超过两分钟的排队事件会丢弃，崩溃未发结束事件的会话三十分钟后释放。

将所需 Codex command hooks 指向以下命令，按平台正确引用**三个绝对路径**：Node、脚本、同一个队列目录。例如一条处理器命令的形状是：

```text
"/absolute/path/to/node" "/absolute/path/to/dsh-pet/scripts/codex-hook.mjs" "/absolute/path/to/queue"
```

Windows 使用原生 Node.exe 和 Windows 路径；不要将上面的 POSIX 示例原样复制到 PowerShell。
在现有 `hooks.json` 中逐项合并，不要覆盖原处理器。每个事件的处理器都是 `type: "command"`，将完整命令放在 `command` 字段。支持的事件见下表。
本 PR 不编辑 `hooks.json`、`config.toml`、登录凭据或信任库。需由用户按当前 Codex CLI/桌面宿主支持的入口审核和信任定义；CLI 中的 `/hooks` 不是 PowerShell 命令，CLI 信任也不等于桌面宿主实测。
删除这些处理器即可卸载桥接；更换脚本路径需相应更新处理器并重新审核。

## 事件与隐私

| Codex 事件                     | 原插件事件                                              |
| ------------------------------ | ------------------------------------------------------- |
| UserPromptSubmit / PostCompact | turn/start                                              |
| PreToolUse                     | tool/call；提问工具映射 ask_user_question               |
| PostToolUse / PreCompact       | tool/result                                             |
| PermissionRequest              | approval/asked                                          |
| Stop                           | turn/end completed；stop_hook_active 时只发 tool/result |
| Interrupt / SessionEnd         | turn/end aborted                                        |

`Stop` 只表示一轮结束，不能证明整个长期目标完成。

hook 只保留事件名、会话 ID、工具名、stop_hook_active 和本地产生的时间戳。
提示词、工具参数/输出和任意额外字段均丢弃。hook 不调用模型，不读 Codex 工作聊天或登录凭据，不向 stdout/stderr 输出内容，失败不阻塞任务。
超过 2 MiB 的原始输入不入队；消费端仅处理自己命名格式的普通文件，拒绝超过 4 KiB、符号链接、过期/未来或格式错误的事件，每轮最多处理100项。它是同用户本机传输，不是跨用户认证边界；Windows 文件访问权依赖目录继承的 ACL。

## 验证范围与后续候选

本 PR 的单元/集成测试可用临时目录和模拟事件重复执行，无模型生成、无原应用设置写入。
它不把人工事件注入当成真实 Codex 桌面任务验收。

另有本地独立适配候选（未作为上游正式版本发布），已获得部分 Windows 11 基础桌宠、模型/额度、通知和授权三次 AI 生成证据；Mac 构建/连接/事件回归也有记录。但真实桌面宿主完整状态、多屏、休眠、登录启动等仍未全部验收；Windows 验收期间原 `config.toml` 哈希变化的来源尚未定位，不能宣称原配置全部未变。该候选数据不替代本 PR 的测试，也不构成原作者背书。

后续若认可方向，可按小 PR 分开提交通用打包修复、可选 Codex app-server 服务和独立设置入口；素材、动画、物理继续跟随原项目，而非覆盖上游核心。

## 许可与署名

原项目：https://github.com/PC2005-cloud/dsh-pet 。代码遵循原 MIT；动画/提示词/源视频遵循原作者说明（允许开源使用、禁止商用），二创展示/介绍/分发保留原项目链接。本 PR 未增加或替换素材。
