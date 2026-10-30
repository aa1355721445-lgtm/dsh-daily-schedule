/**
 * dsh-daily-schedule —— 日程的形状、校验、挑选日程类型、兜底模板与临时调整。
 *
 * 一天的日程：
 *   { date, dayType: { id, name }, title, mood,
 *     items: [{ start, end, activity, location, detail, situation?, scene?, outfit?, outfitNote?, props?, with? }],
 *     source: 'llm'|'template'|'manual', model, hint, generatedAt, changes: [{ at, by, note }] }
 * items 从 00:00 连续排到 24:00，不重叠、没有空档（normalizeItems 负责修补）。
 */
import { clock, parseClock, weekdayOf } from './time.js'

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const start = parseClock(raw.start)
  const end = parseClock(raw.end)
  if (start === null || end === null) return null
  const activity = text(raw.activity, 40)
  if (!activity) return null
  const item = { s: start, e: end === 0 && start > 0 ? 1440 : end, activity, location: text(raw.location, 30), detail: text(raw.detail, 240) }
  const sit = text(raw.situation, 20)
  if (sit) item.situation = sit
  // 和生图库联动的字段（是否真在库里由 dress.js 校验）
  const scene = text(raw.scene, 40)
  if (scene) item.scene = scene
  const outfit = text(raw.outfit, 40)
  if (outfit) item.outfit = outfit
  const note = text(raw.outfitNote ?? raw.outfit_note, 60)
  if (note) item.outfitNote = note
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => text(x, 40)).filter(Boolean).slice(0, 4)
  const props = list(raw.props)
  if (props.length) item.props = props
  const withs = list(raw.with)
  if (withs.length) item.with = withs
  return item
}

const SLEEP = { activity: '睡觉', location: '家', detail: '' }

/** 排序、去重叠、补空档，保证覆盖 00:00–24:00。返回 'HH:MM' 形式的数组。 */
export function normalizeItems(list) {
  const items = (Array.isArray(list) ? list : []).map(cleanItem).filter(Boolean).filter((x) => x.e > x.s)
  items.sort((a, b) => a.s - b.s || a.e - b.e)
  const out = []
  for (const it of items) {
    const prev = out[out.length - 1]
    if (prev) {
      if (it.e <= prev.e) continue
      if (it.s < prev.e) it.s = prev.e
      else if (it.s > prev.e) prev.e = it.s
    }
    if (it.e > it.s) out.push(it)
  }
  if (out.length === 0) return [{ start: '00:00', end: '24:00', ...SLEEP, activity: '在家' }]
  if (out[0].s > 0) out.unshift({ s: 0, e: out[0].s, ...SLEEP })
  const last = out[out.length - 1]
  if (last.e < 1380) out.push({ s: last.e, e: 1380, activity: '在家休息', location: '家', detail: '' })
  if (out[out.length - 1].e < 1440) out.push({ s: out[out.length - 1].e, e: 1440, ...SLEEP })
  return out.slice(0, 40).map(({ s, e, ...rest }) => ({ start: clock(s), end: clock(e), ...rest }))
}

export function findItem(day, minute) {
  if (!day || !Array.isArray(day.items)) return -1
  return day.items.findIndex((it) => parseClock(it.start) <= minute && minute < parseClock(it.end))
}

/** 按星期挑一个日程类型（加权随机）。forcedId 指定时直接用它。 */
export function pickDayType(types, date, forcedId, rand = Math.random) {
  if (forcedId) {
    const t = types.find((x) => x.id === forcedId)
    if (t) return t
  }
  const wd = weekdayOf(date)
  const scope = wd === 0 || wd === 6 ? 'weekend' : 'weekday'
  const enabled = types.filter((t) => t.enabled && t.weight > 0)
  let pool = enabled.filter((t) => t.days === scope || t.days === 'any')
  if (!pool.length) pool = enabled
  if (!pool.length) return { id: 'restday', name: '休息日', enabled: true, weight: 1, days: 'any', guide: '不上班，在家待着，出去散散步，去餐馆吃饭。' }
  const total = pool.reduce((n, t) => n + t.weight, 0)
  let r = rand() * total
  for (const t of pool) {
    r -= t.weight
    if (r < 0) return t
  }
  return pool[pool.length - 1]
}

