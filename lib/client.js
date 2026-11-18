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
      var primed = false
      var permissionRequested = false

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
            notify(pv.title || '任务已完成', pv.text)
            return
          }
          if (Date.now() - started > WAIT_MS) {
            // 超时也不拿旧正文：用通用文案，避免「通知内容与实际任务不对应」
            var name = cur.displayTitle || cur.title || ''
            var body = name ? ('会话「' + name + '」已结束，详情见会话内系统消息。') : '会话已结束，详情见会话内系统消息。'
            notify('任务已结束', body)
            return
          }
          var t = setTimeout(attempt, RETRY_MS)
          timers.set(id, t)
        }

        attempt()
      }

      function notify(title, body) {
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
              try { n.onclick = function () { window.focus(); n.close() } } catch (e) { /* noop */ }
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
        if (!shown) showToast(title, body)
      }

      function showToast(title, body) {
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
