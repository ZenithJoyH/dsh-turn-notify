/**
 * dsh-turn-notify — host plane.
 *
 * 每次 turn/end 生成一条带「轮次身份」的完成通知：
 *   - 写入会话日志（系统提示行，可折叠）；
 *   - 写入会话投影 { seq, turn, kind, title, text, endedAt }。
 *
 * 客户端只在投影 seq 严格大于「本轮开始前的基线 seq」时才推送，
 * 从根上避免读到上一轮的旧通知正文（现有插件 readNoticeAny 会立即接受旧投影）。
 *
 * 零裸 import：只用 node: 内置模块 + 宿主注入的 zod。
 */
import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

export const name = 'turn-notify'

const PLUGIN_ID = 'dsh-turn-notify'
const PROJECTION_KEY = 'dsh-turn-notify'
/** 审批中投影：客户端据此弹「需要权限审批」并带工具名/原因。 */
const APPROVAL_PROJECTION_KEY = 'dsh-turn-notify-approval'

const DEFAULT_OPTIONS = {
  reasons: ['completed', 'aborted', 'blocked', 'error', 'max-tokens'],
  skipSubagents: true,
}

const HUB_REQUIRE = createRequire(join(homedir(), '.dsh', 'profiles', 'node_modules', '__turn_notify_anchor__.js'))

/** 测试注入 schema 提供者；生产环境走宿主同源的 zod。 */
let schemaProvider = null
export function __setSchemaProvider(provider) {
  schemaProvider = provider
}

function schemaOf() {
  if (schemaProvider) return schemaProvider
  return HUB_REQUIRE('zod')
}

const TITLES = {
  completed: '任务已完成',
  error: '任务出错',
  aborted: '任务已中止',
  blocked: '任务被阻塞',
  'max-tokens': '任务达到上限',
}

const LABELS = {
  completed: '已完成',
  error: '出错',
  aborted: '已中止',
  blocked: '被阻塞',
  'max-tokens': '达到上限',
}

function warn(ctx, message) {
  try {
    const logger = ctx.logger
    if (logger && typeof logger.warn === 'function') logger.warn(`[${PLUGIN_ID}] ${message}`)
    else console.warn(`[${PLUGIN_ID}] ${message}`)
  } catch { /* best effort */ }
}

/** 调试日志（尽力而为，超过 512KB 清空）。 */
function fileLog(line) {
  try {
    const file = join(homedir(), '.dsh', 'turn-notify.log')
    try {
      if (statSync(file).size > 512 * 1024) truncateSync(file, 0)
    } catch { /* not exists */ }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* best effort */ }
}

/** 子代理会话判定（与宿主 header 契约对齐，尽量宽松）。 */
function isSubagentSession(session) {
  const h = session?.header ?? {}
  if (h.origin === 'subagent') return true
  if (typeof h.delegationDepth === 'number' && h.delegationDepth > 0) return true
  return false
}

/** 从会话自身/投影取标题，作为通知正文里的会话名。 */
function titleOf(session, projRegistry) {
  try {
    const snap = projRegistry?.snapshot?.(session)
    const t = snap?.values?.title
    if (typeof t === 'string' && t.trim()) return t.trim()
  } catch { /* fall through */ }
  const h = session?.header ?? {}
  if (typeof h.title === 'string' && h.title.trim()) return h.title.trim()
  if (typeof session?.title === 'string' && session.title.trim()) return session.title.trim()
  return ''
}

/** 组装标题 + 正文：只保留「哪个会话 + 结果」，不放大段回复/错误详情。 */
function buildNotice(kind, titleValue) {
  const title = TITLES[kind] ?? '任务已完成'
  const who = titleValue ? `会话「${titleValue}」` : '会话'
  const label = LABELS[kind] ?? '已结束'
  const text = `${who}${label}。`
  return { title, text, summary: text }
}

/** 投影定义：新老宿主字段并存。 */
function projectionDef(spec) {
  const view = (state) => state
  return {
    key: spec.key,
    schema: spec.schema,
    view,
    stateSchema: spec.schema,
    wire: { viewSchema: spec.schema, view },
    init: spec.init,
    apply: spec.apply,
    stateVersion: spec.stateVersion,
  }
}

