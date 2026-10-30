/**
 * dsh-daily-schedule —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无需构建）。
 * 设置 → 每日日程：今天 / 明天的时间线（可重新生成、手动编辑、按衣柜搭配穿着）、日程类型、设置、往期。
 * 服饰 / 场景 / 道具的缩略图走生图工作室的接口（/api/image-studio/file），没装那个插件就只显示图标。
 * 与宿主只走同源 fetch（/api/daily-schedule/*）。修改后用 `node --check lib/client.js` 验证语法。
 */

window.__ModuleLoader__.load({
  id: 'dsh-daily-schedule',
  factory: function (require) {
    var module = { exports: {} }
    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    var API = '/api/daily-schedule'
    var NS = 'dsh-daily-schedule'
    var SCOPE_LABEL = { weekday: '工作日', weekend: '周末', any: '每天' }

    function cx() {
      var out = []
      for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i])
      return out.join(' ')
    }
    function readJson(res) {
      return res.text().then(function (t) {
        var d = null
        try { d = t === '' ? null : JSON.parse(t) } catch (e) { d = null }
        if (!res.ok) throw new Error(d && d.error ? d.error : 'HTTP ' + res.status)
        return d
      })
    }
    function apiGet(p) { return fetch(API + p, { cache: 'no-store' }).then(readJson) }
    function apiPost(p, body) {
      return fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(readJson)
    }
    function errText(e) { return e && e.message ? e.message : String(e) }
    function clone(v) { return JSON.parse(JSON.stringify(v)) }
    function toMin(s) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
      return m ? Number(m[1]) * 60 + Number(m[2]) : null
    }

    function pollJob(id, onUpdate) {
      var stopped = false
      var p = new Promise(function (resolve, reject) {
        var tick = function () {
          if (stopped) return
          apiGet('/job?id=' + encodeURIComponent(id)).then(function (j) {
            if (stopped) return
            if (onUpdate) onUpdate(j)
            if (j.status === 'running') setTimeout(tick, 1500)
            else if (j.status === 'done') resolve(j)
            else reject(new Error(j.error || '生成失败'))
          }, function (e) { if (!stopped) reject(e) })
        }
        setTimeout(tick, 1000)
      })
      p.stop = function () { stopped = true }
      return p
    }

    // ---- 生图工作室的缩略图 ---------------------------------------------------------
    // 桌面端页面从 file:// 加载，<img src> 指向宿主接口会被拦：先 fetch 成 blob，失败再要 base64。
    var STUDIO = '/api/image-studio'
    var imgCache = new Map()
    function loadImage(src) {
      if (imgCache.has(src)) return imgCache.get(src)
      var p = fetch(src, { cache: 'force-cache' }).then(function (res) {
        var type = res.headers.get('content-type') || ''
        if (!res.ok || type.indexOf('image/') !== 0) throw new Error('not image')
        return res.blob()
      }).then(function (blob) {
        return URL.createObjectURL(blob)
      }).catch(function () {
        return fetch(src + (src.indexOf('?') >= 0 ? '&' : '?') + 'b64=1', { cache: 'no-store' }).then(readJson).then(function (j) {
          return 'data:' + j.mime + ';base64,' + j.b64
        })
      })
      p.catch(function () { imgCache.delete(src) })
      imgCache.set(src, p)
      if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value)
      return p
    }
    function useImageUrl(src) {
      var [st, setSt] = useState({ src: '', url: '' })
      useEffect(function () {
        if (!src) return undefined
        var alive = true
        loadImage(src).then(function (url) { if (alive) setSt({ src: src, url: url }) }, function () { if (alive) setSt({ src: src, url: '' }) })
        return function () { alive = false }
      }, [src])
      return st.src === src ? st.url : ''
    }
    function coverSrc(category, e) {
      if (!e || !e.cover) return ''
      return STUDIO + '/file?c=' + category + '&id=' + encodeURIComponent(e.id) + '&f=' + encodeURIComponent(e.cover) + (e.mtime ? '&v=' + Math.round(e.mtime) : '')
    }
    function byName(list, name) {
      if (!name || !Array.isArray(list)) return null
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i]
      return null
    }
    function Thumb(props) {
      var url = useImageUrl(props.src || '')
      if (url) return h('img', { className: cx('ds-thumb', props.className), src: url, alt: '', draggable: false, title: props.title })
      return h('span', { className: cx('ds-thumb', props.className), title: props.title }, h(Icon, { name: props.icon || 'shirt', size: props.iconSize || 12 }))
    }
    function hasOutfits(day) {
      return !!(day && Array.isArray(day.items) && day.items.some(function (it) { return it.outfit || it.outfitNote }))
    }
    /** 连续穿同一身的时段合并成一段。 */
    function outfitRuns(items) {
      var out = []
      ;(items || []).forEach(function (it) {
        if (!it.outfit && !it.outfitNote) return
        var key = (it.outfit || '') + '|' + (it.outfitNote || '')
        var last = out[out.length - 1]
        if (last && last.key === key) { last.end = it.end; return }
        out.push({ key: key, start: it.start, end: it.end, outfit: it.outfit || '', note: it.outfitNote || '' })
      })
      return out
    }
    /** 设置里「自动」时日程的她会认成人物库里的谁（和宿主 herEntry 同一套规则）。 */
    function autoHer(w, name) {
      var list = (w && w.characters) || []
      var key = String(name || '').trim().toLowerCase()
      if (key) {
        for (var i = 0; i < list.length; i++) {
          var names = [list[i].name].concat(list[i].aliases || []).map(function (n) { return String(n).toLowerCase() })
          if (names.indexOf(key) >= 0) return list[i]
        }
        if (key.length >= 2) {
          var loose = list.filter(function (e) { return [e.name].concat(e.aliases || []).some(function (n) { n = String(n).toLowerCase(); return n.length >= 2 && (n.indexOf(key) >= 0 || key.indexOf(n) >= 0) }) })
          if (loose.length === 1) return loose[0]
        }
      }
      return list.length === 1 ? list[0] : null
    }

    function Icon(props) {
      var paths = ICONS[props.name] || []
      return h('svg', { width: props.size || 15, height: props.size || 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'ds-icon', 'aria-hidden': true },
        paths.map(function (d, i) { return h('path', { key: i, d: d }) }))
    }
    var ICONS = {
      calendar: ['M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z', 'M4 10h16', 'M8.5 3v4', 'M15.5 3v4'],
      refresh: ['M20 11a8 8 0 0 0-14.3-4.9L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.3 4.9L20 16', 'M20 20v-4h-4'],
      edit: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16z', 'M13.5 6.5l4 4'],
      plus: ['M12 5v14', 'M5 12h14'],
      trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
      sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
      gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
      layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
      history: ['M4 12a8 8 0 1 0 2.3-5.6L4 8.7', 'M4 4v4.7h4.7', 'M12 8v4l3 2'],
      check: ['M5 12.5l4.5 4.5L19 7.5'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      pin: ['M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 5.7-6 11-6 11z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
      back: ['M15 5l-7 7 7 7'],
      shirt: ['M8.5 4L4 6.5l1.8 3.7L8 9.2V20h8V9.2l2.2 1L20 6.5 15.5 4c-.6 1.4-1.9 2.2-3.5 2.2S9.1 5.4 8.5 4z'],
      bag: ['M5 8h14l-1 12H6z', 'M9 8V6.5a3 3 0 0 1 6 0V8'],
      users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.8c1.6.7 2.7 2.4 3 5.2'],
    }

    var MONO = 'var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)'
    var CSS = [
      '.ds-root{',
      '--ds-fg:var(--dsw-alias-label-primary,#1f1c18);--ds-muted:var(--dsw-alias-label-secondary,#6f6558);--ds-faint:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed,#8a7f6e));',
      '--ds-card:var(--dsw-alias-bg-layer-1,#fffdf8);--ds-bar:var(--dsw-alias-bg-layer-2,#f4efe4);--ds-field:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fbf7ef));',
      '--ds-line:var(--dsw-alias-border-l2,#e3daca);--ds-line-soft:var(--dsw-alias-border-l1,#ece5d8);--ds-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
      '--ds-brand:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#3b5bdb));--ds-brand-fg:var(--dsw-alias-label-primary-foreground,#fff);',
      '--ds-brand-soft:color-mix(in srgb,var(--ds-brand) 11%,transparent);--ds-ok:var(--dsw-alias-state-success-primary,#2f6b46);--ds-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);',
      '--ds-err:var(--dsw-alias-state-error-primary,#a83a2c);--ds-err-bg:color-mix(in srgb,var(--ds-err) 9%,transparent);--ds-err-line:color-mix(in srgb,var(--ds-err) 32%,transparent);',
      '--ds-shadow:0 1px 2px rgba(0,0,0,.05),0 6px 18px -8px rgba(0,0,0,.18);',
      'font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
      'color:var(--ds-fg);display:flex;flex-direction:column;gap:14px;padding:2px;box-sizing:border-box;max-width:100%;font-size:13px;}',
      '.ds-root *{box-sizing:border-box;}',
      '.ds-icon{flex:0 0 auto;display:block;}',
      '.ds-head{display:flex;align-items:center;gap:12px;}',
      '.ds-logo{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--ds-brand-soft);color:var(--ds-brand);flex:0 0 auto;}',
      '.ds-grow{flex:1 1 auto;min-width:0;}',
      '.ds-h1{font-size:15px;font-weight:650;line-height:1.35;}',
      '.ds-sub{font-size:12px;color:var(--ds-muted);margin-top:2px;line-height:1.5;}',
      '.ds-pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 10px;border-radius:999px;border:1px solid var(--ds-line-soft);background:var(--ds-bar);color:var(--ds-muted);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;}',
      '.ds-dot{width:7px;height:7px;border-radius:50%;background:var(--ds-faint);flex:0 0 auto;}',
      '.ds-dot-on{background:var(--ds-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ds-ok) 20%,transparent);}',
      '.ds-tabs{display:flex;gap:2px;padding:3px;border-radius:11px;background:var(--ds-bar);border:1px solid var(--ds-line-soft);}',
      '.ds-tab{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12.5px;padding:7px 8px;border-radius:8px;border:0;background:transparent;color:var(--ds-muted);cursor:pointer;white-space:nowrap;}',
      '.ds-tab:hover{color:var(--ds-fg);}',
      '.ds-tab-on{background:var(--ds-card);color:var(--ds-fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08);}',
      '.ds-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--ds-bar);border:1px solid var(--ds-line-soft);flex-wrap:wrap;}',
      '.ds-seg-btn{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;border:0;background:transparent;color:var(--ds-muted);cursor:pointer;}',
      '.ds-seg-btn:hover{color:var(--ds-fg);}',
      '.ds-seg-on{background:var(--ds-card);color:var(--ds-fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.07);}',
      '.ds-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:6px 11px;border-radius:8px;border:1px solid var(--ds-line);background:var(--ds-card);color:var(--ds-fg);cursor:pointer;white-space:nowrap;}',
      '.ds-btn:hover:not(:disabled){background:var(--ds-hover);}',
      '.ds-btn:disabled{opacity:.45;cursor:default;}',
      '.ds-btn-primary,.ds-btn-primary:hover:not(:disabled){background:var(--ds-brand);border-color:var(--ds-brand);color:var(--ds-brand-fg);font-weight:600;}',
      '.ds-btn-ghost{border-color:transparent;background:transparent;color:var(--ds-muted);}',
      '.ds-btn-sm{font-size:11.5px;padding:4px 8px;border-radius:7px;}',
      '.ds-btn-danger{color:var(--ds-err);}',
      '.ds-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.ds-panel{border:1px solid var(--ds-line-soft);border-radius:12px;background:var(--ds-card);padding:12px 14px;display:flex;flex-direction:column;gap:12px;}',
      '.ds-panel-title{font-size:12.5px;font-weight:650;display:flex;align-items:center;gap:7px;}',
      '.ds-note{font-size:11.5px;color:var(--ds-faint);line-height:1.6;}',
      '.ds-tag{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--ds-bar);border:1px solid var(--ds-line-soft);color:var(--ds-muted);white-space:nowrap;}',
      '.ds-tag-brand{background:var(--ds-brand-soft);border-color:transparent;color:var(--ds-brand);font-weight:600;}',
      '.ds-tag-warn{color:var(--ds-warn);}',
      '.ds-input,.ds-textarea,.ds-select{width:100%;font:inherit;font-size:12.5px;padding:7px 10px;border-radius:8px;border:1px solid var(--ds-line);background:var(--ds-field);color:var(--ds-fg);outline:none;}',
      '.ds-input:focus,.ds-textarea:focus,.ds-select:focus{border-color:var(--ds-brand);box-shadow:0 0 0 3px var(--ds-brand-soft);}',
      '.ds-textarea{resize:vertical;line-height:1.65;min-height:64px;}',
      '.ds-mono{font-family:' + MONO + ';font-size:12px;}',
      '.ds-num{width:76px;}',
      '.ds-time{width:96px;}',
      '.ds-field{display:flex;flex-direction:column;gap:5px;}',
      '.ds-label{font-size:12px;font-weight:600;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.ds-label .ds-note{font-weight:400;}',
      '.ds-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      '@media (max-width:640px){.ds-2col{grid-template-columns:1fr;}}',
      '.ds-error{color:var(--ds-err);background:var(--ds-err-bg);border:1px solid var(--ds-err-line);font-size:12.5px;border-radius:10px;padding:10px 12px;line-height:1.6;word-break:break-word;}',
      '.ds-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:30px 16px;border:1px dashed var(--ds-line);border-radius:12px;color:var(--ds-muted);}',
      '.ds-empty-title{font-size:13.5px;font-weight:600;color:var(--ds-fg);}',
      // 一天的卡片头
      '.ds-dayhead{display:flex;align-items:flex-start;gap:12px;}',
      '.ds-daytitle{font-size:15px;font-weight:650;line-height:1.45;}',
      '.ds-daymeta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;}',
      // 时间线
      '.ds-tl{display:flex;flex-direction:column;}',
      '.ds-it{display:grid;grid-template-columns:92px 18px minmax(0,1fr);column-gap:8px;position:relative;}',
      '.ds-it-time{font-family:' + MONO + ';font-size:11.5px;color:var(--ds-muted);padding-top:9px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.ds-it-rail{position:relative;display:flex;justify-content:center;}',
      '.ds-it-rail::before{content:"";position:absolute;top:0;bottom:0;width:2px;background:var(--ds-line-soft);}',
      '.ds-it:first-child .ds-it-rail::before{top:14px;}',
      '.ds-it:last-child .ds-it-rail::before{bottom:calc(100% - 14px);}',
      '.ds-it-dot{position:relative;margin-top:10px;width:10px;height:10px;border-radius:50%;background:var(--ds-card);border:2px solid var(--ds-line);z-index:1;}',
      '.ds-it-body{padding:6px 10px 10px;margin:2px 0;border-radius:10px;border:1px solid transparent;min-width:0;}',
      '.ds-it-act{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.ds-it-loc{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:400;color:var(--ds-muted);}',
      '.ds-it-detail{font-size:12px;color:var(--ds-muted);line-height:1.6;margin-top:2px;}',
      '.ds-it-past .ds-it-act,.ds-it-past .ds-it-detail{opacity:.55;}',
      '.ds-it-past .ds-it-dot{background:var(--ds-line);}',
      '.ds-it-sleep .ds-it-act{font-weight:500;color:var(--ds-muted);}',
      '.ds-it-now .ds-it-body{background:var(--ds-brand-soft);border-color:color-mix(in srgb,var(--ds-brand) 30%,transparent);}',
      '.ds-it-now .ds-it-dot{border-color:var(--ds-brand);background:var(--ds-brand);box-shadow:0 0 0 4px var(--ds-brand-soft);}',
      '.ds-it-now .ds-it-time{color:var(--ds-brand);font-weight:600;}',
      '.ds-now-badge{font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--ds-brand);color:var(--ds-brand-fg);}',
      '.ds-progress{height:3px;border-radius:2px;background:color-mix(in srgb,var(--ds-brand) 18%,transparent);margin-top:7px;overflow:hidden;}',
      '.ds-progress > i{display:block;height:100%;background:var(--ds-brand);border-radius:2px;}',
      // 编辑表
      '.ds-edit-row{display:grid;grid-template-columns:78px 78px minmax(0,1.2fr) minmax(0,.8fr) auto;gap:6px;align-items:start;}',
      '.ds-edit-row .ds-textarea{grid-column:3 / 5;min-height:38px;}',
      '@media (max-width:640px){.ds-edit-row{grid-template-columns:1fr 1fr;}.ds-edit-row .ds-textarea{grid-column:1 / 3;}}',
      '.ds-edit-list{display:flex;flex-direction:column;gap:10px;}',
      '.ds-edit-item{padding:10px;border:1px solid var(--ds-line-soft);border-radius:10px;display:flex;flex-direction:column;gap:6px;}',
      // 日程类型
      '.ds-types{display:flex;flex-direction:column;gap:10px;}',
      '.ds-type{border:1px solid var(--ds-line-soft);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--ds-card);}',
      '.ds-type-off{opacity:.6;}',
      '.ds-type-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.ds-type-name{width:140px;}',
      '.ds-odds{font-size:11px;color:var(--ds-faint);white-space:nowrap;}',
      '.ds-switch{position:relative;width:34px;height:20px;border-radius:999px;border:0;background:var(--ds-line);cursor:pointer;flex:0 0 auto;transition:background-color .15s;}',
      '.ds-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s;}',
      '.ds-switch-on{background:var(--ds-brand);}',
      '.ds-switch-on::after{transform:translateX(14px);}',
      '.ds-toggle{display:flex;align-items:flex-start;gap:9px;cursor:pointer;}',
      '.ds-toggle input{margin-top:2px;accent-color:var(--ds-brand);}',
      '.ds-toggle-hint{font-size:11.5px;color:var(--ds-muted);line-height:1.55;margin-top:2px;}',
      '.ds-pre{white-space:pre-wrap;word-break:break-word;font-family:' + MONO + ';font-size:11.5px;line-height:1.7;background:var(--ds-bar);border:1px solid var(--ds-line-soft);border-radius:10px;padding:10px 12px;color:var(--ds-muted);max-height:320px;overflow:auto;}',
      '.ds-details summary{cursor:pointer;font-size:12px;color:var(--ds-muted);}',
      '.ds-savebar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--ds-line);background:color-mix(in srgb,var(--ds-card) 92%,transparent);backdrop-filter:blur(8px);box-shadow:var(--ds-shadow);z-index:4;}',
      '.ds-dirty{font-size:12px;color:var(--ds-warn);}',
      '.ds-toast{position:sticky;bottom:6px;align-self:center;display:flex;align-items:center;gap:8px;font-size:12.5px;padding:8px 13px;border-radius:999px;border:1px solid var(--ds-line);background:var(--ds-card);box-shadow:var(--ds-shadow);z-index:5;}',
      '.ds-toast-err{color:var(--ds-err);border-color:var(--ds-err-line);}',
      '.ds-history{display:flex;flex-direction:column;gap:6px;}',
      '.ds-hrow{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--ds-line-soft);border-radius:10px;cursor:pointer;background:var(--ds-card);text-align:left;font:inherit;color:inherit;}',
      '.ds-hrow:hover{border-color:var(--ds-line);background:var(--ds-hover);}',
      '.ds-hdate{font-size:12px;font-weight:600;width:96px;flex:0 0 auto;}',
      '.ds-spin{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--ds-brand) 22%,transparent);border-top-color:var(--ds-brand);animation:ds-spin .9s linear infinite;}',
      '@keyframes ds-spin{to{transform:rotate(360deg)}}',
      // 穿搭 / 场景 / 物品
      '.ds-thumb{width:22px;height:22px;border-radius:6px;object-fit:cover;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;background:var(--ds-bar);border:1px solid var(--ds-line-soft);color:var(--ds-faint);overflow:hidden;}',
      '.ds-thumb-lg{width:44px;height:44px;border-radius:9px;}',
      '.ds-thumb-xl{width:60px;height:60px;border-radius:11px;}',
      '.ds-it-wear{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;}',
      '.ds-chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:1.4;padding:2px 9px 2px 2px;border-radius:999px;background:var(--ds-bar);border:1px solid var(--ds-line-soft);color:var(--ds-fg);max-width:100%;min-width:0;}',
      '.ds-chip .ds-thumb{width:20px;height:20px;border-radius:999px;border:0;}',
      '.ds-chip-plain{padding-left:8px;color:var(--ds-muted);}',
      '.ds-chip-note{color:var(--ds-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
      '.ds-it-past .ds-it-wear{opacity:.55;}',
      '.ds-it-now .ds-chip{background:var(--ds-card);}',
      '.ds-runs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.ds-run{display:flex;align-items:center;gap:9px;padding:5px 12px 5px 5px;border-radius:11px;border:1px solid var(--ds-line-soft);background:var(--ds-bar);min-width:0;max-width:100%;}',
      '.ds-run-now{border-color:color-mix(in srgb,var(--ds-brand) 40%,transparent);background:var(--ds-brand-soft);}',
      '.ds-run-time{font-family:' + MONO + ';font-size:11px;color:var(--ds-muted);font-variant-numeric:tabular-nums;}',
      '.ds-run-name{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ds-run-note{font-size:11px;color:var(--ds-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;}',
      '.ds-callout{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:10px;border:1px dashed var(--ds-line);background:var(--ds-bar);font-size:12.5px;color:var(--ds-muted);line-height:1.6;}',
      '.ds-edit-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:6px;}',
      '@media (max-width:640px){.ds-edit-row2{grid-template-columns:1fr;}}',
      '.ds-gallery{display:flex;gap:10px;flex-wrap:wrap;}',
      '.ds-gitem{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;font-size:11px;color:var(--ds-muted);text-align:center;}',
      '.ds-gitem > span:last-child{max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ds-linkgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px 18px;}',
      '@media (max-width:640px){.ds-linkgrid{grid-template-columns:1fr;}}',
      '@supports not (color:color-mix(in srgb,red 10%,blue)){.ds-root{--ds-brand-soft:rgba(59,91,219,.11);--ds-err-bg:rgba(168,58,44,.08);--ds-err-line:rgba(168,58,44,.3);}}',
    ].join('')

    // ---- 小组件 -----------------------------------------------------------------

    function Seg(props) {
      return h('div', { className: 'ds-seg', role: 'tablist' }, props.options.map(function (o) {
        var on = o.value === props.value
        return h('button', { key: o.value, type: 'button', role: 'tab', 'aria-selected': on, className: cx('ds-seg-btn', on && 'ds-seg-on'), onClick: function () { props.onChange(o.value) } }, o.label)
      }))
    }
    function Field(props) {
      return h('label', { className: 'ds-field' }, [
        h('span', { key: 'l', className: 'ds-label' }, [props.label, props.hint ? h('span', { key: 'h', className: 'ds-note' }, props.hint) : null]),
        h(React.Fragment, { key: 'c' }, props.children),
      ])
    }
    function Toggle(props) {
      return h('label', { className: 'ds-toggle' }, [
        h('input', { key: 'i', type: 'checkbox', checked: !!props.checked, onChange: function (e) { props.onChange(e.target.checked) } }),
        h('span', { key: 't' }, [h('div', { key: 'a' }, props.title), props.hint ? h('div', { key: 'b', className: 'ds-toggle-hint' }, props.hint) : null]),
      ])
    }
    function Switch(props) {
      return h('button', { type: 'button', role: 'switch', 'aria-checked': !!props.on, title: props.title, className: cx('ds-switch', props.on && 'ds-switch-on'), onClick: function () { props.onChange(!props.on) } })
    }

    var SOURCE_LABEL = { llm: '模型生成', template: '模板兜底', manual: '手动' }

    // ---- 时间线 -----------------------------------------------------------------

    function Timeline(props) {
      var items = props.day.items || []
      var nowMin = props.nowMinute
      var w = props.wardrobe
      return h('div', { className: 'ds-tl' }, items.map(function (it, i) {
        var s = toMin(it.start)
        var e = it.end === '24:00' ? 1440 : toMin(it.end)
        var isNow = nowMin !== null && s <= nowMin && nowMin < e
        var past = nowMin !== null && e <= nowMin
        var sleep = /睡/.test(it.activity)
        var pct = isNow ? Math.round(((nowMin - s) / Math.max(1, e - s)) * 100) : 0
        var place = it.scene || it.location
        var placeTip = it.scene ? '场景库：' + it.scene + (it.location && it.location !== it.scene ? '（' + it.location + '）' : '') : ''
        return h('div', { key: i, className: cx('ds-it', isNow && 'ds-it-now', past && 'ds-it-past', sleep && 'ds-it-sleep') }, [
          h('div', { key: 't', className: 'ds-it-time' }, it.start + '–' + it.end),
          h('div', { key: 'r', className: 'ds-it-rail' }, h('span', { className: 'ds-it-dot' })),
          h('div', { key: 'b', className: 'ds-it-body' }, [
            h('div', { key: 'a', className: 'ds-it-act' }, [
              it.activity,
              place ? h('span', { key: 'l', className: 'ds-it-loc', title: placeTip }, [h(Icon, { key: 'i', name: 'pin', size: 11 }), place]) : null,
              it.situation ? h('span', { key: 's', className: 'ds-tag', title: '对应的生图情境' }, it.situation) : null,
              isNow ? h('span', { key: 'n', className: 'ds-now-badge' }, '此刻') : null,
            ]),
            it.detail ? h('div', { key: 'd', className: 'ds-it-detail' }, it.detail) : null,
            h(WearRow, { key: 'w', item: it, wardrobe: w }),
            isNow ? h('div', { key: 'p', className: 'ds-progress' }, h('i', { style: { width: pct + '%' } })) : null,
          ]),
        ])
      }))
    }

    /** 一段日程下面的那一行：穿着（带衣柜缩略图）、手边的物品、和谁在一起。 */
    function WearRow(props) {
      var it = props.item
      var w = props.wardrobe || {}
      var parts = []
      if (it.outfit || it.outfitNote) {
        parts.push(h('span', { key: 'o', className: cx('ds-chip', !it.outfit && 'ds-chip-plain'), title: '穿着' + (it.outfit ? '（衣柜里的「' + it.outfit + '」）' : '') }, [
          it.outfit ? h(Thumb, { key: 't', src: coverSrc('outfits', byName(w.outfits, it.outfit)), icon: 'shirt' }) : h(Icon, { key: 't', name: 'shirt', size: 12 }),
          it.outfit ? h('span', { key: 'n' }, it.outfit) : null,
          it.outfitNote ? h('span', { key: 'm', className: 'ds-chip-note' }, (it.outfit ? '· ' : '') + it.outfitNote) : null,
        ]))
      }
      ;(Array.isArray(it.props) ? it.props : []).forEach(function (p) {
        parts.push(h('span', { key: 'p-' + p, className: 'ds-chip', title: '手边的物品' }, [h(Thumb, { key: 't', src: coverSrc('props', byName(w.props, p)), icon: 'bag' }), p]))
      })
      if (Array.isArray(it.with) && it.with.length) {
        parts.push(h('span', { key: 'w', className: 'ds-chip ds-chip-plain', title: '和谁在一起' }, [h(Icon, { key: 'i', name: 'users', size: 12 }), '和 ' + it.with.join('、')]))
      }
      return parts.length ? h('div', { className: 'ds-it-wear' }, parts) : null
    }

    /** 一天的换装：连续穿同一身的合并，大缩略图一眼看完。 */
    function OutfitStrip(props) {
      var runs = outfitRuns(props.day.items)
      if (!runs.length) return null
      var w = props.wardrobe || {}
      var nowMin = props.nowMinute
      return h('div', { className: 'ds-field' }, [
        h('span', { key: 'l', className: 'ds-label' }, [props.which === 'tomorrow' ? '明天的穿搭' : '这一天的穿搭', h('span', { key: 'n', className: 'ds-note' }, runs.length > 1 ? '换了 ' + (runs.length - 1) + ' 次衣服' : '一整天都是这身')]),
        h('div', { key: 'r', className: 'ds-runs' }, runs.map(function (r, i) {
          var isNow = nowMin !== null && nowMin !== undefined && toMin(r.start) <= nowMin && nowMin < toMin(r.end)
          return h('div', { key: i, className: cx('ds-run', isNow && 'ds-run-now'), title: r.outfit ? '衣柜里的「' + r.outfit + '」' + (r.note ? '，' + r.note : '') : r.note }, [
            h(Thumb, { key: 't', className: 'ds-thumb-lg', src: r.outfit ? coverSrc('outfits', byName(w.outfits, r.outfit)) : '', icon: 'shirt', iconSize: 18 }),
            h('div', { key: 'x', style: { minWidth: 0 } }, [
              h('div', { key: 'a', className: 'ds-run-time' }, r.start + '–' + r.end + (isNow ? ' · 此刻' : '')),
              h('div', { key: 'b', className: 'ds-run-name' }, r.outfit || r.note),
              r.outfit && r.note ? h('div', { key: 'c', className: 'ds-run-note' }, r.note) : null,
            ]),
          ])
        })),
      ])
    }

    function EditDay(props) {
      var [draft, setDraft] = useState(function () { return { title: props.day.title || '', mood: props.day.mood || '', items: clone(props.day.items || []) } })
      var [busy, setBusy] = useState(false)
      var setItem = function (i, k, v) {
        setDraft(function (d) { var n = clone(d); n.items[i][k] = v; return n })
      }
      var w = props.wardrobe && props.wardrobe.available ? props.wardrobe : null
      var lk = props.link || {}
      var showOutfit = !!w && lk.outfits !== false
      var showScene = !!w && lk.scenes !== false
      var options = function (list, cur, empty) {
        var names = (list || []).map(function (e) { return e.name })
        var out = [h('option', { key: '', value: '' }, empty)].concat(names.map(function (n) { return h('option', { key: n, value: n }, n) }))
        if (cur && names.indexOf(cur) < 0) out.push(h('option', { key: '__cur', value: cur }, cur + '（库里没有）'))
        return out
      }
      var save = function () {
        setBusy(true)
        apiPost('/day', { date: props.day.date, title: draft.title, mood: draft.mood, items: draft.items }).then(function () {
          props.toast('日程已保存')
          props.onDone(true)
        }, function (e) { setBusy(false); props.toast(errText(e), true) })
      }
      return h('div', { className: 'ds-panel' }, [
        h('div', { key: 't', className: 'ds-panel-title' }, [h(Icon, { key: 'i', name: 'edit' }), '编辑日程', h('span', { key: 'n', className: 'ds-note' }, '时间用 24 小时制 HH:MM；重叠或空档保存时会自动补齐')]),
        h('div', { key: 'h', className: 'ds-2col' }, [
          h(Field, { key: 'a', label: '这一天' }, h('input', { className: 'ds-input', value: draft.title, onChange: function (e) { var v = e.target.value; setDraft(function (d) { return Object.assign({}, d, { title: v }) }) } })),
          h(Field, { key: 'b', label: '心情' }, h('input', { className: 'ds-input', value: draft.mood, onChange: function (e) { var v = e.target.value; setDraft(function (d) { return Object.assign({}, d, { mood: v }) }) } })),
        ]),
        h('div', { key: 'l', className: 'ds-edit-list' }, draft.items.map(function (it, i) {
          var row2 = showOutfit || showScene ? h('div', { key: 'w', className: 'ds-edit-row2' }, [
            showOutfit ? h('select', { key: 'o', className: 'ds-select', value: it.outfit || '', title: '穿着：衣柜里的哪一套', onChange: function (e) { setItem(i, 'outfit', e.target.value) } }, options(w.outfits, it.outfit, '穿着：不用衣柜里的')) : null,
            showOutfit ? h('input', { key: 'n', className: 'ds-input', value: it.outfitNote || '', placeholder: '穿着备注：外面加了件开衫 / 睡衣', onChange: function (e) { setItem(i, 'outfitNote', e.target.value) } }) : null,
            showScene ? h('select', { key: 's', className: 'ds-select', value: it.scene || '', title: '场景：对应场景库里的哪个地方', onChange: function (e) { setItem(i, 'scene', e.target.value) } }, options(w.scenes, it.scene, '场景：不用场景库')) : null,
          ]) : null
          return h('div', { key: i, className: 'ds-edit-item' }, [h('div', { key: 'r', className: 'ds-edit-row' }, [
            h('input', { key: 's', className: 'ds-input ds-mono', value: it.start, onChange: function (e) { setItem(i, 'start', e.target.value) } }),
            h('input', { key: 'e', className: 'ds-input ds-mono', value: it.end, onChange: function (e) { setItem(i, 'end', e.target.value) } }),
            h('input', { key: 'a', className: 'ds-input', value: it.activity, placeholder: '在做什么', onChange: function (e) { setItem(i, 'activity', e.target.value) } }),
            h('input', { key: 'l', className: 'ds-input', value: it.location || '', placeholder: '在哪', onChange: function (e) { setItem(i, 'location', e.target.value) } }),
            h('button', { key: 'x', type: 'button', className: 'ds-btn ds-btn-sm ds-btn-ghost', title: '删除这一段', onClick: function () { setDraft(function (d) { var n = clone(d); n.items.splice(i, 1); return n }) } }, h(Icon, { name: 'trash', size: 13 })),
            h('span', { key: 'sp1' }), h('span', { key: 'sp2' }),
            h('textarea', { key: 'd', className: 'ds-textarea', rows: 1, value: it.detail || '', placeholder: '细节：心情、小插曲、和谁一起', onChange: function (e) { setItem(i, 'detail', e.target.value) } }),
          ]), row2])
        })),
        h('div', { key: 'b', className: 'ds-row' }, [
          h('button', { key: 'a', type: 'button', className: 'ds-btn ds-btn-sm', onClick: function () {
            setDraft(function (d) { var n = clone(d); var last = n.items[n.items.length - 1]; n.items.push({ start: last ? last.end : '00:00', end: '24:00', activity: '', location: '', detail: '' }); return n })
          } }, [h(Icon, { key: 'i', name: 'plus', size: 13 }), '加一段']),
          h('span', { key: 'g', className: 'ds-grow' }),
          h('button', { key: 'c', type: 'button', className: 'ds-btn ds-btn-ghost', onClick: function () { props.onDone(false) } }, '取消'),
          h('button', { key: 's', type: 'button', className: 'ds-btn ds-btn-primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
        ]),
      ])
    }

    function GeneratePanel(props) {
      var [typeId, setTypeId] = useState('')
      var [hint, setHint] = useState('')
      var [job, setJob] = useState(null)
      var poll = useRef(null)
      useEffect(function () { return function () { if (poll.current) poll.current.stop() } }, [])
      var run = function () {
        if (props.exists && !window.confirm('会用新生成的日程替换这一天现在的安排' + (props.changed ? '（包括手动 / 临时调整过的部分）' : '') + '，继续吗？')) return
        setJob({ status: 'running', elapsedMs: 0 })
        apiPost('/generate', { day: props.date, dayTypeId: typeId, hint: hint }).then(function (r) {
          var p = pollJob(r.jobId, setJob)
          poll.current = p
          return p
        }).then(function () {
          setJob(null)
          setHint('')
          props.toast('日程已生成')
          props.onDone()
        }, function (e) { setJob(null); props.toast(errText(e), true) })
      }
      var running = job && job.status === 'running'
      var types = (props.dayTypes || []).filter(function (t) { return t.enabled })
      return h('div', { className: 'ds-panel' }, [
        h('div', { key: 't', className: 'ds-panel-title' }, [h(Icon, { key: 'i', name: 'sparkle' }), props.exists ? '重新生成' : '生成这一天的日程']),
        h('div', { key: 'r', className: 'ds-2col' }, [
          h(Field, { key: 'a', label: '日程类型' }, h('select', { className: 'ds-select', value: typeId, onChange: function (e) { setTypeId(e.target.value) } },
            [h('option', { key: '', value: '' }, '按星期随机挑（和每晚自动生成一样）')].concat(types.map(function (t) { return h('option', { key: t.id, value: t.id }, t.name) })))),
          h(Field, { key: 'b', label: '这一天的特别要求', hint: '可选' }, h('input', { className: 'ds-input', value: hint, placeholder: '例如：下午和你去看电影；早上要去看牙医', onChange: function (e) { setHint(e.target.value) } })),
        ]),
        h('div', { key: 'b', className: 'ds-row' }, [
          running ? h('span', { key: 's', className: 'ds-row ds-note' }, [h('span', { key: 'i', className: 'ds-spin' }), '生成中 · ' + Math.round((job.elapsedMs || 0) / 1000) + ' 秒']) : null,
          h('span', { key: 'g', className: 'ds-grow' }),
          props.onCancel ? h('button', { key: 'c', type: 'button', className: 'ds-btn ds-btn-ghost', disabled: running, onClick: props.onCancel }, '收起') : null,
          h('button', { key: 'go', type: 'button', className: 'ds-btn ds-btn-primary', disabled: running, onClick: run }, [h(Icon, { key: 'i', name: 'sparkle', size: 13 }), running ? '生成中…' : '生成']),
        ]),
      ])
    }

    // ---- 日程页 -----------------------------------------------------------------

    function DayView(props) {
      var day = props.day
      var [mode, setMode] = useState('view') // view | edit | gen
      var [dressJob, setDressJob] = useState(null)
      var dressPoll = useRef(null)
      useEffect(function () { setMode('view') }, [props.date])
      useEffect(function () { return function () { if (dressPoll.current) dressPoll.current.stop() } }, [])
      var runDress = function (reset) {
        if (reset && !window.confirm('会按衣柜给这一天重新配一遍穿搭，替换现在每一段的穿着（活动不变），继续吗？')) return
        setDressJob({ status: 'running', elapsedMs: 0 })
        apiPost('/dress', { day: props.date, reset: !!reset }).then(function (r) {
          var p = pollJob(r.jobId, setDressJob)
          dressPoll.current = p
          return p
        }).then(function () {
          setDressJob(null)
          props.toast(reset ? '已经重新搭配好了' : '穿搭补上了')
          props.onChanged()
        }, function (e) { setDressJob(null); props.toast(errText(e), true) })
      }
      var dressing = dressJob && dressJob.status === 'running'
      if (!day) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
          h('div', { key: 'e', className: 'ds-empty' }, [
            h('div', { key: 't', className: 'ds-empty-title' }, props.which === 'tomorrow' ? '明天的日程还没生成' : '这一天还没有日程'),
            h('div', { key: 'd', className: 'ds-note' }, props.which === 'tomorrow' ? props.nextLabel + '。也可以现在就生成。' : '插件每分钟会检查一次，今天没有日程时会自动补上；也可以现在手动生成。'),
          ]),
          h(GeneratePanel, { key: 'g', date: props.date, exists: false, dayTypes: props.dayTypes, toast: props.toast, onDone: props.onChanged }),
        ])
      }
      var changes = Array.isArray(day.changes) ? day.changes : []
      if (mode === 'edit') return h(EditDay, { day: day, wardrobe: props.wardrobe, link: props.link, toast: props.toast, onDone: function (saved) { setMode('view'); if (saved) props.onChanged() } })
      var dressed = hasOutfits(day)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 'h', className: 'ds-panel' }, [
          h('div', { key: 'a', className: 'ds-dayhead' }, [
            h('div', { key: 't', className: 'ds-grow' }, [
              h('div', { key: 'x', className: 'ds-daytitle' }, day.title || day.dayType.name),
              h('div', { key: 'm', className: 'ds-daymeta' }, [
                h('span', { key: 'a', className: 'ds-tag ds-tag-brand' }, day.dayType.name),
                day.mood ? h('span', { key: 'b', className: 'ds-tag' }, '心情：' + day.mood) : null,
                h('span', { key: 'c', className: cx('ds-tag', day.source === 'template' && 'ds-tag-warn'), title: day.error || day.model || '' }, SOURCE_LABEL[day.source] || day.source),
                changes.length ? h('span', { key: 'd', className: 'ds-tag', title: changes.slice(-5).map(function (c) { return c.note }).join('\n') }, '调整过 ' + changes.length + ' 次') : null,
                day.hint ? h('span', { key: 'e', className: 'ds-tag', title: '生成时的要求' }, '要求：' + day.hint) : null,
              ]),
            ]),
            h('div', { key: 'b', className: 'ds-row' }, [
              h('button', { key: 'e', type: 'button', className: 'ds-btn ds-btn-sm', onClick: function () { setMode('edit') } }, [h(Icon, { key: 'i', name: 'edit', size: 13 }), '编辑']),
              props.canDress && dressed ? h('button', { key: 'd', type: 'button', className: 'ds-btn ds-btn-sm', disabled: dressing, title: '按衣柜重新给整天配穿搭，活动不变', onClick: function () { runDress(true) } }, [h(Icon, { key: 'i', name: 'shirt', size: 13 }), '重新搭配']) : null,
              h('button', { key: 'g', type: 'button', className: 'ds-btn ds-btn-sm', onClick: function () { setMode(mode === 'gen' ? 'view' : 'gen') } }, [h(Icon, { key: 'i', name: 'refresh', size: 13 }), '重新生成']),
            ]),
          ]),
          dressing ? h('div', { key: 'dj', className: 'ds-row ds-note' }, [h('span', { key: 'i', className: 'ds-spin' }), '正在按衣柜搭配 · ' + Math.round((dressJob.elapsedMs || 0) / 1000) + ' 秒']) : null,
          dressed ? h(OutfitStrip, { key: 'os', day: day, which: props.which, wardrobe: props.wardrobe, nowMinute: props.which === 'today' ? props.nowMinute : null }) : null,
          !dressed && props.canDress && !dressing ? h('div', { key: 'nd', className: 'ds-callout' }, [
            h(Icon, { key: 'i', name: 'shirt', size: 16 }),
            h('span', { key: 't', className: 'ds-grow' }, '这一天还没配穿搭。按衣柜给每一段配上穿着，聊天和生图时就知道她当时穿的什么。'),
            h('button', { key: 'b', type: 'button', className: 'ds-btn ds-btn-sm ds-btn-primary', onClick: function () { runDress(false) } }, [h(Icon, { key: 'i', name: 'sparkle', size: 13 }), '按衣柜补上穿搭']),
          ]) : null,
          day.source === 'template' && day.error ? h('div', { key: 'err', className: 'ds-note', style: { color: 'var(--ds-warn)' } }, '这份是模板兜底：模型生成失败（' + day.error + '）。可以点「重新生成」再试。') : null,
        ]),
        mode === 'gen' ? h(GeneratePanel, { key: 'g', date: props.date, exists: true, changed: changes.length > 0, dayTypes: props.dayTypes, toast: props.toast, onCancel: function () { setMode('view') }, onDone: function () { setMode('view'); props.onChanged() } }) : null,
        h('div', { key: 't', className: 'ds-panel' }, h(Timeline, { day: day, wardrobe: props.wardrobe, nowMinute: props.which === 'today' ? props.nowMinute : null })),
      ])
    }

    function ScheduleTab(props) {
      var s = props.state
      var [which, setWhich] = useState('today')
      var day = which === 'today' ? s.today : s.tomorrow
      var date = which === 'today' ? s.dates.today : s.dates.tomorrow
      var label = function (d) { var p = d.split('-'); return Number(p[1]) + '月' + Number(p[2]) + '日' }
      var w = s.wardrobe && s.wardrobe.available ? s.wardrobe : null
      var link = s.config.link || {}
      var canDress = !!w && s.config.imageStudio !== false && link.outfits !== false
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 's', className: 'ds-row' }, [
          h(Seg, { key: 'w', value: which, onChange: setWhich, options: [{ value: 'today', label: '今天 · ' + label(s.dates.today) }, { value: 'tomorrow', label: '明天 · ' + label(s.dates.tomorrow) }] }),
          h('span', { key: 'g', className: 'ds-grow' }),
          h('span', { key: 'n', className: 'ds-note' }, s.status.next),
        ]),
        s.status.lastError ? h('div', { key: 'e', className: 'ds-note', style: { color: 'var(--ds-warn)' } }, '最近一次生成出错：' + s.status.lastError) : null,
        h(DayView, { key: which, which: which, date: date, day: day, nowMinute: s.now.minute, dayTypes: s.config.dayTypes, nextLabel: s.status.next, wardrobe: w, link: s.config.imageStudio !== false ? link : { outfits: false, scenes: false }, canDress: canDress, toast: props.toast, onChanged: props.reload }),
        which === 'today' ? h('details', { key: 'p', className: 'ds-details' }, [
          h('summary', { key: 's' }, '现在注入给模型的内容'),
          h('pre', { key: 'p', className: 'ds-pre', style: { marginTop: '8px' } }, s.preview || '（注入已关闭）'),
        ]) : null,
      ])
    }

    // ---- 日程类型 ---------------------------------------------------------------

    function odds(types, scope) {
      var pool = types.filter(function (t) { return t.enabled && Number(t.weight) > 0 && (t.days === scope || t.days === 'any') })
      if (!pool.length) pool = types.filter(function (t) { return t.enabled && Number(t.weight) > 0 })
      var total = pool.reduce(function (n, t) { return n + Number(t.weight) }, 0)
      var out = {}
      pool.forEach(function (t) { out[t.name] = total ? Math.round((Number(t.weight) / total) * 100) : 0 })
      return out
    }

    function TypesTab(props) {
      var [draft, setDraft] = useState(function () { return clone(props.state.config.dayTypes) })
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState(false)
      var set = function (i, k, v) { setDraft(function (d) { var n = clone(d); n[i][k] = v; return n }); setDirty(true) }
      var wk = odds(draft, 'weekday')
      var we = odds(draft, 'weekend')
      var save = function () {
        setBusy(true)
        apiPost('/daytypes', { dayTypes: draft }).then(function (s) {
          props.onState(s); setDraft(clone(s.config.dayTypes)); setDirty(false); props.toast('日程类型已保存')
        }, function (e) { props.toast(errText(e), true) }).then(function () { setBusy(false) })
      }
      var reset = function () {
        if (!window.confirm('恢复成默认的六种日程类型？自定义的会丢失。')) return
        apiPost('/daytypes/reset', {}).then(function (s) { props.onState(s); setDraft(clone(s.config.dayTypes)); setDirty(false); props.toast('已恢复默认') }, function (e) { props.toast(errText(e), true) })
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 'n', className: 'ds-note' }, '每晚生成时，按明天是工作日还是周末，从「适用」匹配的类型里按权重随机挑一种；关掉的类型不会被选到。「框架」告诉模型这种日子大概怎么过，细节由模型发挥。'),
        h('div', { key: 'l', className: 'ds-types' }, draft.map(function (t, i) {
          var p = [wk[t.name] !== undefined && t.days !== 'weekend' ? '工作日 ' + wk[t.name] + '%' : '', we[t.name] !== undefined && t.days !== 'weekday' ? '周末 ' + we[t.name] + '%' : ''].filter(Boolean).join(' · ')
          return h('div', { key: i, className: cx('ds-type', !t.enabled && 'ds-type-off') }, [
            h('div', { key: 'h', className: 'ds-type-head' }, [
              h(Switch, { key: 's', on: t.enabled, title: t.enabled ? '已启用' : '已关闭', onChange: function (v) { set(i, 'enabled', v) } }),
              h('input', { key: 'n', className: 'ds-input ds-type-name', value: t.name, placeholder: '类型名', onChange: function (e) { set(i, 'name', e.target.value) } }),
              h('select', { key: 'd', className: 'ds-select', style: { width: '96px' }, value: t.days, onChange: function (e) { set(i, 'days', e.target.value) } }, ['weekday', 'weekend', 'any'].map(function (k) { return h('option', { key: k, value: k }, SCOPE_LABEL[k]) })),
              h('span', { key: 'wl', className: 'ds-note' }, '权重'),
              h('input', { key: 'w', className: 'ds-input ds-num', type: 'number', min: 0, max: 100, value: t.weight, onChange: function (e) { set(i, 'weight', e.target.value === '' ? '' : Number(e.target.value)) } }),
              h('span', { key: 'o', className: 'ds-odds ds-grow' }, t.enabled ? p : '不会被选到'),
              h('button', { key: 'x', type: 'button', className: 'ds-btn ds-btn-sm ds-btn-ghost', title: '删除', onClick: function () { setDraft(function (d) { var n = clone(d); n.splice(i, 1); return n }); setDirty(true) } }, h(Icon, { name: 'trash', size: 13 })),
            ]),
            h('textarea', { key: 'g', className: 'ds-textarea', rows: 2, value: t.guide, placeholder: '框架：这种日子大概怎么过', onChange: function (e) { set(i, 'guide', e.target.value) } }),
          ])
        })),
        h('div', { key: 'a', className: 'ds-row' }, [
          h('button', { key: 'a', type: 'button', className: 'ds-btn ds-btn-sm', onClick: function () { setDraft(function (d) { return d.concat([{ id: '', name: '', enabled: true, weight: 1, days: 'any', guide: '' }]) }); setDirty(true) } }, [h(Icon, { key: 'i', name: 'plus', size: 13 }), '加一种类型']),
          h('span', { key: 'g', className: 'ds-grow' }),
          h('button', { key: 'r', type: 'button', className: 'ds-btn ds-btn-sm ds-btn-ghost', onClick: reset }, '恢复默认'),
        ]),
        h('div', { key: 's', className: 'ds-savebar' }, [
          h('span', { key: 'd', className: dirty ? 'ds-dirty' : 'ds-note' }, dirty ? '有未保存的修改' : '日程类型已是最新'),
          h('span', { key: 'g', className: 'ds-grow' }),
          dirty ? h('button', { key: 'u', type: 'button', className: 'ds-btn ds-btn-ghost', onClick: function () { setDraft(clone(props.state.config.dayTypes)); setDirty(false) } }, '撤销') : null,
          h('button', { key: 'b', type: 'button', className: 'ds-btn ds-btn-primary', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
        ]),
      ])
    }

    // ---- 设置 -------------------------------------------------------------------

    function SettingsTab(props) {
      var s = props.state
      var [draft, setDraft] = useState(function () { var c = clone(s.config); delete c.dayTypes; return c })
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState(false)
      var [models, setModels] = useState(null)
      var [libBusy, setLibBusy] = useState(false)
      useEffect(function () { apiGet('/models').then(setModels, function () { setModels({ models: [], current: '' }) }) }, [])
      var defaultVoice = (s.defaults && s.defaults.voice) || ''
      var refreshLib = function () {
        setLibBusy(true)
        apiGet('/state?fresh=1').then(function (st) { props.onState(st); props.toast('素材库已重新读取') }, function (e) { props.toast(errText(e), true) }).then(function () { setLibBusy(false) })
      }
      var set = function (k, v, sub) {
        setDraft(function (d) { var n = clone(d); if (sub) n[sub][k] = v; else n[k] = v; return n })
        setDirty(true)
      }
      var save = function () {
        setBusy(true)
        apiPost('/config', draft).then(function (st) {
          props.onState(st); var c = clone(st.config); delete c.dayTypes; setDraft(c); setDirty(false); props.toast('设置已保存')
        }, function (e) { props.toast(errText(e), true) }).then(function () { setBusy(false) })
      }
      var modelOpts = [h('option', { key: '', value: '' }, '跟随 DSH 默认模型' + (s.defaultModel ? '（' + s.defaultModel + '）' : ''))]
        .concat(((models && models.models) || []).map(function (m) { return h('option', { key: m.route, value: m.route }, m.route) }))
      if (draft.model && !((models && models.models) || []).some(function (m) { return m.route === draft.model })) modelOpts.push(h('option', { key: '__cur', value: draft.model }, draft.model))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 'c', className: 'ds-panel' }, [
          h('div', { key: 't', className: 'ds-panel-title' }, [h(Icon, { key: 'i', name: 'calendar' }), '角色']),
          h('div', { key: 'r', className: 'ds-2col' }, [
            h(Field, { key: 'a', label: '角色名' }, h('input', { className: 'ds-input', value: draft.characterName, onChange: function (e) { set('characterName', e.target.value) } })),
            h(Field, { key: 'b', label: '她怎么称呼你', hint: '可选' }, h('input', { className: 'ds-input', value: draft.partnerName, placeholder: '例如：哥哥、主人，或者你的名字', onChange: function (e) { set('partnerName', e.target.value) } })),
          ]),
          h(Field, { key: 'p', label: '人设来源', hint: '生成日程时给模型看，决定她过日子的性格和习惯' }, [
            h(Seg, { key: 's', value: draft.personaFrom, onChange: function (v) { set('personaFrom', v) }, options: [{ value: 'agent-md', label: '读 AGENT.md（人格设置）' }, { value: 'custom', label: '自己写' }] }),
            draft.personaFrom === 'custom'
              ? h('textarea', { key: 't', className: 'ds-textarea', rows: 5, style: { marginTop: '8px' }, value: draft.personaText, onChange: function (e) { set('personaText', e.target.value) } })
              : h('div', { key: 'p', className: 'ds-pre', style: { marginTop: '8px', maxHeight: '120px' } }, s.personaPreview || '（没读到 AGENT.md）'),
          ]),
          h(Field, { key: 'x', label: '固定设定', hint: '她住哪、在哪上班、通勤方式、常去的店……每次生成都会带上' }, h('textarea', { className: 'ds-textarea', rows: 3, value: draft.extraRules, placeholder: '例如：住在悉尼的一间小公寓，公司在市中心，坐火车通勤二十分钟；楼下有家常去的拉面店。', onChange: function (e) { set('extraRules', e.target.value) } })),
        ]),
        h('div', { key: 'g', className: 'ds-panel' }, [
          h('div', { key: 't', className: 'ds-panel-title' }, [h(Icon, { key: 'i', name: 'sparkle' }), '生成']),
          h('div', { key: 'r', className: 'ds-row', style: { gap: '18px', alignItems: 'flex-end' } }, [
            h(Field, { key: 'a', label: '每晚几点生成明天的' }, h('input', { className: 'ds-input ds-time ds-mono', type: 'time', value: draft.generateAt, onChange: function (e) { set('generateAt', e.target.value) } })),
            h(Field, { key: 'b', label: '时区', hint: '留空跟随电脑' }, h('input', { className: 'ds-input ds-mono', style: { width: '200px' }, value: draft.timeZone, placeholder: s.systemTimeZone, onChange: function (e) { set('timeZone', e.target.value) } })),
          ]),
          h(Field, { key: 'm', label: '生成用的模型' }, h('select', { className: 'ds-select', value: draft.model, onChange: function (e) { set('model', e.target.value) } }, modelOpts)),
          h('div', { key: 'n', className: 'ds-note' }, 'DSH 没开着的时候错过了生成时间也没关系：下次启动时，今天没有日程会马上补上，明天的会在到点后生成。'),
        ]),
        h('div', { key: 'i', className: 'ds-panel' }, [
          h('div', { key: 't', className: 'ds-panel-title' }, [h(Icon, { key: 'i', name: 'layers' }), '注入到对话']),
          h(Toggle, { key: 'e', checked: draft.enabled, onChange: function (v) { set('enabled', v) }, title: '启用每日日程', hint: '关掉后不再生成，也不再注入。' }),
          h(Toggle, { key: 'j', checked: draft.inject.enabled, onChange: function (v) { set('enabled', v, 'inject') }, title: '把「今天」注入对话', hint: '日期、时间、此刻在做什么、接下来做什么。' }),
          h(Field, { key: 'sc', label: '注入到哪些会话', hint: '子代理会话（派出去干活的）始终不注入' }, h(Seg, { value: draft.inject.scope === 'session' ? 'session' : 'all', onChange: function (v) { set('scope', v, 'inject') }, options: [{ value: 'all', label: '所有会话' }, { value: 'session', label: '只在打开的会话' }] })),
          h('div', { key: 'scn', className: 'ds-callout', style: { borderStyle: 'solid' } }, [
            h('span', { key: 'i', className: 'ds-mono', style: { fontWeight: 600, color: 'var(--ds-brand)' } }, '/life'),
            h('span', { key: 't', className: 'ds-grow' }, draft.inject.scope === 'session'
              ? '每个会话默认都不带她的日常，适合主要用 DSH 干活。想在哪个会话里和她聊天，就在那个会话里发 /life on。'
              : '每个会话默认都带上她的日常。要在某个会话里专心干正事，就在那个会话里发 /life off；/life auto 恢复默认，/life 查看状态。'),
          ]),
          h(SessionOverrides, { key: 'so', sessions: s.sessions, onState: props.onState, toast: props.toast }),
          h(Field, { key: 'p', label: '时间写多细', hint: 'DSH 自带的时钟每 10 分钟会给模型一次精确时间' }, h(Seg, { value: draft.inject.precision, onChange: function (v) { set('precision', v, 'inject') }, options: [{ value: 'halfhour', label: '每半小时（推荐）' }, { value: 'minute', label: '精确到分钟' }, { value: 'block', label: '只看时段' }] })),
          h('div', { key: 'r', className: 'ds-row', style: { gap: '18px', alignItems: 'flex-end' } }, [
            h(Field, { key: 'a', label: '几点以后附上明天的安排' }, h('input', { className: 'ds-input ds-time ds-mono', type: 'time', value: draft.inject.tomorrowAfter, onChange: function (e) { set('tomorrowAfter', e.target.value, 'inject') } })),
            h(Field, { key: 'b', label: '「接下来」显示几段' }, h('input', { className: 'ds-input ds-num', type: 'number', min: 0, max: 8, value: draft.inject.upcoming, onChange: function (e) { set('upcoming', Number(e.target.value), 'inject') } })),
          ]),
          h('div', { key: 'n', className: 'ds-note' }, '时间写得越细，注入内容变得越频繁，模型那边重新读提示词的次数也越多。'),
          h(Toggle, { key: 'v', checked: draft.inject.voiceOn !== false, onChange: function (v) { set('voiceOn', v, 'inject') }, title: '让她像真人一样提起自己的生活（推荐）', hint: '在注入后面加一段「说话方式」：这些是她自己想做、自己去做的事，不说「按照日程」「按计划」，不报时间段、不念清单。' }),
          draft.inject.voiceOn !== false ? h('div', { key: 'vt', className: 'ds-field' }, [
            h('span', { key: 'l', className: 'ds-label' }, ['说话方式', h('span', { key: 'h', className: 'ds-note' }, '原样加在注入内容后面；{角色名}、{称呼} 会换成上面填的名字')]),
            h('textarea', { key: 't', className: 'ds-textarea', rows: 10, value: draft.inject.voice || defaultVoice, onChange: function (e) { var v = e.target.value; set('voice', v.trim() === defaultVoice.trim() ? '' : v, 'inject') } }),
            h('div', { key: 'r', className: 'ds-row' }, [
              h('span', { key: 'n', className: 'ds-note ds-grow' }, draft.inject.voice ? '已自定义。' : '正在用默认的说话方式（插件更新时会跟着改进）。'),
              draft.inject.voice ? h('button', { key: 'b', type: 'button', className: 'ds-btn ds-btn-sm', onClick: function () { set('voice', '', 'inject') } }, [h(Icon, { key: 'i', name: 'refresh', size: 13 }), '恢复默认']) : null,
            ]),
          ]) : null,
        ]),
        h(LinkPanel, { key: 'w', state: s, draft: draft, set: set, busy: libBusy, onRefresh: refreshLib }),
        h('div', { key: 's', className: 'ds-savebar' }, [
          h('span', { key: 'd', className: dirty ? 'ds-dirty' : 'ds-note' }, dirty ? '有未保存的修改' : '设置已是最新'),
          h('span', { key: 'g', className: 'ds-grow' }),
          h('button', { key: 'b', type: 'button', className: 'ds-btn ds-btn-primary', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存设置'),
        ]),
      ])
    }

    /** 单独用 /life 设置过的会话：看得见、能一键恢复默认。 */
    function SessionOverrides(props) {
      var info = props.sessions || { overrides: [], total: 0 }
      var list = info.overrides || []
      if (!list.length) return h('div', { className: 'ds-note' }, '还没有单独设置过的会话。')
      var reset = function (id) {
        apiPost('/session', { id: id, on: null }).then(function (st) { props.onState(st); props.toast('已恢复默认') }, function (e) { props.toast(errText(e), true) })
      }
      var fmt = function (iso) { var d = new Date(iso); return isNaN(d) ? '' : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
      var base = function (p) { var parts = String(p || '').split(/[\\/]/).filter(Boolean); return parts.length ? parts[parts.length - 1] : '' }
      return h('details', { className: 'ds-details' }, [
        h('summary', { key: 's' }, '单独设置过的会话（' + info.total + '）'),
        h('div', { key: 'l', className: 'ds-history', style: { marginTop: '8px' } }, list.map(function (o) {
          return h('div', { key: o.id, className: 'ds-hrow', style: { cursor: 'default' } }, [
            h('span', { key: 'a', className: cx('ds-tag', o.on ? 'ds-tag-brand' : 'ds-tag-warn') }, o.on ? '已打开' : '已关掉'),
            h('span', { key: 'b', className: 'ds-mono', title: o.id }, String(o.id).slice(0, 8)),
            h('span', { key: 'c', className: 'ds-grow ds-note', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: o.cwd }, [base(o.cwd), o.at ? ' · ' + fmt(o.at) : ''].join('')),
            h('button', { key: 'd', type: 'button', className: 'ds-btn ds-btn-sm ds-btn-ghost', onClick: function () { reset(o.id) } }, '恢复默认'),
          ])
        })),
      ])
    }

    /** 设置里的「联动生图工作室」：她是谁、联动哪些库、衣柜和常去的地方一览。 */
    function LinkPanel(props) {
      var w = props.state.wardrobe || { available: false, characters: [], outfits: [], scenes: [], props: [], people: [] }
      var draft = props.draft
      var set = props.set
      var link = draft.link || {}
      var on = draft.imageStudio !== false
      var auto = autoHer(w, draft.characterName)
      var gallery = function (key, label, category, list, icon) {
        if (!list || !list.length) return null
        return h(Field, { key: key, label: label, hint: list.length > 24 ? '共 ' + list.length + ' 个，只显示前 24 个' : '共 ' + list.length + ' 个' },
          h('div', { className: 'ds-gallery' }, list.slice(0, 24).map(function (e) {
            return h('div', { key: e.id, className: 'ds-gitem', title: e.name + (e.tags && e.tags.length ? '\n' + e.tags.join(' · ') : '') }, [
              h(Thumb, { key: 't', className: 'ds-thumb-xl', src: coverSrc(category, e), icon: icon, iconSize: 20 }),
              h('span', { key: 'n' }, e.name),
            ])
          })))
      }
      return h('div', { className: 'ds-panel' }, [
        h('div', { key: 't', className: 'ds-panel-title' }, [
          h(Icon, { key: 'i', name: 'shirt' }), '联动生图工作室',
          h('span', { key: 'g', className: 'ds-grow' }),
          h('button', { key: 'r', type: 'button', className: 'ds-btn ds-btn-sm ds-btn-ghost', disabled: props.busy, onClick: props.onRefresh, title: '往素材库里加了东西以后点一下' }, [h(Icon, { key: 'i', name: 'refresh', size: 13 }), props.busy ? '读取中…' : '重新读取素材库']),
        ]),
        h(Toggle, { key: 'e', checked: on, onChange: function (v) { set('imageStudio', v) }, title: '和生图工作室联动', hint: '读取生图工作室（dsh-image-studio）的素材库：日程按衣柜配穿搭、多去场景库里有的地方；发自拍时人物、穿着、场景都按此刻的安排来。' }),
        !w.available ? h('div', { key: 'u', className: 'ds-callout' }, '没找到生图工作室的素材库。装好 dsh-image-studio、往库里加了服饰和场景以后，点右上角「重新读取素材库」。') : null,
        w.available && on ? h(Field, { key: 'c', label: '日程里的她是人物库里的', hint: '穿搭习惯（情境穿搭、默认服饰）按这个人物来，生图时 characters 也填它' },
          h('select', { className: 'ds-select', value: draft.imageCharacter || '', onChange: function (e) { set('imageCharacter', e.target.value) } },
            [h('option', { key: '', value: '' }, auto ? '自动：按角色名认出「' + auto.name + '」' : '自动：按角色名「' + (draft.characterName || '') + '」找（没认出来）')]
              .concat((w.characters || []).map(function (c) { return h('option', { key: c.id, value: c.id }, c.name) })))) : null,
        w.available && on ? h('div', { key: 'g', className: 'ds-linkgrid' }, [
          h(Toggle, { key: 'o', checked: link.outfits !== false, onChange: function (v) { set('outfits', v, 'link') }, title: '穿搭（衣柜里 ' + w.outfits.length + ' 套）', hint: '每段日程都配上穿着，优先用衣柜里的服饰；库里没有的写成文字。生图时照着穿。' }),
          h(Toggle, { key: 's', checked: link.scenes !== false, onChange: function (v) { set('scenes', v, 'link') }, title: '场景（' + w.scenes.length + ' 个地方）', hint: '日程多安排在场景库里有的地方，每段标上对应的场景，出图时直接用。' }),
          h(Toggle, { key: 'p', checked: link.props !== false, onChange: function (v) { set('props', v, 'link') }, title: '物品（' + w.props.length + ' 件）', hint: '道具库里的东西会在合适的时段出现：「手边有…」。' }),
          h(Toggle, { key: 'w', checked: link.people !== false, onChange: function (v) { set('people', v, 'link') }, title: '认识的人（' + (w.people || []).length + ' 位）', hint: '人物库里除了她以外的人，可以出现在日程里：「和…在一起」。' }),
        ]) : null,
        w.available && on && link.outfits !== false ? gallery('go', '她的衣柜', 'outfits', w.outfits, 'shirt') : null,
        w.available && on && link.scenes !== false ? gallery('gs', '常去的地方', 'scenes', w.scenes, 'pin') : null,
        w.available && on ? h('div', { key: 'n', className: 'ds-note' }, '改了这里要点下面的「保存设置」。已经生成的日程不会自动变：没配穿搭的那天，在「日程」页点「按衣柜补上穿搭」就行。') : null,
      ])
    }

    // ---- 往期 -------------------------------------------------------------------

    function HistoryTab(props) {
      var [list, setList] = useState(null)
      var [open, setOpen] = useState(null)
      useEffect(function () { apiGet('/days?limit=30').then(function (r) { setList(r.days) }, function (e) { props.toast(errText(e), true); setList([]) }) }, [])
      if (open) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
          h('div', { key: 'b', className: 'ds-row' }, [h('button', { key: 'b', type: 'button', className: 'ds-btn ds-btn-ghost', onClick: function () { setOpen(null) } }, [h(Icon, { key: 'i', name: 'back' }), '往期']), h('span', { key: 't', className: 'ds-label' }, open.label)]),
          h('div', { key: 'p', className: 'ds-panel' }, open.day ? [
            hasOutfits(open.day) ? h(OutfitStrip, { key: 's', day: open.day, which: 'history', wardrobe: props.wardrobe, nowMinute: null }) : null,
            h(Timeline, { key: 't', day: open.day, wardrobe: props.wardrobe, nowMinute: null }),
          ] : h('div', { className: 'ds-note' }, '加载中…')),
        ])
      }
      if (list === null) return h('div', { className: 'ds-note' }, '加载中…')
      if (!list.length) return h('div', { className: 'ds-empty' }, [h('div', { key: 't', className: 'ds-empty-title' }, '还没有往期日程')])
      return h('div', { className: 'ds-history' }, list.map(function (d) {
        return h('button', { key: d.date, type: 'button', className: 'ds-hrow', onClick: function () {
          setOpen({ label: d.label, day: null })
          apiGet('/day?date=' + d.date).then(function (r) { setOpen({ label: d.label, day: r.day }) }, function (e) { props.toast(errText(e), true) })
        } }, [
          h('span', { key: 'd', className: 'ds-hdate' }, d.label),
          h('span', { key: 't', className: 'ds-tag ds-tag-brand' }, d.dayType ? d.dayType.name : ''),
          h('span', { key: 'x', className: 'ds-grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.title || ''),
          d.changes ? h('span', { key: 'c', className: 'ds-note' }, '调整 ' + d.changes) : null,
        ])
      }))
    }

    // ---- 外壳 -------------------------------------------------------------------

    class Boundary extends Component {
      constructor(p) { super(p); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error: error } }
      componentDidCatch(error) { try { console.error('[dsh-daily-schedule] 渲染失败：', error) } catch (e) { /* 忽略 */ } }
      render() {
        if (this.state.error === null) return this.props.children
        return h('div', { className: 'ds-root' }, [
          h('div', { key: 'h', className: 'ds-h1' }, '每日日程'),
          h('div', { key: 'e', className: 'ds-error' }, '页面渲染出错：' + (this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)) + '（刷新页面通常能恢复）'),
        ])
      }
    }

    function nowItem(s) {
      var d = s.today
      if (!d || !d.items) return null
      for (var i = 0; i < d.items.length; i++) {
        var it = d.items[i]
        var a = toMin(it.start)
        var b = it.end === '24:00' ? 1440 : toMin(it.end)
        if (a <= s.now.minute && s.now.minute < b) return it
      }
      return null
    }

    function Section() {
      var [state, setState] = useState(null)
      var [error, setError] = useState('')
      var [tab, setTab] = useState('schedule')
      var [toast, setToast] = useState(null)
      var timer = useRef(null)
      var showToast = useCallback(function (text, isErr) {
        clearTimeout(timer.current)
        setToast({ text: text, err: !!isErr })
        timer.current = setTimeout(function () { setToast(null) }, isErr ? 6000 : 2400)
      }, [])
      var reload = useCallback(function () {
        return apiGet('/state').then(function (s) { setState(s); setError('') }, function (e) { setError(errText(e)) })
      }, [])
      useEffect(function () {
        reload()
        var t = setInterval(reload, 60000)
        return function () { clearInterval(t); clearTimeout(timer.current) }
      }, [])
      if (error && !state) {
        return h('div', { className: 'ds-root' }, [
          h('div', { key: 'h', className: 'ds-h1' }, '每日日程'),
          h('div', { key: 'e', className: 'ds-error' }, '连不上插件的宿主接口：' + error + '。刚装好的话重启一次 DSH。'),
        ])
      }
      if (!state) return h('div', { className: 'ds-root' }, h('div', { className: 'ds-note' }, '加载中…'))
      var cur = nowItem(state)
      var cfg = state.config
      var pill = !cfg.enabled
        ? h('span', { key: 'p', className: 'ds-pill' }, [h('span', { key: 'd', className: 'ds-dot' }), '已关闭'])
        : h('span', { key: 'p', className: 'ds-pill', title: cur ? cur.start + '–' + cur.end + ' ' + cur.activity + (cur.outfit || cur.outfitNote ? '\n穿着：' + [cur.outfit, cur.outfitNote].filter(Boolean).join('，') : '') : '' }, [
          h('span', { key: 'd', className: cx('ds-dot', cur && 'ds-dot-on') }),
          state.today ? state.today.dayType.name + (cur ? ' · ' + cur.activity : '') : '今天的日程还没生成',
        ])
      var tabs = [
        { id: 'schedule', label: '日程', icon: 'calendar' },
        { id: 'types', label: '日程类型', icon: 'layers' },
        { id: 'settings', label: '设置', icon: 'gear' },
        { id: 'history', label: '往期', icon: 'history' },
      ]
      var body
      if (tab === 'schedule') body = h(ScheduleTab, { state: state, reload: reload, toast: showToast })
      else if (tab === 'types') body = h(TypesTab, { state: state, onState: setState, toast: showToast })
      else if (tab === 'settings') body = h(SettingsTab, { state: state, onState: setState, toast: showToast })
      else body = h(HistoryTab, { toast: showToast, wardrobe: state.wardrobe && state.wardrobe.available ? state.wardrobe : null })
      return h('div', { className: 'ds-root' }, [
        h('div', { key: 'h', className: 'ds-head' }, [
          h('div', { key: 'l', className: 'ds-logo' }, h(Icon, { name: 'calendar', size: 18 })),
          h('div', { key: 't', className: 'ds-grow' }, [
            h('div', { key: 'a', className: 'ds-h1' }, cfg.characterName + '的每日日程'),
            h('div', { key: 'b', className: 'ds-sub' }, '每晚 ' + cfg.generateAt + ' 生成第二天的日程，把「此刻在做什么」带进每一次对话。'),
          ]),
          pill,
        ]),
        h('div', { key: 'tabs', className: 'ds-tabs', role: 'tablist' }, tabs.map(function (t) {
          return h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': tab === t.id, className: cx('ds-tab', tab === t.id && 'ds-tab-on'), onClick: function () { setTab(t.id) } }, [h(Icon, { key: 'i', name: t.icon, size: 14 }), t.label])
        })),
        h(React.Fragment, { key: 'b' }, body),
        toast ? h('div', { key: 'toast', className: cx('ds-toast', toast.err && 'ds-toast-err'), role: 'status' }, [h(Icon, { key: 'i', name: toast.err ? 'x' : 'check', size: 14 }), toast.text]) : null,
      ])
    }

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-daily-schedule-styles'
        var el = document.getElementById(id)
        if (el === null) {
          el = document.createElement('style')
          el.id = id
          el.setAttribute('data-plugin', 'dsh-daily-schedule')
          document.head.appendChild(el)
        }
        el.textContent = CSS
        return function () { var x = document.getElementById(id); if (x && x.parentNode) x.parentNode.removeChild(x) }
      }, 'dsh-daily-schedule: styles')
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({ name: 'settings.section', id: 'daily-schedule', order: 48, locale: NS, label: function () { return '每日日程' } },
          function (props) { return h(Boundary, null, h(Section, props || {})) })
      })
    }

    module.exports = {
      name: 'daily-schedule',
      inject: ['slots'],
      apply: apply,
      __test: { Section: Section, ScheduleTab: ScheduleTab, DayView: DayView, Timeline: Timeline, EditDay: EditDay, GeneratePanel: GeneratePanel, TypesTab: TypesTab, SettingsTab: SettingsTab, HistoryTab: HistoryTab, Boundary: Boundary, SessionOverrides: SessionOverrides, WearRow: WearRow, OutfitStrip: OutfitStrip, LinkPanel: LinkPanel, outfitRuns: outfitRuns, autoHer: autoHer, coverSrc: coverSrc },
    }
    return module.exports
  },
})
