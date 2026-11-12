# codex-wechat

**Code by Codex**

`codex-wechat` 直接复用微信插件背后的微信 HTTP 协议，把链路改成：

`微信 App -> codex-wechat -> 本地 codex app-server -> 微信 App`

OpenClaw 不再作为运行时参与；这里只借用了 `@tencent-weixin/openclaw-weixin` 所用的登录和消息协议。

## 能力

- 微信扫码登录，保存本地 `bot_token`
- `getupdates` 长轮询收消息
- 本地启动或连接 `codex app-server`
- 按微信用户维度维护工作区与 Codex 线程绑定
- `/codex new` 会切到新会话
- 支持微信内 `/codex ...` 控制命令

## 安装

需要 Node.js 22.13 或更高版本。

```bash
npm ci
```

## 配置

复制 `.env.example` 到 `.env`，常用项：

- `CODEX_WECHAT_DEFAULT_WORKSPACE`
  - 设置后，微信里可以直接发自然语言，不必先 `/codex bind`
- `CODEX_WECHAT_ALLOWED_USER_IDS`
  - 只允许指定微信用户控制本机 Codex
- `CODEX_WECHAT_DEFAULT_CODEX_ACCESS_MODE`
  - `default`：工作区写入 + 需要审批
  - `full-access`：全权限，不需要审批

## 登录微信

```bash
npm run login
```

终端会打印二维码。扫码确认后，会把账号信息保存在：

```text
~/.codex-wechat/accounts/<account-id>.json
```

如果你登录了多个微信账号，可以通过 `CODEX_WECHAT_ACCOUNT_ID` 指定启动哪一个。

也可以查看已保存账号：

```bash
npm run accounts
```

## 启动

```bash
npm run start
```

或：

```bash
node ./bin/codex-wechat.js start
```

## 微信任务总管

配置 `CODEX_WECHAT_ALLOWED_USER_IDS` 后，可选择项目范围，或设置 `CODEX_WECHAT_ALL_LOCAL_SESSIONS=true` 查看和续接本机所有未归档的可见会话。可以在微信里说：

| 你发的消息 | ClawBot 的操作 |
| --- | --- |
| 列出会话 | 按最近更新时间从新到旧列出本机会话，每页 10 条；回复「下一页」查看更多 |
| 切到修审批的那条会话 | 按项目和标题查找，多条匹配时返回编号 |
| 第一条 | 选中刚才列表中的会话 |
| 我想看第二个任务 | 读取最近一页列表的第二条，后续说「看看进度」会沿用它 |
| 让 `code_bot` 的审批会话先跑一遍测试 | 总管给原会话派活，结束后汇报关键过程和结果 |
| 当前会话还在跑吗 | 查询所选会话的状态 |
| 给我汇报一下 Cocos 台球项目现在的状态 | 读取匹配项目最近更新的会话，返回状态和进展 |
| 总结一下 atoms-demo 这轮是怎么做的 | 读取阶段更新和验证记录，汇报关键步骤、决定和待办 |
| 在 atoms-demo 里新建一条回归验证会话 | 通过本机 Codex 创建会话，可在 Codex App 中找到 |
| 帮我同时盯着 atoms-demo 和 Cocos 台球 | 监听这两个项目当前在跑的任务，主动通知关键进展和结束状态 |
| 正在盯哪些任务 | 查看正在监听的任务，或说「别再盯 atoms-demo」停止监听 |
| 查证一下审批会话之前有没有通过测试 | 查看会话里的执行记录和证据缺口 |
| 排查 Cocos 袋口为什么和设计稿不一致 | 给 Cocos 原会话派发只读排查，完成后在微信汇报 |
| 在吗 | 查看桥接与 Codex 连接状态 |

设置 `CODEX_WECHAT_AGENT_MANAGER=true` 后，普通消息进入每个微信对话专用的持续 Codex 总管会话，桥接重启后按原 ID 续接。总管复用本机 Codex 登录，程序核对目标和权限后再调用项目会话。后台总结可选用 OpenAI Responses API。帮助、桥接状态、编号选择和续接确认保留直接处理入口。详细步骤见[运行说明](docs/session-manager-operation.md)。

列表中的「运行中」「等待审批」等来自当前 App Server。「上次完成」「上次失败」等来自最近保存的任务记录；会话在独立的桌面进程中运行时，以 Codex App 的实时状态为准。

## 命令说明

### 终端命令

- `codex-wechat login`
  - 发起微信扫码登录，保存当前微信账号的 `bot_token`
- `codex-wechat start`
  - 启动微信长轮询和本地 Codex 桥接服务
- `codex-wechat accounts`
  - 查看本地已经保存的微信账号
- `codex-wechat help`
  - 查看 CLI 帮助

### 微信内命令

