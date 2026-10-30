/**
 * dsh-daily-schedule —— 注入给对话模型的「今天」：日期、时间、此刻在做什么、接下来、
 * 早些时候做过什么，傍晚以后附上明天的安排；最后是「说话方式」（lib/voice.js），
 * 让模型把这些当成她自己的生活来说，不说「按照日程…」。
 *
 * 文本只在时段切换（或按设置每半小时）时才变，宿主只在内容变化时追加系统提示，
 * 不会每轮都打断提示词缓存。精确到分钟的时钟由 DSH 自带的 time-context 提供。
 */
import { linkOn, outfitLabel, outfitRuns } from './dress.js'
import { findItem } from './schedule.js'
import { herEntry, loadWardrobe } from './wardrobe.js'
import { getConfig, readDay, timeZoneOf } from './store.js'
import { addDays, clock, dateLabel, parseClock, zonedNow } from './time.js'
import { TOOL_LINE, voiceText } from './voice.js'

const safe = (s) => String(s).replace(/\{\{/g, '{').replace(/\}\}/g, '}')
const isSleep = (it) => /睡/.test(it.activity)

function timeLabel(precision, minute) {
  if (precision === 'minute') return clock(minute)
  if (precision === 'halfhour') return `约 ${clock(Math.floor(minute / 30) * 30)}`
  return ''
}

function placeOf(it) {
  const place = it.scene || it.location
  return place ? `（${place}）` : ''
}

/** schedule_view 里用的完整一行。 */
function line(it) {
  return `${it.start}–${it.end} ${it.activity}${placeOf(it)}`
}

function runText(runs) {
  return runs.map((r, i) => (i === 0 ? r.label : `${r.start} 起${r.label}`)).join(' → ')
}

export function injectionText(cfg = getConfig(), now = new Date()) {
  if (!cfg.enabled || !cfg.inject.enabled) return ''
  const tz = timeZoneOf(cfg)
  const z = zonedNow(tz, now)
  const name = cfg.characterName
  const out = [`# ${name}此刻的生活（背景，别在回复里提到这段说明本身）`]
  const t = timeLabel(cfg.inject.precision, z.minute)
  out.push(`现在：${dateLabel(z.date)}${t ? ` ${t}` : ''}（${tz}）`)
  const voice = voiceText(cfg)
  const today = readDay(z.date)
  if (!today || !Array.isArray(today.items) || !today.items.length) {
    out.push('她今天过得怎样还没想好，按常理推断她此刻在做什么。')
    if (voice) out.push(voice)
    return safe(out.join('\n'))
  }
  out.push(`今天：${today.dayType?.name || '普通的一天'}${today.title ? `——${today.title}` : ''}${today.mood ? `（心情：${today.mood}）` : ''}`)
  const i = findItem(today, z.minute)
  const cur = today.items[i]
  if (cur) {
    out.push(`她正在：${cur.activity}${placeOf(cur)}，从 ${cur.start} 到 ${cur.end} 左右${cur.detail ? `——${cur.detail}` : ''}`)
    const worn = outfitLabel(cur)
    const extra = [worn ? `身上穿着${worn}` : '', cur.props && cur.props.length ? `手边有${cur.props.join('、')}` : '', cur.with && cur.with.length ? `和${cur.with.join('、')}在一起` : ''].filter(Boolean)
    if (extra.length) out.push(`她${extra.join('，')}。`)
    if (isSleep(cur)) out.push(`${name}这会儿睡着了，被叫醒的话会迷迷糊糊、想接着睡，回复短、带着困意。`)
  }
  const next = today.items.slice(i + 1, i + 1 + cfg.inject.upcoming)
  if (next.length) out.push(`她待会儿想做：${next.map((it) => `${it.start} ${it.activity}${placeOf(it)}`).join('；')}`)
  const past = today.items.slice(0, Math.max(0, i)).filter((it) => !isSleep(it)).slice(-5)
  if (past.length) out.push(`她今天早些时候：${past.map((it) => it.activity).join(' → ')}`)
  const runs = outfitRuns({ items: today.items.slice(0, i + 1) })
  if (runs.length > 1) out.push(`她今天换过的衣服：${runText(runs)}`)
  const after = parseClock(cfg.inject.tomorrowAfter)
  if (after !== null && z.minute >= after) {
    const tomorrow = readDay(addDays(z.date, 1))
    if (tomorrow && Array.isArray(tomorrow.items)) {
      const main = tomorrow.items.filter((it) => !isSleep(it)).slice(0, 5).map((it) => it.activity).join('、')
      const firstOut = tomorrow.items.find((it) => !isSleep(it) && it.outfit)
      out.push(`明天（${dateLabel(tomorrow.date)}，${tomorrow.dayType?.name || ''}）她打算：${tomorrow.title || ''}${main ? `。想做的事：${main}` : ''}${firstOut ? `。想穿「${firstOut.outfit}」` : ''}`)
    }
  }
  if (voice) out.push(voice)
  out.push(TOOL_LINE)
  if (cfg.imageStudio && cur) {
    out.push(imageLine(cfg, cur))
  }
  return safe(out.join('\n'))
}

/** schedule_view 的文本。 */
export function dayText(day, cfg = getConfig()) {
  if (!day) return '这一天还没有日程。'
  const lines = [`${dateLabel(day.date)} · ${day.dayType?.name || ''}${day.title ? ` · ${day.title}` : ''}${day.mood ? `（心情：${day.mood}）` : ''}`]
  for (const it of day.items) {
    const tags = [it.situation ? `情境：${it.situation}` : '', outfitLabel(it) ? `穿着：${outfitLabel(it)}` : '', it.props && it.props.length ? `物品：${it.props.join('、')}` : '', it.with && it.with.length ? `和：${it.with.join('、')}` : ''].filter(Boolean)
    lines.push(`- ${line(it)}${it.detail ? `：${it.detail}` : ''}${tags.length ? ` [${tags.join('；')}]` : ''}`)
  }
  if (Array.isArray(day.changes) && day.changes.length) lines.push(`临时改过 ${day.changes.length} 次主意：${day.changes.slice(-3).map((c) => c.note).join('；')}`)
  lines.push('（这是她自己记着的打算。跟人说起时用自己的话挑着说，别提「日程」「计划」，也别报时间段。）')
  return safe(lines.join('\n'))
}

/** 生图时该填的参数：画的是她此刻的样子，就照日程填。 */
function imageLine(cfg, cur) {
  const on = linkOn(cfg)
  let her = null
  try { her = herEntry(cfg, loadWardrobe()) } catch {}
  const parts = []
  if (her) parts.push(`characters 填「${her.name}」`)
  if (on.outfits && cur.outfit) parts.push(`outfits 填「${cur.outfit}」${cur.outfitNote ? `，prompt 里写上「${cur.outfitNote}」` : ''}`)
  else if (on.outfits && cur.outfitNote) parts.push(`outfits 留空，prompt 里写明穿着${cur.outfitNote}`)
  if (on.scenes && cur.scene) parts.push(`scene 填「${cur.scene}」`)
  if (cur.situation) parts.push(`situation 填「${cur.situation}」`)
  if (on.props && cur.props && cur.props.length) parts.push(`props 可以加「${cur.props.join('、')}」`)
  if (!parts.length) return '生图（image_generate）画她此刻的样子时，地点、穿着和情境以她此刻的状态为准。'
  return `生图（image_generate）画她此刻的样子时：${parts.join('；')}。画别的时间、别的地方就按画面来。`
}
