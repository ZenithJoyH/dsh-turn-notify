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

## 摘要来源（按可靠性排序）

1. 官方 `turnOutline` 投影里本轮的 `response`（宿主已落盘，最可靠）；
2. 实时 `assistant/message` 事件的 `data.message.content`（跳过 reasoning 块）；
3. 都没有 → 正文只写「会话「X」已完成。」。

> 观察者收到的 `assistant/message` 载荷可能被裁剪，所以不能只依赖第 2 条。

## 通知文案

```text
会话「重构登录」已完成：已完成重构，测试通过。   ← 完成，带最终回复摘要
会话「连接问题」出错：Connection error.           ← 出错，带错误详情
```

摘要取该轮最后一条 `assistant/message` 的文本，单行化并截断到 100 字，让通知正文与
实际任务内容对应，而不是只有一句「已完成」。

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
