/**
 * dsh-daily-schedule —— 设置页用的同源接口（/api/daily-schedule/*）。
 */
import { DEFAULT_VOICE } from './voice.js'
import { readSessions, scopeOf, setSessionOverride } from './sessions.js'
import { defaultRoute, listModels, personaText } from './generate.js'
import { dayText, injectionText } from './inject.js'
import { hasOutfits } from './dress.js'
import { cancelJob, getJob, nextRunLabel, startDressJob, startJob, status } from './runner.js'
import { normalizeItems } from './schedule.js'
import { linkItems } from './dress.js'
import { readSessionTitle } from './titles.js'
import {
  DAY_SCOPES, DEFAULT_DAY_TYPES, PRECISIONS, SCOPE_LABEL, getConfig, listDays, readDay, timeZoneOf, updateConfig, writeDay,
} from './store.js'
import { addDays, dateLabel, isDateKey, systemTimeZone, zonedNow } from './time.js'
import { invalidateWardrobe, loadWardrobe, wardrobeSummary } from './wardrobe.js'

export const API_PREFIX = '/api/daily-schedule'
const MAX_BODY = 2 * 1024 * 1024

function sendJson(res, code, body) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes.length), 'cache-control': 'no-store' })
  res.end(bytes)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { req.destroy(); reject(Object.assign(new Error('请求太大'), { status: 413 })); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString('utf8')
        resolve(t.trim() === '' ? {} : JSON.parse(t))
      } catch (e) { reject(Object.assign(new Error(`请求体不是合法 JSON：${e.message}`), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s })

function resolveDate(v) {
  const cfg = getConfig()
  const today = zonedNow(timeZoneOf(cfg)).date
  if (v === 'today' || v === undefined || v === '') return today
  if (v === 'tomorrow') return addDays(today, 1)
  if (v === 'yesterday') return addDays(today, -1)
  if (isDateKey(v)) return v
  throw bad(`日期格式不对：${v}`)
}

function sessionsPayload(cfg) {
  const map = readSessions()
  const list = Object.entries(map).map(([id, v]) => ({ id, on: !!v.on, at: v.at || '', cwd: v.cwd || '', createdAt: v.createdAt || 0 }))
  list.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return { scope: scopeOf(cfg), overrides: list.slice(0, 100), total: list.length }
}

/** 设置页「挑会话」列出来的会话：最近 100 个顶层会话，跳过归档和没内容的空会话。 */
async function listSessionOptions(ctx) {
  const out = []
  const raw = []
  const seen = new Set()
  let archived = new Set()
  try {
    const reg = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
    const ids = reg && Array.isArray(reg.archivedSessionIds) ? reg.archivedSessionIds : []
    archived = new Set(ids.map((x) => String(x)))
  } catch { /* 没有归档表就当没归档 */ }
  const add = (h, live) => {
    if (raw.length >= 100) return
    const header = h && typeof h === 'object' ? h : {}
    const id = String(header.id || '').trim()
    if (!id || seen.has(id)) return
    if (header.origin === 'subagent' || Number(header.delegationDepth || 0) > 0) return
    if (archived.has(id)) return
    seen.add(id)
    const cwd = String(header.cwd || '').slice(0, 300)
    const title = readSessionTitle(id, header.cwd)
    raw.push({ id, title, cwd, live: !!live, createdAt: Number(header.createdAt) || 0 })
  }
  try {
    const q = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
    if (q && typeof q.listSessions === 'function') {
      for (const r of (await q.listSessions()) || []) add(r && r.header ? r.header : {}, r.live)
    }
  } catch { /* 没有会话查询服务时换活会话兜底 */ }
  if (!raw.length) {
    try {
      const s = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
      for (const sess of (s && typeof s.list === 'function' ? s.list() : [])) add(sess && sess.header ? sess.header : sess, true)
    } catch { /* 两路都没有就留空，设置页退化成手填 */ }
  }
  // 读不到标题的（多半是没有消息的空会话）不列；要是全都读不到，说明标题读取坏了，那就原样列出
  for (const x of raw) if (x.title) out.push(x)
  return out.length ? out : raw
}

function statePayload(ctx) {
  const cfg = getConfig()
  const tz = timeZoneOf(cfg)
  const z = zonedNow(tz)
  const tomorrow = addDays(z.date, 1)
  return {
    config: cfg,
    timeZone: tz,
    systemTimeZone: systemTimeZone(),
    now: { date: z.date, minute: z.minute, label: dateLabel(z.date) },
    today: readDay(z.date),
    tomorrow: readDay(tomorrow),
    dates: { today: z.date, tomorrow },
    status: { ...status, next: nextRunLabel(cfg) },
    preview: injectionText(cfg),
    personaPreview: personaText(cfg).slice(0, 600),
    defaultModel: defaultRoute(ctx),
    options: { scopes: DAY_SCOPES, scopeLabels: SCOPE_LABEL, precisions: PRECISIONS },
    wardrobe: wardrobeSummary(cfg, loadWardrobe()),
    dressed: { today: hasOutfits(readDay(z.date)), tomorrow: hasOutfits(readDay(tomorrow)) },
    defaults: { voice: DEFAULT_VOICE },
    sessions: sessionsPayload(cfg),
    build: 'v0.4.0',
  }
}

export function createHandler(ctx = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const q = url.searchParams
    const m = req.method
    try {
      if (route === '/state' && m === 'GET') {
        if (q.get('fresh') === '1') invalidateWardrobe()
        return sendJson(res, 200, statePayload(ctx))
      }
      if (route === '/session' && m === 'POST') {
        const body = await readBody(req)
        const on = body && (body.on === true || body.on === false) ? body.on : null
        setSessionOverride(body && body.id, on)
        return sendJson(res, 200, statePayload(ctx))
      }
      if (route === '/sessions' && m === 'GET') {
        return sendJson(res, 200, { sessions: await listSessionOptions(ctx) })
      }
      if (route === '/pick-dir' && m === 'POST') {
        req.resume() // 请求体用不上，先放掉，免得连接挂着
        const picker = ctx && typeof ctx.get === 'function' ? ctx.get('directoryPicker') : null
        const cap = picker && typeof picker.capability === 'function' ? picker.capability() : null
        if (!cap || cap.kind !== 'native' || typeof cap.pick !== 'function') {
          throw bad('这台机器上没有可用的目录选择器，直接把路径填进输入框就行', 501)
        }
        const picked = await cap.pick()
        return sendJson(res, 200, { path: typeof picked === 'string' && picked ? picked : '' })
      }
      if (route === '/persona-preview' && m === 'POST') {
        const body = await readBody(req)
        const base = getConfig()
        const from = body && (body.from === 'custom' || body.from === 'folder') ? body.from : 'agent-md'
        const want = body && Number(body.limit)
        const limit = Number.isFinite(want) ? Math.max(500, Math.min(20000, Math.round(want))) : base.personaLimit
        const cfg = {
          ...base,
          personaFrom: from,
          personaDir: body && typeof body.dir === 'string' ? body.dir.slice(0, 500) : base.personaDir,
          personaText: body && typeof body.text === 'string' ? body.text.slice(0, 8000) : base.personaText,
          personaLimit: limit,
        }
        const text = personaText(cfg)
        const rawLength = personaText({ ...cfg, personaLimit: 20000 }).length
        return sendJson(res, 200, { preview: text.slice(0, 1200), length: text.length, rawLength, limit })
      }
      if (route === '/dress' && m === 'POST') {
        const body = await readBody(req)
        const date = resolveDate(body.day ?? body.date)
        if (!readDay(date)) throw bad('这一天还没有日程', 404)
        return sendJson(res, 200, { jobId: startDressJob(ctx, date, { reset: body.reset === true }), date })
      }
      if (route === '/config' && m === 'POST') {
        const body = await readBody(req)
        const patch = body && typeof body === 'object' ? body : {}
        delete patch.dayTypes
        updateConfig(patch)
        return sendJson(res, 200, statePayload(ctx))
      }
      if (route === '/daytypes' && m === 'POST') {
        const body = await readBody(req)
        if (!Array.isArray(body.dayTypes)) throw bad('dayTypes 要是数组')
        updateConfig({ dayTypes: body.dayTypes })
        return sendJson(res, 200, statePayload(ctx))
      }
      if (route === '/daytypes/reset' && m === 'POST') {
        updateConfig({ dayTypes: DEFAULT_DAY_TYPES })
        return sendJson(res, 200, statePayload(ctx))
      }
      if (route === '/models' && m === 'GET') {
        return sendJson(res, 200, await listModels(ctx))
      }
      if (route === '/generate' && m === 'POST') {
        const body = await readBody(req)
        const date = resolveDate(body.day ?? body.date)
        return sendJson(res, 200, { jobId: startJob(ctx, date, { hint: body.hint, dayTypeId: body.dayTypeId }), date })
      }
      if (route === '/job' && m === 'GET') {
        const job = getJob(q.get('id') || '')
        if (!job) throw bad('任务不存在（可能已过期）', 404)
        return sendJson(res, 200, job)
      }
      if (route === '/job/cancel' && m === 'POST') {
        const body = await readBody(req)
        cancelJob(String(body.id))
        return sendJson(res, 200, { ok: true })
      }
      if (route === '/day' && m === 'GET') {
        const date = resolveDate(q.get('date') || 'today')
        return sendJson(res, 200, { date, day: readDay(date), text: dayText(readDay(date)) })
      }
      if (route === '/day' && m === 'POST') {
        const body = await readBody(req)
        const date = resolveDate(body.date)
        const prev = readDay(date)
        if (!prev) throw bad('这一天还没有日程，先生成一份再改', 404)
        const items = linkItems(normalizeItems(body.items), getConfig(), { fill: false })
        const next = {
          ...prev,
          title: String(body.title ?? prev.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
          mood: String(body.mood ?? prev.mood ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
          items,
          changes: [...(Array.isArray(prev.changes) ? prev.changes : []), { at: new Date().toISOString(), by: 'ui', note: '在设置页手动编辑' }].slice(-30),
        }
        writeDay(next)
        return sendJson(res, 200, { day: next })
      }
      if (route === '/days' && m === 'GET') {
        const limit = Math.min(90, Math.max(1, Number(q.get('limit') || 21) | 0))
        const days = listDays(limit).map((d) => ({ date: d.date, label: dateLabel(d.date), dayType: d.dayType, title: d.title, mood: d.mood, source: d.source, changes: Array.isArray(d.changes) ? d.changes.length : 0 }))
        return sendJson(res, 200, { days })
      }
      if (route === '/preview' && m === 'GET') {
        return sendJson(res, 200, { text: injectionText(getConfig()) })
      }
      return sendJson(res, 404, { error: `未知接口：${route}` })
    } catch (e) {
      const code = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 500
      return sendJson(res, code, { error: String(e?.message || e) })
    }
  }
}
