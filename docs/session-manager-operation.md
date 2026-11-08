# 微信任务总管运行说明

## 试用

1. 在新版检出目录运行 `npm ci`、`npm test` 和 `npm run check`。
2. 在该目录的 `.env` 设置微信用户白名单，并指向本机的 Codex 命令。设置 `CODEX_WECHAT_ALL_LOCAL_SESSIONS=true` 可管理本机 Codex 的未归档可见会话，也可以设置项目目录白名单来限定范围。复用已扫码账号时，将 `CODEX_WECHAT_STATE_DIR` 指向现有状态目录；如有自定义 `CODEX_WECHAT_SYNC_BUFFER_DIR`，也保持指向原游标目录。新目录可用 `npm run login` 配对。
3. 启动新版前先停掉同一个微信账号的旧轮询进程。进入新版检出目录，运行 `npm start`，在手机发送「在吗」和「列出会话」验证。
4. 在微信说「让测试会话只回复 OK」。总管会按原会话 ID 续接或排队。通过原会话 ID 核对实际运行结果。

总管按会话持有方派活。共享 App Server 已加载的会话由该服务接收；在 macOS 上确认 Codex App 持有会话时，桥接使用本机 `codex queue` 将任务单排入原会话。归属无法确认时，请在原客户端打开会话后重发，或确认释放后回复「确认移交」。排队回执表示原生队列已收件，实际执行由持有会话的客户端接收。

总管优先复用能承接任务的会话。任务可以独立执行、项目明确且找不到匹配会话时，可以在该项目新建。拿不准时，会询问是否新建，或列出可复用的候选。可以回复「新建会话」、选编号或说「取消」。仅查进度和总结时不会新建，已有会话忙或无法续接时也不会自动改派到新会话。对没有会话记录的项目，可以直接提供本机项目目录。

新会话由本机 App Server 创建并写入第一轮，在同一台机器的 Codex App 中可以按标题查找。仅要求建会话时，第一轮只用于初始化，不执行项目任务。微信会返回会话 ID，派出的任务仍按原流程回报结果。

总管派出的任务会在本地数据库记录追踪编号，桥接重启后继续跟踪。确认对应会话的执行已完成、失败或中断后，会将该任务的结果整理成微信汇报。模型不可用时使用原会话的文字记录。

要监听已经在跑的任务，可以说「帮我盯着 Cocos 台球和 project-b，有关键进展或结束时通知我」「正在盯哪些任务」或「别再盯 project-b」。每条监听绑定订阅时正在执行的那一轮，跨项目独立运行，桥接重启后继续，等到完成、失败、中断或手动停止后结束。结果与总管派活的回报会按会话和轮次去重。

监听只读查询 Codex 保存的记录。对已记录的关键进展和可见的等待审批、等待补充信息会发通知，同一任务的中途提醒最多每分钟一次，结束结果独立发送。独立桌面进程的运行细节以它实际落盘的记录为准。如果记录显示中断但没有结束时间，监听会继续等待，避免把仍在运行的任务误报为中断。

可以随时问「atoms-demo 最新进展是什么」或「总结 atoms-demo 这轮是怎么做的」。总管按轮次翻查已保存的阶段更新和验证记录，依次汇报做过的事、关键决定、测试证据和待确认项。任务结束时，回报也会带上能查到的关键过程。过长的记录会提示此次覆盖范围。

启动后可以在 `CODEX_WECHAT_STATE_DIR` 找到 `deliveries.sqlite`。首次启动时从旧游标文件继续轮询，之后由 SQLite 同时保存入站批次和游标。数据库包含待处理消息、回复和所需的微信上下文，请与本机凭证一起保管。账号或状态目录不同的部署各自维护数据。

## 启用模型

在本机 `.env` 中设置 `CODEX_WECHAT_AGENT_MANAGER=true`，复用本机 Codex 登录。每个微信对话有独立的总管会话 ID，保存在桥接本机状态中，普通消息按原 ID 续接。总管会话在专用目录只读运行，并关闭 shell、网页、浏览器、应用和插件功能。项目会话列表会过滤总管会话。选填 `CODEX_WECHAT_MANAGER_MODEL` 可指定模型。

同时设置 `CODEX_WECHAT_MODEL_API_KEY` 和 `CODEX_WECHAT_MANAGER_MODEL` 可让后台汇报使用 OpenAI Responses API。总管对话保存目标、约束和派活决策；项目会话负责检查源码和设计稿。直接续接的排查使用只读沙箱，原生队列中的排查在任务单里明确限定只读，由持有会话的客户端执行。完成后，独立的汇报请求整理结果。

## macOS 托管

把下面的示例填好后保存为 `~/Library/LaunchAgents/local.codex-wechat.manager.plist`。`WorkingDirectory` 是含 `.env` 的检出目录。`ProgramArguments` 和日志使用完整路径，`PATH` 包含 Node.js 和 Codex 所在目录。预先创建日志目录。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.codex-wechat.manager</string>
  <key>WorkingDirectory</key><string>/absolute/path/codex-wechat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/node</string><string>./bin/codex-wechat.js</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/absolute/path/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/absolute/path/logs/codex-wechat.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/logs/codex-wechat-error.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.codex-wechat.manager.plist"
launchctl print "gui/$(id -u)/local.codex-wechat.manager"
# 停止服务
launchctl bootout "gui/$(id -u)/local.codex-wechat.manager"
```

## 故障与恢复

- 微信仍在线但 Codex 断线时，「在吗」会显示 Codex 暂不可用。桥接会单独重连 Codex。
- 重启后恢复尚未领取的消息和待发文本回复。文本回复重试复用原客户端消息 ID。若提交可能已被 Codex 接收，则提示「待确认」，由用户在原会话核对。
- 图片和文件沿用原媒体传输，收发故障会提示，发件箱恢复范围为文本回复。
- 微信提示凭证失效时，停掉该账号的服务，重新执行 `npm run login` 并扫码，再启动服务。
- 回退旧版前先停新版。新版的游标保存在 SQLite，旧版使用游标文件；需要保留消息位置时，先从 SQLite 的 `cursor` 表把对应账号的 `value` 导出到旧版该账号的游标文件。

## 共享 App Server

在仅本机用户可访问的目录创建 Unix socket，以独立服务运行 `codex app-server --listen unix:///absolute/path/control.sock`。在桥接 `.env` 中设置 `CODEX_WECHAT_CODEX_ENDPOINT=ws+unix:///absolute/path/control.sock:/`，重启桥接后由该服务运行微信任务。终端 Codex 可用 `codex --remote unix:///absolute/path/control.sock` 接入同一运行实例。

通过这个共享服务执行的会话能在微信和终端查询同一实时状态。由独立桌面进程承载的会话仍显示已保存的历史结果。总管保留最近讨论或派活的会话，结合用户新消息判断是否仍是同一主题；关联会话归档或不可用时，回复项目名可继续查询。编号对应最近一次发出的列表，直到显示新列表，桥接重启后也可用。新的操作会替换等待选择或确认的动作，用户也可以说「取消」。
