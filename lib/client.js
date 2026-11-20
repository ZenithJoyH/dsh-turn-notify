/* dsh-turn-notify — client plane.
 *
 * 监听会话列表的 running:true -> false 边沿，读取宿主投影 `dsh-turn-notify`。
 * 关键修复：投影带 seq，客户端只有在「本轮开始前记录的基线 seq」严格变大时才推送，
 * 否则继续等（最多 8 秒），超时用通用文案兜底——绝不把上一轮的旧正文当成这一轮。
 *
 * 推送策略：系统通知成功弹出就不再叠页内 toast；toast 仅作兜底且不拦截鼠标。
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    exports.name = 'turn-notify-client'
    exports.inject = ['sessions']

    var TAG = 'dsh-turn-notify'
    var KEY = 'dsh-turn-notify'
    var WAIT_MS = 8000
    var RETRY_MS = 300
    var TOAST_TTL_MS = 10000
    var TOAST_MAX = 3

    function log(msg) {
      try { console.log('[' + TAG + '-client] ' + msg) } catch (e) { /* noop */ }
    }

    exports.apply = function apply(ctx) {
      var list = ctx.sessions.list
      var prevRunning = new Map()   // sessionId -> last observed running
      var baselineSeq = new Map()   // sessionId -> projection seq before current run
      var runStartAt = new Map()    // sessionId -> wall clock when running became true
      var timers = new Map()        // sessionId -> pending retry timer
      var pushedApprovals = new Map() // sessionId -> 是否已为该次审批提醒过
      var pushedQuestions = new Map() // sessionId -> 是否已为该次提问提醒过
      var primed = false
      var permissionRequested = false
      var pendingOpen = null // 刚弹出通知的会话：点击系统通知若拿不到 onclick，靠窗口 focus 兜底跳转
      var debugEvents = []

      /** 记录最近的通知/点击/聚焦事件（写 localStorage，便于排查点击是否真的到达渲染进程）。 */
      function debugEvent(name, id) {
        try {
          debugEvents.push({ t: Date.now(), event: name, id: id || '' })
          if (debugEvents.length > 20) debugEvents.shift()
          window.localStorage.setItem('dsh-turn-notify.debug', JSON.stringify(debugEvents))
        } catch (e) { /* 隐私模式等，忽略 */ }
      }

      function projectionOf(s) {
        try {
          var pv = s && s.projectionValues && s.projectionValues[KEY]
          return pv && typeof pv === 'object' ? pv : null
        } catch (e) { return null }
      }

      function snapshotOf(id) {
        try {
          var snap = list.getSnapshot()
          return snap && snap.byId ? snap.byId[id] : null
        } catch (e) { return null }
      }

      function onSnapshot() {
        var snap = list.getSnapshot()
        if (!snap || !snap.byId) return
        var ids = Object.keys(snap.byId)
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i]
          var s = snap.byId[id]
          if (!s || typeof s.running !== 'boolean') continue
          // 子代理会话不提醒：宿主侧 skipSubagents 已不写投影，客户端若还等投影就会
          // 8 秒后走「任务已结束」兜底 → 每个子代理轮次弹一条噪音通知。
          if (s.origin === 'subagent') continue
          // 审批/提问不依赖 running 边沿（等待期间 running 仍是 true），每帧都检查。
          checkApproval(id, s)
          checkQuestion(id, s)
          var was = prevRunning.get(id)
          prevRunning.set(id, s.running)
          if (s.running) {
            // 本轮开始：记录投影基线与墙钟时间。旧投影 seq <= 基线、endedAt < runStart，
            // 两个条件都不满足，永远不会被当成这一轮的通知。
            var pv = projectionOf(s)
            baselineSeq.set(id, pv && typeof pv.seq === 'number' ? pv.seq : 0)
            runStartAt.set(id, Date.now())
            continue
          }
          if (!primed) continue
          if (was === true) pushCompletion(id, s)
        }
        primed = true
      }

      /** 审批提醒：以会话的 pendingInteraction === 'approval' 为准，正文取宿主审批投影。 */
      function checkApproval(id, s) {
        var pv = null
        try { pv = s.projectionValues && s.projectionValues['dsh-turn-notify-approval'] } catch (e) { /* noop */ }
        var pending = s.pendingInteraction === 'approval'
        var hasProjection = !!(pv && pv.id)
        if (!pending && !hasProjection) { pushedApprovals.delete(id); return }
        if (pushedApprovals.has(id)) return
        pushedApprovals.set(id, true)
        var title = '需要权限审批'
        var name = s.displayTitle || s.title || ''
        var tool = pv && pv.toolName ? pv.toolName : ''
        var body = name
          ? ('会话「' + name + '」需要审批' + (tool ? '（工具：' + tool + '）' : '') + '，请前往处理。')
          : ((pv && pv.body) || '会话需要权限审批，请前往处理。')
        notify(title, body, id)
      }

      /** 提问提醒：pendingInteraction === 'question' / 'plan-review' 时提醒一次。 */
      function checkQuestion(id, s) {
        var pending = s.pendingInteraction === 'question' || s.pendingInteraction === 'plan-review'
        if (!pending) { pushedQuestions.delete(id); return }
        if (pushedQuestions.has(id)) return
        pushedQuestions.set(id, true)
        var qname = s.displayTitle || s.title || ''
        var qbody = qname ? ('会话「' + qname + '」正在等待你的回答，请前往处理。') : '会话正在等待你的回答，请前往处理。'
        notify('AI 正在向你提问', qbody, id)
      }

      function clearTimer(id) {
        var t = timers.get(id)
        if (t) { clearTimeout(t); timers.delete(id) }
      }

      function pushCompletion(id, s) {
        var base = baselineSeq.get(id) || 0
        var runStart = runStartAt.get(id) || 0
        var started = Date.now()
        clearTimer(id)

        function attempt() {
          var cur = snapshotOf(id) || s
          var pv = projectionOf(cur)
          // 只接受「这一轮」的投影：
          //   - endedAt 不早于本轮开始的墙钟（-1.5s 容忍时钟抖动）；
          //   - 或 seq 比本轮开始前记录的基线大（旧宿主无 endedAt 时的兜底）。
          var fresh = false
          if (pv && pv.text) {
            if (typeof pv.endedAt === 'number' && pv.endedAt > 0 && runStart > 0) {
              fresh = pv.endedAt >= runStart - 1500
            } else if (typeof pv.seq === 'number') {
              fresh = pv.seq > base
            }
          }
          if (fresh) {
            notify(pv.title || '任务已完成', pv.text, id)
            return
          }
          if (Date.now() - started > WAIT_MS) {
            // 超时也不拿旧正文。但如果这个会话从来没有过通知投影（基线 0），
            // 多半是被宿主跳过 / 未纳入通知的会话，直接静默，避免「任务已结束」噪音。
            if (base === 0) {
              log('no fresh projection, suppressed fallback: ' + id)
              return
            }
            var name = cur.displayTitle || cur.title || ''
            var body = name ? ('会话「' + name + '」已结束，详情见会话内系统消息。') : '会话已结束，详情见会话内系统消息。'
            notify('任务已结束', body, id)
            return
          }
          var t = setTimeout(attempt, RETRY_MS)
          timers.set(id, t)
        }

        attempt()
      }

      /** 点击通知后跳到对应会话：优先 ctx.sessions.open(id)（DSH 官方切会话入口），
       *  失败再退回只聚焦窗口。 */
      function openSession(id) {
        // 首选官方 workspace 服务：UiWorkspaceService.openSession() 是侧栏点击会话时
        // 真正走的那条路（会切换主视图标签）。ctx.sessions 上没有 open()，之前用到它
        // 只会得到 open-missing。
        try {
          var ws = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
          if (ws && typeof ws.openSession === 'function') {
            ws.openSession(id)
            debugEvent('open-ok', id)
            log('open session via uiWorkspace: ' + id)
            return
          }
        } catch (e) {
          debugEvent('open-failed', id)
          log('uiWorkspace.openSession failed: ' + (e && e.message ? e.message : e))
        }
        // 兼容旧宿主：部分版本在 sessions 服务上提供 open()
        try {
          if (typeof ctx.sessions.open === 'function') {
            ctx.sessions.open(id)
            debugEvent('open-ok', id)
            log('open session via sessions.open: ' + id)
            return
          }
          debugEvent('open-missing', id)
        } catch (e) {
          debugEvent('open-failed', id)
          log('open session failed: ' + (e && e.message ? e.message : e))
        }
        try { if (typeof window !== 'undefined' && window.focus) window.focus() } catch (e) { /* noop */ }
      }

      function markPending(id) {
        if (!id) return
        pendingOpen = { id: id, at: Date.now() }
      }

      function notify(title, body, id) {
        var shown = false
        try {
          if (typeof Notification !== 'undefined') {
            if (Notification.permission === 'granted') {
              var n = new Notification(title, {
                body: body,
                tag: TAG + ':' + Date.now(),
                silent: false,
              })
              shown = true
              markPending(id)
              debugEvent('notification', id)
              try {
                n.onclick = function () {
                  debugEvent('click', id)
                  pendingOpen = null
                  openSession(id)
                  try { if (typeof window !== 'undefined' && window.focus) window.focus() } catch (e) { /* noop */ }
                  n.close()
                }
              } catch (e) { /* noop */ }
              log('notification shown: ' + title)
            } else if (Notification.permission === 'default' && !permissionRequested) {
              permissionRequested = true
              log('requesting notification permission')
              var req = Notification.requestPermission()
              if (req && typeof req.then === 'function') {
                req.catch(function () { /* ignore */ })
              }
            }
          }
        } catch (e) { /* unsupported -> toast */ }
        if (!shown) showToast(title, body, id)
      }

      function showToast(title, body, id) {
        if (typeof document === 'undefined') return
        try {
          var root = document.querySelector('[data-dsh-turn-notify-root]')
          if (!root) {
            root = document.createElement('div')
            root.setAttribute('data-dsh-turn-notify-root', '')
            root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:system-ui,sans-serif'
            document.body.appendChild(root)
          }
          var el = document.createElement('div')
          el.style.cssText = 'position:relative;pointer-events:none;background:rgba(28,30,38,0.96);color:#f5f6f8;padding:10px 26px 10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);max-width:340px;min-width:220px;opacity:0;transform:translateY(8px);transition:opacity 0.2s,transform 0.2s'
          var t1 = document.createElement('div')
          t1.textContent = title
          t1.style.cssText = 'font-size:13px;font-weight:600;line-height:1.5'
          var t2 = document.createElement('div')
          t2.textContent = body
          t2.style.cssText = 'font-size:12px;line-height:1.5;opacity:0.8;margin-top:2px'
          el.appendChild(t1)
          el.appendChild(t2)
          var close = function () { el.remove() }
          // 兜底通道也给一个「查看」入口：toast 本体不接收鼠标（避免遮挡审批按钮），
          // 只有这个小按钮可点。
          if (id) {
            var open = document.createElement('button')
            open.textContent = '查看'
            open.style.cssText = 'pointer-events:auto;position:absolute;right:22px;top:6px;border:0;background:transparent;color:#9db4ff;opacity:0.9;font-size:12px;line-height:1.4;cursor:pointer;padding:2px 4px'
            open.addEventListener('click', function (ev) {
              ev.stopPropagation()
              openSession(id)
              close()
            })
            el.appendChild(open)
          }
          var x = document.createElement('button')
          x.textContent = '×'
          x.setAttribute('aria-label', 'close')
          x.style.cssText = 'pointer-events:auto;position:absolute;top:4px;right:6px;border:0;background:transparent;color:#f5f6f8;opacity:0.55;font-size:14px;line-height:1;cursor:pointer;padding:2px 4px'
          x.addEventListener('click', function (ev) { ev.stopPropagation(); close() })
          el.appendChild(x)
          while (root.children.length >= TOAST_MAX) root.firstChild.remove()
          root.appendChild(el)
          requestAnimationFrame(function () {
            el.style.opacity = '1'
            el.style.transform = 'translateY(0)'
          })
          setTimeout(close, TOAST_TTL_MS)
        } catch (e) { /* no DOM */ }
      }

      function cleanup() {
        try { dispose() } catch (e) { /* noop */ }
        try {
          if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('focus', onWindowFocus)
          if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('mousedown', onPagePointerDown, true)
        } catch (e) { /* noop */ }
        timers.forEach(function (t) { clearTimeout(t) })
        timers.clear()
        try {
          if (typeof document !== 'undefined') {
            var root = document.querySelector('[data-dsh-turn-notify-root]')
            if (root) root.remove()
          }
        } catch (e) { /* noop */ }
        log('unloaded')
      }

      // macOS/Electron 里点系统通知通常只会把窗口带到前台，Web Notification 的 onclick
      // 不一定回传渲染进程。这里在窗口重新获得焦点时兜底：若 20 秒内刚发过通知，
      // 且用户没有在页面里手动点击（mousedown 会清掉 pending），就跳到该会话。
      function onWindowFocus() {
        debugEvent('focus', pendingOpen && pendingOpen.id)
        if (!pendingOpen) return
        if (Date.now() - pendingOpen.at > 20000) { pendingOpen = null; return }
        var id = pendingOpen.id
        pendingOpen = null
        openSession(id)
      }
      function onPagePointerDown() {
        if (!pendingOpen) return
        debugEvent('mousedown-clear', pendingOpen.id)
        pendingOpen = null
      }
      try {
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', onWindowFocus)
        if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('mousedown', onPagePointerDown, true)
      } catch (e) { /* noop */ }

      var dispose = list.subscribe(onSnapshot)
      onSnapshot()

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () { return cleanup })
      } else if (typeof ctx.onDispose === 'function') {
        ctx.onDispose(cleanup)
      }
    }

    return module.exports
  },
})
