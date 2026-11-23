# dsh-turn-notify

自建的 DSH 会话通知插件，参考 `@telosmaylx/dsh-session-notify` 的思路重写，重点解决两件事：

1. **通知内容必须对应「这一轮」**：旧插件把每个会话最新的通知存在投影里，客户端看到
   `running: true → false` 就立即读投影；如果投影还是上一轮的（新通知尚未落盘/投影未刷新），
   就会把旧正文当成这一轮弹出来。
2. **页内 toast 不重复、不挡审批按钮**：系统通知弹成功就不再叠 toast；toast 仅作兜底，
   且 `pointer-events:none`，只留一个可点的小 ×。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主侧：订阅 `session/event`，在 `turn/end` 生成通知并写会话日志 + 投影 |
| `lib/client.js` | 客户端侧：监听会话列表 running 边沿，校验投影新鲜度后推送 |
| `cordis.patch.yml` | bundle 挂载（id `dsh-turn-notify`） |
| `test/host.test.mjs` | 宿主单测：通知文案、轮次身份、投影状态 |
| `test/client.test.mjs` | 客户端单测：旧投影不推送、新投影推送、toast 兜底不拦截鼠标 |

## 关键设计：轮次身份

宿主在写系统消息时带上：

```js
source: { kind: 'plugin:dsh-turn-notify', reasonKind, titleText, turn, endedAt }
```

投影单元 `dsh-turn-notify` 的状态是：

```js
{ kind, title, text, turn, endedAt, seq }
```

客户端在会话进入 `running: true` 时记下当时的投影 `seq` 和墙钟时间；轮次结束时：

- 投影 `endedAt` 必须不早于本轮开始（-1.5s 容忍）；
- 或不带 `endedAt` 的旧宿主上，`seq` 必须大于基线；

否则继续轮询（300ms 间隔，最多 8 秒），超时用**通用文案**兜底——绝不把上一轮的正文当成本轮。

## 审批 / 提问提醒

- **权限审批**：会话列表快照 `pendingInteraction === 'approval'` 时立即提醒，正文形如
  「会话「X」需要审批（工具：bash），请前往处理。」；工具名来自宿主审批投影
  `dsh-turn-notify-approval`（`approval/asked` 写入、`approval/decided` 清空）。
- **AI 提问**：`pendingInteraction === 'question'` / `'plan-review'` 时提醒
  「会话「X」正在等待你的回答」。
- 同一次审批/提问只提醒一次；两者都不依赖 `running` 边沿，点通知同样会跳到对应会话。

## 哪些会话会提醒

- **主会话**：完成 / 出错 / 中止 / 阻塞 / 达到上限时提醒；
- **子代理会话**（`origin === 'subagent'`）：不提醒——宿主侧不写投影，客户端也直接跳过，
  否则每个子代理轮次都会在超时后弹一条「任务已结束」噪音；
- 从未产生过通知投影的会话：即使超时也不发兜底通知（基线为 0 直接静默），只有
  曾经正常通知过的会话在投影迟到时才用通用文案保底。

## 点击通知跳转

系统通知的 `onclick`：

1. **sidechat 子会话**：先查 `localStorage['dsh.sidechat.v1.threads.<parentId>']` 找到父会话，
   再走 `ctx.get('sidebarRight').openTab('side-chat', {params:{parentSessionId, childId}})`，
   开在**右侧边栏**里（否则会被当成主会话打开）；
2. **普通会话**：`ctx.get('uiWorkspace').openSession(sessionId)`——侧栏点击会话时走的入口；
3. 旧宿主退回 `ctx.sessions.open()`，再不行只聚焦窗口。

> `ctx.sessions` 上并没有 `open()`，之前用它只会得到 `open-missing`。

macOS/Electron 下点击系统通知有时只把窗口带到前台、不触发渲染进程的 `onclick`，
因此还有一层兜底：发通知时记下会话，窗口在 20 秒内重新获得焦点就直接跳转；
如果用户先在页面里点了一下（mousedown），视为手动切窗口，取消这次自动跳转。

兜底 toast 卡片本身不接收鼠标，但带一个可点的「查看」按钮，点击同样跳转。

排查用：最近 20 条 `notification / click / focus / mousedown-clear / open-ok / open-failed`
事件会写进 `localStorage['dsh-turn-notify.debug']`。

## 通知文案

只保留「哪个会话 + 结果」，不放大段回复或错误详情：

```text
会话「重构登录」已完成。
会话「连接问题」出错。
会话「需要审批的会话」需要审批（工具：bash），请前往处理。
```

## 安装

已在 `~/.dsh/profiles/desktop` 安装：

- `package.json` 依赖加 `"dsh-turn-notify": "link:.../dsh-turn-notify"`；
- `node_modules/dsh-turn-notify` 指向本目录；
- `dsh.profile.bundles` 加入 `dsh-turn-notify`（同时移除了旧的
  `@telosmaylx/dsh-session-notify`，避免两套通知重复弹）。

**宿主侧改动需要重启 DSH 才生效**；之后刷新页面即可。

## 验证

```bash
cd ~/Documents/deepseek-harness/default-workspace/dsh-turn-notify
node --test test/*.test.mjs
```

运行日志：`~/.dsh/turn-notify.log`（投影注册、追加失败等）。

## 回滚

```bash
cp ~/.dsh/profiles/desktop/package.json.bak-turn-notify ~/.dsh/profiles/desktop/package.json
```

（该备份是替换前的版本：旧通知插件在 bundles 里、新插件尚未加入。）