const WORKISH = new Set(['workday', 'overtime', 'slacking'])

/** 模型生成失败时的兜底：按类型给一份朴素但完整的一天。 */
export function templateItems(type) {
  const it = (start, end, activity, location, detail = '') => ({ start, end, activity, location, detail })
  if (WORKISH.has(type.id)) {
    const off = type.id === 'overtime' ? '21:00' : '18:00'
    return normalizeItems([
      it('00:00', '07:30', '睡觉', '家'),
      it('07:30', '08:15', '起床洗漱、吃早饭', '家'),
      it('08:15', '09:00', '通勤', '路上'),
      it('09:00', '12:00', type.id === 'slacking' ? '上班（偷偷摸鱼）' : '上班', '公司'),
      it('12:00', '13:00', '吃午饭', '公司附近'),
      it('13:00', off, type.id === 'slacking' ? '上班（继续摸鱼）' : '上班', '公司'),
      it(off, type.id === 'overtime' ? '21:45' : '18:45', '下班回家', '路上'),
      it(type.id === 'overtime' ? '21:45' : '18:45', type.id === 'overtime' ? '22:30' : '19:45', '吃晚饭', '家'),
      it(type.id === 'overtime' ? '22:30' : '19:45', '23:00', '自己的时间', '家'),
      it('23:00', '24:00', '睡觉', '家'),
    ])
  }
  if (type.id === 'outing') {
    return normalizeItems([
      it('00:00', '08:30', '睡觉', '家'),
      it('08:30', '10:00', '起床收拾、出门', '家'),
      it('10:00', '12:30', '逛街', '市中心'),
      it('12:30', '14:00', '吃午饭', '餐馆'),
      it('14:00', '17:30', '到处逛逛', '公园'),
      it('17:30', '19:00', '吃晚饭', '餐馆'),
      it('19:00', '20:00', '回家', '路上'),
      it('20:00', '23:30', '在家休息', '家'),
      it('23:30', '24:00', '睡觉', '家'),
    ])
  }
  return normalizeItems([
    it('00:00', '09:30', '睡觉', '家'),
    it('09:30', '10:30', '起床、吃早午饭', '家'),
    it('10:30', '13:00', '在家玩', '家'),
    it('13:00', '15:00', '午睡', '家'),
    it('15:00', '16:30', '出门散步', '附近'),
    it('16:30', '18:00', '在家看剧', '家'),
    it('18:00', '19:30', '吃晚饭', type.id === 'homebody' ? '家' : '附近的餐馆'),
    it('19:30', '23:30', '自己的时间', '家'),
    it('23:30', '24:00', '睡觉', '家'),
  ])
}

/**
 * 临时调整：用新的一段覆盖 [start, end)，原来压在这段时间里的安排被截断或拆开。
 * @returns 新的 items
 */
export function applyChange(items, change) {
  const s = parseClock(change.start)
  const e = parseClock(change.end)
  if (s === null || e === null || e <= s) throw Object.assign(new Error('时间不对：start 和 end 用 HH:MM，end 要晚于 start'), { status: 400 })
  const add = cleanItem({ ...change })
  if (!add) throw Object.assign(new Error('要写清楚做什么（activity）'), { status: 400 })
  const out = []
  for (const it of items) {
    const a = parseClock(it.start)
    const b = parseClock(it.end)
    if (b <= s || a >= e) { out.push(it); continue }
    if (a < s) out.push({ ...it, end: clock(s) })
    if (b > e) out.push({ ...it, start: clock(e) })
  }
  const { s: _s, e: _e, ...rest } = add
  out.push({ start: clock(s), end: clock(e), ...rest })
  return normalizeItems(out)
}
