/**
 * dsh-daily-schedule —— 设置页用的同源接口（/api/daily-schedule/*）。
 */
import { DEFAULT_VOICE } from './voice.js'
import { defaultRoute, listModels, personaText } from './generate.js'
import { dayText, injectionText } from './inject.js'
import { hasOutfits } from './dress.js'
import { cancelJob, getJob, nextRunLabel, startDressJob, startJob, status } from './runner.js'
import { normalizeItems } from './schedule.js'
import { linkItems } from './dress.js'
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
    build: 'v0.3.0',
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