/** 追加系统消息；返回 append 结果（失败返回 null）。 */
function appendNotice(ctx, session, notice, kind, turn, endedAt) {
  try {
    return session.append(
      'user/message',
      {
        id: globalThis.crypto?.randomUUID?.() ?? `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        role: 'user',
        content: [{ type: 'text', text: notice.text }],
        source: {
          kind: `plugin:${PLUGIN_ID}`,
          plugin: PLUGIN_ID,
          form: 'notice',
          summary: notice.summary,
          reasonKind: kind,
          titleText: notice.title,
          turn: typeof turn === 'number' ? turn : 0,
          endedAt: typeof endedAt === 'number' ? endedAt : 0,
        },
      },
      { surfaceOp: 'append' },
    )
  } catch (err) {
    warn(ctx, `追加系统消息失败: ${err?.message ?? String(err)}`)
    fileLog(`append failed ${session?.id}: ${err?.stack ?? err}`)
    return null
  }
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULT_OPTIONS, ...config }
  const reasons = new Set(Array.isArray(options.reasons) ? options.reasons : DEFAULT_OPTIONS.reasons)
  const turns = new Map() // `${sessionId}:${turn}` -> { startedAt, excerpt }
  let projRegistry = null
  let disposed = false

  // ---- 投影注册：客户端靠它拿「本轮」通知正文 ----
  try {
    const z = schemaOf()
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionProjections'], (scoped) => {
        const registry = (typeof ctx.root?.get === 'function' && ctx.root.get('sessionProjections')) || scoped.sessionProjections
        if (!registry || typeof registry.register !== 'function') return
        projRegistry = registry
        try {
          registry.register(projectionDef({
            key: PROJECTION_KEY,
            schema: z.object({
              kind: z.string(),
              title: z.string(),
              text: z.string(),
              turn: z.number(),
              endedAt: z.number(),
              seq: z.number(),
            }),
            init: () => ({ kind: '', title: '', text: '', turn: 0, endedAt: 0, seq: 0 }),
            apply: (state, event) => {
              if (event?.type !== 'user/message') return state
              const src = event.data?.source ?? {}
              if (src.kind !== `plugin:${PLUGIN_ID}`) return state
              const text = ((event.data?.content ?? []).map((b) => b?.text ?? '')).join('').trim()
              if (!text) return state
              return {
                kind: typeof src.reasonKind === 'string' ? src.reasonKind : state.kind,
                title: typeof src.titleText === 'string' ? src.titleText : state.title,
                text,
                turn: typeof src.turn === 'number' ? src.turn : state.turn,
                endedAt: typeof src.endedAt === 'number' ? src.endedAt : state.endedAt,
                // seq 只用于「比基线新」的判据：优先事件序号，缺失时用事件时间（同会话单调递增）
                seq: typeof event.seq === 'number' ? event.seq
                  : (typeof event.time === 'number' ? event.time : state.seq),
              }
            },
            stateVersion: 1,
          }))

          // 审批投影：approval/asked 写入、approval/decided 清空。
          // 客户端轮询会话列表的 pendingInteraction === 'approval' 时读取它。
          registry.register(projectionDef({
            key: APPROVAL_PROJECTION_KEY,
            schema: z.object({
              id: z.string(),
              toolName: z.string(),
              reason: z.string(),
              title: z.string(),
              body: z.string(),
              seq: z.number(),
            }),
            init: () => ({ id: '', toolName: '', reason: '', title: '', body: '', seq: 0 }),
            apply: (state, event) => {
              const data = event?.data ?? {}
              if (event?.type === 'approval/asked') {
                const tool = typeof data.toolName === 'string' && data.toolName ? data.toolName : '工具'
                const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
                const body = `会话请求使用 ${tool}，请前往审批。${reason ? `（原因：${reason}）` : ''}`
                return { id: String(data.id ?? ''), toolName: tool, reason, title: '需要权限审批', body, seq: typeof event.seq === 'number' ? event.seq : state.seq }
              }
              if (event?.type === 'approval/decided' && String(data.id ?? '') === state.id) {
                return { ...state, id: '', toolName: '', reason: '', title: '', body: '' }
              }
              return state
            },
            stateVersion: 1,
          }))
          fileLog('projection registered')
        } catch (err) {
          warn(ctx, `投影注册失败: ${err?.message ?? err}`)
        }
      })
    }
  } catch (err) {
    warn(ctx, `投影依赖加载失败: ${err?.message ?? err}`)
  }

  ctx.on('session/event', (session, event) => {
    if (disposed || !session || !event) return
    const turn = event.data?.turn
    const key = `${session.id}:${turn}`

    switch (event.type) {
      case 'turn/start':
        turns.set(key, { startedAt: event.time })
        return
      case 'turn/end': {
        const kind = event.data?.reason?.kind
        if (!reasons.has(kind)) return
        if (options.skipSubagents !== false && isSubagentSession(session)) return
        turns.delete(key)
        const titleValue = titleOf(session, projRegistry)
        const notice = buildNotice(kind, titleValue)
        queueMicrotask(() => {
          if (disposed) return
          appendNotice(ctx, session, notice, kind, turn, event.time)
        })
        return
      }
      default:
        return
    }
  })

  try {
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        disposed = true
        turns.clear()
        fileLog('plugin unloaded')
      })
    }
  } catch { /* ignore */ }
}
