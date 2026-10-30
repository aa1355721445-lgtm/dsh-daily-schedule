/**
 * dsh-daily-schedule —— 定时生成与后台任务。
 *
 * 每分钟看一眼：
 *   - 今天还没有日程（刚装、电脑昨晚关机）→ 立刻生成今天的（模型失败就用模板兜底，保证有）；
 *   - 到了每晚的生成时间、明天还没有 → 生成明天的（失败 20 分钟后重试，第二天还没成就由上一条兜底）。
 */
import { hasOutfits, linkOn } from './dress.js'
import { dressDay, generateDay } from './generate.js'
import { getConfig, readDay, timeZoneOf } from './store.js'
import { addDays, parseClock, zonedNow } from './time.js'

export const status = { busy: [], lastError: '', lastErrorAt: '', lastRun: null }
const busy = new Set()
const retryAfter = new Map()
const dressTried = new Set()
const RETRY_MS = 20 * 60 * 1000

function syncBusy() { status.busy = [...busy] }

export async function ensureDay(ctx, date, { fallback = true, by = 'timer', hint = '', dayTypeId = '', signal, force = false } = {}) {
  if (busy.has(date)) throw Object.assign(new Error('这一天的日程正在生成'), { status: 409 })
  if (!force && readDay(date)) return readDay(date)
  busy.add(date)
  syncBusy()
  try {
    const day = await generateDay({ ctx, date, fallback, hint, dayTypeId, signal, by })
    status.lastRun = { date, at: new Date().toISOString(), source: day.source, by }
    if (day.source === 'template' && day.error) { status.lastError = day.error; status.lastErrorAt = new Date().toISOString() }
    retryAfter.delete(date)
    return day
  } catch (e) {
    status.lastError = String(e?.message || e)
    status.lastErrorAt = new Date().toISOString()
    retryAfter.set(date, Date.now() + RETRY_MS)
    throw e
  } finally {
    busy.delete(date)
    syncBusy()
  }
}

/** 一次检查；返回本次触发的动作（测试用）。 */
export async function tick(ctx, now = new Date()) {
  const cfg = getConfig()
  if (!cfg.enabled) return []
  const z = zonedNow(timeZoneOf(cfg), now)
  const done = []
  if (!readDay(z.date) && !busy.has(z.date)) {
    try { await ensureDay(ctx, z.date, { fallback: true, by: 'catch-up' }); done.push(`today:${z.date}`) } catch {}
  }
  const at = parseClock(cfg.generateAt)
  const tomorrow = addDays(z.date, 1)
  if (at !== null && z.minute >= at && !readDay(tomorrow) && !busy.has(tomorrow) && (retryAfter.get(tomorrow) || 0) <= Date.now()) {
    try { await ensureDay(ctx, tomorrow, { fallback: false, by: 'timer' }); done.push(`tomorrow:${tomorrow}`) } catch {}
  }
  // 联动生图库之前生成的日程没有穿搭：每天各补一次（每次启动最多试一次）
  if (linkOn(cfg).outfits) {
    for (const date of [z.date, tomorrow]) {
      const d = readDay(date)
      if (!d || hasOutfits(d) || d.dressedAt || busy.has(date) || dressTried.has(date)) continue
      dressTried.add(date)
      busy.add(date)
      syncBusy()
      try { await dressDay({ ctx, date }); done.push(`dress:${date}`) } catch (e) { status.lastError = String(e?.message || e); status.lastErrorAt = new Date().toISOString() } finally { busy.delete(date); syncBusy() }
    }
  }
  return done
}

/** 下一次「每晚生成」的本地时刻描述（给设置页看）。 */
export function nextRunLabel(cfg = getConfig(), now = new Date()) {
  const z = zonedNow(timeZoneOf(cfg), now)
  const at = parseClock(cfg.generateAt)
  const tomorrow = addDays(z.date, 1)
  if (readDay(tomorrow)) return `明天的日程已生成；下一次在明晚 ${cfg.generateAt}`
  if (z.minute >= at) return busy.has(tomorrow) ? '正在生成明天的日程' : `今晚 ${cfg.generateAt} 已过，会尽快生成明天的日程`
  return `今晚 ${cfg.generateAt} 生成明天的日程`
}

// ---- 设置页发起的生成 ----------------------------------------------------------

const jobs = new Map()
let seq = 0

export function startJob(ctx, date, opts) {
  return startTask(date, (signal) => ensureDay(ctx, date, { ...opts, force: true, fallback: false, by: 'ui', signal }))
}

export function startDressJob(ctx, date, opts = {}) {
  if (busy.has(date)) throw Object.assign(new Error('这一天的日程正在处理'), { status: 409 })
  return startTask(date, async (signal) => {
    busy.add(date)
    syncBusy()
    try { return await dressDay({ ctx, date, signal, reset: !!opts.reset }) } finally { busy.delete(date); syncBusy() }
  })
}

function startTask(date, fn) {
  const id = `job-${Date.now().toString(36)}-${++seq}`
  const ctrl = new AbortController()
  const job = { id, date, status: 'running', error: '', day: null, startedAt: Date.now(), ctrl }
  jobs.set(id, job)
  Promise.resolve().then(() => fn(ctrl.signal))
    .then((day) => { job.status = 'done'; job.day = day })
    .catch((e) => { job.status = 'failed'; job.error = ctrl.signal.aborted ? '已取消' : String(e?.message || e) })
    .finally(() => {
      job.finishedAt = Date.now()
      setTimeout(() => jobs.delete(id), 30 * 60 * 1000).unref?.()
    })
  return id
}

export function getJob(id) {
  const j = jobs.get(id)
  if (!j) return null
  const { ctrl, ...rest } = j
  return { ...rest, elapsedMs: (j.finishedAt || Date.now()) - j.startedAt }
}

export function cancelJob(id) { const j = jobs.get(id); if (j && j.status === 'running') j.ctrl.abort(new Error('已取消')) }
export function abortAll() { for (const j of jobs.values()) if (j.status === 'running') j.ctrl.abort(new Error('插件已卸载')) }
