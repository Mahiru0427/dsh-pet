# 第三方 Codex 工作状态适配器（实验候选）

按 [原作者在 #160 的建议](https://github.com/PC2005-cloud/dsh-pet/pull/160#issuecomment-6314176825)，具体软件对接由第三方维护。此目录只通过官方通用 HTTP 接口工作，不修改原插件源码、包名、DSH 默认入口、素材或 Codex 配置。

原桌宠核心/素材继续来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)；需要其主仓至少包含 [通用状态接口提交 8f0ecfc](https://github.com/PC2005-cloud/dsh-pet/commit/8f0ecfcef917e1ba69255877d68fe07b2444dbb5)。`main` 上的能力可能尚未进入 npm 最新版本，不要假设任意 0.3.7 安装包都具有接口。

## 维护边界

- 上游只维护 `POST/DELETE /dsh-pet-7340/work-status` 的六个档位，不处理 Codex hook 契约。
- 本外置适配器自己映射 hooks、聚合多会话、处理失效清理、连接与信任说明；不要求上游合并这些文件。
- 此接口只有一个固定外部 `api` 槽，最后写入生效：**只能由一个外部适配器独占写入**，不能与其他独立写者混用。本适配器会在启动空闲、终止或清理时 DELETE 该槽。同一队列的 PID 锁只阻止本适配器重复启动，不是整个API的跨程序锁。
- 原上游 DSH 会话仍按其规则与外部槽一起参与优先级。Codex多个会话先在这里聚合，单个结束不会清掉其他活跃会话。

## 运行

Node >=22.12，无新增依赖。先按上游说明在**新的专用 DSH_HOME** 构建、启动官方 standalone，保留其专属 `dsh-pet/standalone-runtime.json` 在本机，不复制登录凭据。

然后运行以下两个绝对路径参数：

```sh
node adapters/codex/adapter.mjs /absolute/private/events /absolute/private/dsh-pet/standalone-runtime.json
```

Windows同样使用原生Node.exe与Windows绝对路径，并正确引用带空格路径。不要把Electron GUI当Node。

在 Codex 的所需 command hook 中调用：

```text
"/absolute/path/to/node" "/absolute/path/to/adapters/codex/hook.mjs" "/absolute/private/events"
```

逐项合并已有处理器，由用户在当前宿主支持的入口审核信任。不会自动改 hooks.json、config.toml 或信任库。CLI 的 `/hooks` 是 CLI 内命令，不是 PowerShell 命令；CLI信任不代表桌面宿主必然支持。更换路径需重新审核。删除这些处理器、停止适配器即可卸载。不会自动启动原Codex/桌宠。

支持 UserPromptSubmit、PreToolUse、PostToolUse、PermissionRequest、PreCompact、PostCompact、Stop、Interrupt、SessionEnd。只传事件名、会话ID、工具名、stop标志及时间，不记录提示词或工具参数/输出。Stop代表一轮完成，不保证整个长期任务完成。成功状态10秒后由适配器显式清空；活跃会话30分钟无事件后清理。

本适配器仅绑定 `127.0.0.1` 和固定状态API；从上游本机运行清单读取能力令牌，仅在HTTP头使用，不在日志输出，也不信任清单中提供的远程URL。`events/adapter-status.json` 显示连接状态；服务重启后重新读清单并同步。hook失败不阻塞Codex；不调用模型，不消费生成额度。

队列为当前用户专用；Windows权限继承目录ACL。不要指向存放普通文档的目录。不支持跨机器/WSL桥接；信任、实际宿主事件覆盖、完整多屏/休眠仍需实机验收。

## 验证

```sh
node --test adapters/codex/*.test.mjs
```

测试包含并发会话、终态/崩溃清理、非法输入、重复队列所有权、固定loopback目标、真实本地HTTP及失败处理。它们不替代Codex桌面真实任务验收。先前独立便携版0.1.2不因本目录发布而自动升级；上游更新仍需固定版本、适配测试后再发包，不承诺自动兼容。

代码遵循原MIT。原动画/提示词/源视频仍遵循原作者非商用和署名约定；此目录未新增或复制素材。本外置候选由第三方维护，不代表原作者背书。

当前验证：11/11 适配器测试通过；在未修改的上游 `7f54ef7` 构建服务上，真实 hook 子进程 → 外置适配器 → 官方 HTTP 接口的6类状态链路通过。使用隔离数据目录，未调用模型。此结果不是 Codex 桌面真实任务的完整验收。
