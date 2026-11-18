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
      addEventListener() {},
      remove() { this.removed = true },
    }
    return el
  }

  const document = {
    body: {
      children: [],
      appendChild(el) { this.children.push(el); toasts.push(el) },
    },
    querySelector() { return null },
    createElement() { return element() },
  }

  globalThis.window = {
    focus() {},
    __ModuleLoader__: { load(def) { loaded = def; bundleDef = def } },
  }
  globalThis.document = document
  globalThis.Notification = FakeNotification
  globalThis.requestAnimationFrame = (fn) => fn()

  return {
    notifications,
    toasts,
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
  return {
    sessions: {
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
  const toast = env.toasts[0]
  assert.match(toast.style.cssText, /pointer-events:none/, 'toast 不拦截鼠标，避免挡住审批按钮')
  ctx.dispose()
})
