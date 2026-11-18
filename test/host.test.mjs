import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, __setSchemaProvider } from '../lib/index.js'

// 极简 schema 替身：宿主投影注册只用到 object/string/number
const FakeSchema = {
  object(shape) { return { shape } },
  string() { return { type: 'string' } },
  number() { return { type: 'number' } },
}
__setSchemaProvider(FakeSchema)

function makeCtx() {
  const handlers = []
  const ctx = {
    logger: { warn() {} },
    on(type, fn) { handlers.push({ type, fn }) },
    inject(names, cb) {
      const state = { kind: '', title: '', text: '', turn: 0, endedAt: 0, seq: 0 }
      ctx.__registry = {
        registered: null,
        register(def) { this.registered = def; this.state = def.init() },
        snapshot() { return { values: {} } },
        emit(event) { this.state = this.registered.apply(this.state, event) },
      }
      cb({ sessionProjections: ctx.__registry })
    },
    root: { get: () => undefined },
  }
  ctx.fire = (session, event) => handlers.filter((h) => h.type === 'session/event').forEach((h) => h.fn(session, event))
  return ctx
}

function makeSession(id = 's1', title = '重构登录') {
  const appended = []
  return {
    id,
    header: { title },
    title,
    append(type, data, opts) {
      appended.push({ type, data, opts })
      return { seq: 100 + appended.length }
    },
    appended,
  }
}

test('turn/end 追加带标题与回复摘要的系统消息，并写入投影', async () => {
  const ctx = makeCtx()
  apply(ctx, { reasons: ['completed'] })
  const session = makeSession()

  ctx.fire(session, { type: 'turn/start', time: 1000, data: { turn: 1 } })
  ctx.fire(session, {
    type: 'assistant/message',
    time: 1500,
    // 真实事件形状：正文在 message.content
    data: { turn: 1, message: { content: [{ type: 'text', text: '已完成重构，测试通过。' }] } },
  })
  ctx.fire(session, { type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: 'completed' } } })

  // 通知在微任务里追加
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(session.appended.length, 1)
  const msg = session.appended[0].data
  assert.match(msg.content[0].text, /会话「重构登录」已完成/)
  assert.match(msg.content[0].text, /测试通过/)
  assert.equal(msg.source.reasonKind, 'completed')
  assert.equal(msg.source.turn, 1)
  assert.equal(msg.source.endedAt, 2000)

  const reg = ctx.__registry
  assert.ok(reg.registered, '投影单元已注册')
  // 模拟宿主把追加事件喂给投影
  reg.emit({
    type: 'user/message',
    seq: 42,
    time: 2000,
    data: msg,
  })
  assert.equal(reg.state.text, msg.content[0].text)
  assert.equal(reg.state.turn, 1)
  assert.equal(reg.state.endedAt, 2000)
  assert.equal(reg.state.seq, 42)
})

test('热加载错过 turn/start 时，仍能从 assistant/message 补建摘要', async () => {
  const ctx = makeCtx()
  apply(ctx, { reasons: ['completed'] })
  const session = makeSession('s3', '热加载会话')
  // 故意不发 turn/start，模拟插件在轮次中途被 HMR 重新加载
  ctx.fire(session, {
    type: 'assistant/message',
    time: 1500,
    data: { turn: 2, message: { content: [{ type: 'text', text: '热加载后仍然拿到了摘要。' }] } },
  })
  ctx.fire(session, { type: 'turn/end', time: 2000, data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 0))
  assert.match(session.appended[0].data.content[0].text, /热加载后仍然拿到了摘要/)
})

test('观察者事件缺正文时，从 turnOutline 投影取摘要', async () => {
  const ctx = makeCtx()
  apply(ctx, { reasons: ['completed'] })
  // apply 之后注入的 registry 才是插件持有的那一个：给它补 turnOutline 快照
  ctx.__registry.snapshot = () => ({
    values: { turnOutline: { turns: [{ turn: 5, prompt: 'x', response: '投影里的最终回复摘要' }] } },
  })
  const session = makeSession('s4', '投影摘要')
  ctx.fire(session, { type: 'turn/start', time: 1000, data: { turn: 5 } })
  // 事件里没有 message 载荷
  ctx.fire(session, { type: 'turn/end', time: 2000, data: { turn: 5, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 0))
  assert.match(session.appended[0].data.content[0].text, /投影里的最终回复摘要/)
})

test('error 轮次带错误详情，且不再追加 completed 文案', async () => {
  const ctx = makeCtx()
  apply(ctx, { reasons: ['completed', 'error'] })
  const session = makeSession('s2', '连接问题')
  ctx.fire(session, { type: 'turn/start', time: 1000, data: { turn: 3 } })
  ctx.fire(session, {
    type: 'turn/end',
    time: 3000,
    data: { turn: 3, reason: { kind: 'error', error: { message: 'Connection error.' } } },
  })
  await new Promise((r) => setTimeout(r, 0))
  const text = session.appended[0].data.content[0].text
  assert.match(text, /会话「连接问题」出错/)
  assert.match(text, /Connection error/)
})