- `/codex bind /绝对路径`
  - 绑定当前微信用户会话到指定本地项目目录，后续普通消息都会发到这个项目对应的 Codex 线程
- `/codex where`
  - 查看当前会话绑定的项目、线程、运行状态、模型和推理强度
- `/codex workspace`
  - 查看当前会话记录过的所有项目绑定，以及每个项目当前选中的线程
- `/codex sessions [页码]`
  - 跨项目列出可管理的本机 Codex 会话，显示编号、标题、更新时间和状态。回复编号选中会话
- `/codex use <会话ID> [--confirm-idle]`
  - 按完整 ID 选中并续接已有空闲会话，后续消息发到原会话。会话状态未知时，先确认原任务已结束并关闭原会话，再加 `--confirm-idle` 重试
- `/codex summary [会话ID]`
  - 在后台总结当前或指定会话
- `/codex status`
  - 查看微信桥接和 Codex 连接状态
- `/codex new`
  - 切换到新会话；不会立刻创建空线程，下一条普通消息才会真正开始一个新线程
- `/codex switch <threadId>`
  - 切换当前项目对应的 Codex 线程
- `/codex message`
  - 查看当前线程最近几轮用户和助手消息；如果当前还是新会话，会提示先发送普通消息开始
- `/codex stop`
  - 停止当前线程里正在执行的 Codex 任务
- `/codex model`
  - 查看当前项目正在使用的模型，以及当前已缓存的可用模型列表
- `/codex model update`
  - 重新向 Codex 拉取一次可用模型列表，并刷新本地缓存
- `/codex model <modelId>`
  - 为当前项目设置模型；如果当前推理强度不兼容，会切换到该模型默认推理强度
- `/codex effort`
  - 查看当前项目的推理强度，以及当前模型支持的推理强度列表
- `/codex effort <low|medium|high|xhigh>`
  - 为当前项目设置推理强度
- `/codex approve`
  - 允许当前线程正在等待的这一次授权请求
- `/codex approve workspace`
  - 允许当前授权请求，并把当前命令前缀加入该工作区的自动放行名单
- `/codex reject`
  - 拒绝当前线程正在等待的授权请求
- `/codex remove /绝对路径`
  - 从当前微信会话中移除某个项目绑定
- `/codex send <相对文件路径>`
  - 把当前项目里的文件发送到当前微信聊天窗口；图片按图片发送，视频按视频发送，其他文件按附件发送
- `/codex help`
  - 查看微信内命令帮助

### 普通消息

- 非 `/codex ...` 开头的普通文本消息
  - 会直接发送到当前项目对应的 Codex 线程
- 如果当前会话还没绑定项目
  - 需要先执行 `/codex bind /绝对路径`

跨项目会话管理需要配置获准使用的微信账号。`CODEX_WECHAT_ALL_LOCAL_SESSIONS=true` 时可访问本机可见会话；其他情况下使用 `CODEX_WECHAT_WORKSPACE_ALLOWLIST` 限制项目范围。总管优先复用合适的原会话，对无法确认归属的会话会询问是否移交。任务独立且项目明确时，可在找不到合适会话后创建新会话，拿不准时先询问。重启后仍保留总管上下文和监听。

## 工作方式

1. 微信收到文本消息
2. `codex-wechat` 解析命令或普通对话
3. 普通对话进入本地 Codex 线程
4. 运行过程中发送 typing 指示
5. Codex 完成后，结果回发到微信
6. 如果 Codex 请求授权，微信里用 `/codex approve` 或 `/codex reject` 处理

## 实现说明

- 本项目参考了：
  - `@tencent-weixin/openclaw-weixin` 的微信扫码和消息 HTTP 协议
  - `codex-im` 的本地 Codex JSON-RPC 接入方式
- `@tencent-weixin/openclaw-weixin-cli/cli.mjs` 本身只是安装器
- 本项目直接复用了微信协议和 Codex RPC 思路，但不依赖 OpenClaw 作为运行时

## 备注

- 微信端富媒体入站会先落盘到当前工作区，再以文件路径形式交给 Codex。
- 微信出站会做兼容性过滤，尽量保留代码块、表格和常见 Markdown 结构。

## 问题

- 返回 “当前账号未允许该微信号控制本机Codex” - 检查 .env 中配置的 CODEX_WECHAT_ALLOWED_USER_IDS 是否为当前使用的微信号

## 后续计划：
- [X] codex在执行长一点的任务时，只会在执行完成后输出消息，优化提示，告诉用户任务执行中(微信现在会显示输入中，因此不用再实现了)

- [ ] codex执行完任务后输出信息可能超过单条消息上限导致截断，优化消息提示

- [ ] 支持Plan模式

## 实验性的功能：
- 微信上产生的任务可以在本机的codex上看到（feat/historyShare分支实现）
