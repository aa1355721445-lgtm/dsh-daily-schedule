/**
 * dsh-daily-schedule —— 时区与日期工具。所有「今天 / 现在」都按配置的时区算，
 * 日期用 'YYYY-MM-DD' 字符串，时刻用当天第几分钟（0–1440）。
 */
export const WEEKDAY = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export function systemTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }); return true } catch { return false }
}

const fmtCache = new Map()
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }))
  }
  return fmtCache.get(tz)
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** { date: 'YYYY-MM-DD', minute: 0–1439, weekday: 0–6, hh, mm } */
export function zonedNow(tz, now = new Date()) {
  const p = Object.fromEntries(formatter(tz).formatToParts(now).map((x) => [x.type, x.value]))
  const hour = Number(p.hour) % 24
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: hour * 60 + Number(p.minute),
    weekday: WD[p.weekday] ?? new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`).getUTCDay(),
  }
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function weekdayOf(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

export function isDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}

/** 'HH:MM' → 分钟；'24:00' → 1440；非法返回 null。 */
export function parseClock(s) {
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*$/.exec(String(s ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null
  return h * 60 + mi
}

export function clock(minute) {
  const m = Math.max(0, Math.min(1440, Math.round(minute)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function dateLabel(date) {
  const [, mo, d] = date.split('-')
  return `${Number(mo)}月${Number(d)}日 ${WEEKDAY[weekdayOf(date)]}`
}
