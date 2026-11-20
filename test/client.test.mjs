import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 构造最小浏览器环境：ModuleLoader / Notification / document / rAF。 */
function makeEnv() {
  const notifications = []
  const toasts = []
  let loaded = bundleDef

  class FakeNotification {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, opts) {
      this.title = title
      this.opts = opts
      notifications.push(this)
    }
    close() {}
  }

  const element = () => {
    const el = {
      style: { cssText: '' },
      children: [],
      textContent: '',
      setAttribute() {},
      appendChild(child) { this.children.push(child); return child },
      addEventListener(type, fn) { this.__listeners = this.__listeners || {}; this.__listeners[type] = fn },
      remove() { this.removed = true },
    }
    return el
  }

  const winListeners = {}
  const docListeners = {}
  const storage = {
    data: {},
    getItem(k) { return this.data[k] ?? null },
    setItem(k, v) { this.data[k] = String(v) },
  }

  const document = {
    body: {
      children: [],
      appendChild(el) { this.children.push(el); toasts.push(el) },
    },
    querySelector() { return null },
    createElement() { return element() },
    addEventListener(type, fn) { docListeners[type] = fn },
    removeEventListener(type) { delete docListeners[type] },
  }

  globalThis.window = {
    focus() {},
    localStorage: storage,
    addEventListener(type, fn) { winListeners[type] = fn },
    removeEventListener(type) { delete winListeners[type] },
    __ModuleLoader__: { load(def) { loaded = def; bundleDef = def } },
  }
  globalThis.document = document
  globalThis.Notification = FakeNotification
  globalThis.requestAnimationFrame = (fn) => fn()

  return {
    notifications,
    toasts,
    winListeners,
    docListeners,
    load: async () => {
      await import('../lib/client.js')
      assert.ok(bundleDef, 'client bundle 已注册')
      loaded = bundleDef
      return loaded.factory(() => { throw new Error('no require') })
    },
  }
}

function makeCtx(byId) {
  const listeners = []
  const opened = []
  return {
    opened,
    sessions: {
      open(id) { opened.push(id) },
      list: {
        getSnapshot: () => ({ byId }),
        subscribe(fn) { listeners.push(fn); return () => {} },
      },
    },
    effect(fn) { this.__dispose = fn() },
    fire() { listeners.forEach((fn) => fn()) },
    dispose() { if (this.__dispose) this.__dispose() },
  }
}

const KEY = 'dsh-turn-notify'
let bundleDef = null

test('旧投影不会触发推送，新投影才推送（内容对应本轮）', async () => {
  const env = makeEnv()
  const mod = await env.load()
  const byId = {
    s1: {
      running: true,
      displayTitle: '排查通知',
      projectionValues: { [KEY]: { seq: 5, endedAt: 1000, text: '会话「旧任务」已完成。', title: '任务已完成' } },
    },
  }
  const ctx = makeCtx(byId)
  mod.apply(ctx) // 首帧：running=true，记录基线

  // 本轮结束，但投影仍是上一轮的
  byId.s1.running = false
  ctx.fire()
  await new Promise((r) => setTimeout(r, 350))
  assert.equal(env.notifications.length, 0, '旧投影不得推送')

  // 新投影到达（endedAt 晚于本轮开始）
  byId.s1.projectionValues[KEY] = {
    seq: 9,
    endedAt: Date.now(),
    text: '会话「排查通知」已完成：修好了。',
    title: '任务已完成',
  }
  ctx.fire()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(env.notifications.length, 1)
  assert.match(env.notifications[0].opts.body, /修好了/)
  assert.equal(env.toasts.length, 0, '系统通知成功时不叠页内 toast')

  // 点击通知 → 跳到对应会话
  env.notifications[0].onclick()
  assert.deepEqual(ctx.opened, ['s1'], '点击通知调用 sessions.open(会话 id)')
  ctx.dispose()
})

test('点击通知拿不到 onclick 时，窗口 focus 兜底跳转；页面内点击则取消', async () => {
  // 情况 A：通知后窗口获得焦点（Electron 点击通知的典型行为）→ 跳转
  const envA = makeEnv()
  const modA = await envA.load()
  const byIdA = {
    s3: { running: true, displayTitle: 'A', projectionValues: { [KEY]: { seq: 1, endedAt: 1, text: '', title: '' } } },
  }
  const ctxA = makeCtx(byIdA)
  modA.apply(ctxA)
  byIdA.s3.running = false
  byIdA.s3.projectionValues[KEY] = { seq: 2, endedAt: Date.now(), text: '会话「A」已完成。', title: '任务已完成' }
  ctxA.fire()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(envA.notifications.length, 1)
  envA.winListeners.focus()
  assert.deepEqual(ctxA.opened, ['s3'], 'focus 兜底打开会话')
  ctxA.dispose()

  // 情况 B：用户先在页面里点了一下（mousedown）→ 说明是手动切窗口，不跳转
  const envB = makeEnv()
  const modB = await envB.load()
  const byIdB = {
    s4: { running: true, displayTitle: 'B', projectionValues: { [KEY]: { seq: 1, endedAt: 1, text: '', title: '' } } },
  }
  const ctxB = makeCtx(byIdB)
  modB.apply(ctxB)
  byIdB.s4.running = false
  byIdB.s4.projectionValues[KEY] = { seq: 2, endedAt: Date.now(), text: '会话「B」已完成。', title: '任务已完成' }
  ctxB.fire()
  await new Promise((r) => setTimeout(r, 400))
  envB.docListeners.mousedown({})
  envB.winListeners.focus()
  assert.deepEqual(ctxB.opened, [], '页面内手动点击后不自动跳转')
  ctxB.dispose()
})

test('子代理会话完成不推送（避免「任务已结束」噪音）', async () => {
  const env = makeEnv()
  const mod = await env.load()
  const byId = {
    sub1: {
      running: true,
      origin: 'subagent',
      displayTitle: '角色：执行者 (worker)，任务',
      projectionValues: {},
    },
  }
  const ctx = makeCtx(byId)
  mod.apply(ctx)
  byId.sub1.running = false
  ctx.fire()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(env.notifications.length, 0)
  assert.equal(env.toasts.length, 0)
  ctx.dispose()
})

test('系统通知不可用时才用页内 toast 兜底', async () => {
  const env = makeEnv()
  globalThis.Notification.permission = 'denied'
  const mod = await env.load()
  const byId = {
    s2: {
      running: true,
      displayTitle: '降级会话',
      projectionValues: { [KEY]: { seq: 1, endedAt: 1, text: '', title: '' } },
    },
  }
  const ctx = makeCtx(byId)
  mod.apply(ctx)
  byId.s2.running = false
  byId.s2.projectionValues[KEY] = { seq: 2, endedAt: Date.now(), text: '会话「降级会话」已完成。', title: '任务已完成' }
  ctx.fire()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(env.notifications.length, 0)
  assert.equal(env.toasts.length, 1, 'toast 兜底出现')
  const toastRoot = env.toasts[0]
  assert.equal(toastRoot.style.cssText.includes('pointer-events:none'), true, 'toast 容器不拦截鼠标')
  const card = toastRoot.children[0]
  assert.match(card.style.cssText, /pointer-events:none/, 'toast 卡片不拦截鼠标，避免挡住审批按钮')
  const viewBtn = card.children.find((c) => c.textContent === '查看')
  assert.ok(viewBtn, '兜底 toast 带「查看」入口')
  viewBtn.__listeners.click({ stopPropagation() {} })
  assert.deepEqual(ctx.opened, ['s2'], '点「查看」跳到对应会话')
  ctx.dispose()
})
