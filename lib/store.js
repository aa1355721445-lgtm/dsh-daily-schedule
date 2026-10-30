/**
 * dsh-daily-schedule —— 配置、日程类型与每日日程的存储。
 *
 * 数据都在 <DSH_HOME>/daily-schedule/：
 *   config.json        配置（含日程类型）
 *   days/YYYY-MM-DD.json  每天的日程
 *
 * 只 import node: 内置模块（本地 link 安装时裸包名解析不到宿主的包）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isDateKey, parseClock, systemTimeZone, validTimeZone } from './time.js'

export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh')
}
export function dataRoot() { return path.join(dshHome(), 'daily-schedule') }
export function daysDir() { return path.join(dataRoot(), 'days') }
export function configPath() { return path.join(dataRoot(), 'config.json') }

// ---- 日程类型 -----------------------------------------------------------------

export const DAY_SCOPES = ['weekday', 'weekend', 'any']
export const SCOPE_LABEL = { weekday: '工作日', weekend: '周末', any: '每天' }

export const DEFAULT_DAY_TYPES = [
  {
    id: 'workday', name: '上班日', enabled: true, weight: 5, days: 'weekday',
    guide: '常规上班日，两点一线：起床洗漱、通勤去上班，白天干活（帮用户处理任务、写代码，偶尔偷偷摸鱼），中午吃午饭，傍晚下班通勤回家，晚上吃饭、有一点自己的时间，然后睡觉。',
  },
  {
    id: 'restday', name: '休息日', enabled: true, weight: 4, days: 'weekend',
    guide: '不上班，以待在家里为主：睡个懒觉，在家收拾、打游戏或看剧，出门散散步，去附近的餐馆好好吃一顿，晚上在家放松。',
  },
  {
    id: 'outing', name: '外出日', enabled: true, weight: 2, days: 'weekend',
    guide: '出门玩一整天：逛街、看展、去公园或海边、找好吃的店，傍晚或晚上才回家，回家时有点累但很满足。',
  },
  {
    id: 'homebody', name: '宅家日', enabled: true, weight: 1, days: 'any',
    guide: '哪儿也不想去，几乎一整天窝在家：睡到中午，点外卖，追剧打游戏，作息有点乱，晚上反而精神。工作日遇到这种日子就是请了假。',
  },
  {
    id: 'overtime', name: '加班日', enabled: true, weight: 1, days: 'weekday',
    guide: '活多的一天：照常上班，但一直忙到很晚，午饭晚饭都随便对付，回家已经很累，倒头就睡。',
  },
  {
    id: 'slacking', name: '摸鱼日', enabled: true, weight: 1, days: 'weekday',
    guide: '名义上在上班，实际上一直找机会摸鱼：开小差、刷手机、去茶水间找零食、假装很忙，但下班前会把要紧的事赶完。',
  },
]

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const int = (v, min, max, d) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

export function normalizeDayTypes(list) {
  const src = Array.isArray(list) ? list : DEFAULT_DAY_TYPES
  const out = []
  const seen = new Set()
  for (const raw of src.slice(0, 30)) {
    if (!isObj(raw)) continue
    const name = str(raw.name, 20).trim()
    if (!name) continue
    let id = str(raw.id, 40).trim().replace(/[^\w-]/g, '') || `type-${out.length + 1}`
    while (seen.has(id)) id = `${id}-x`
    seen.add(id)
    out.push({
      id,
      name,
      enabled: raw.enabled !== false,
      weight: int(raw.weight, 0, 100, 1),
      days: DAY_SCOPES.includes(raw.days) ? raw.days : 'any',
      guide: str(raw.guide, 1000).trim(),
    })
  }
  return out
}

// ---- 配置 ---------------------------------------------------------------------

export const PRECISIONS = ['minute', 'halfhour', 'block']

export const DEFAULT_CONFIG = {
  enabled: true,
  characterName: '小鱼',
  partnerName: '',
  personaFrom: 'agent-md',
  personaText: '',
  extraRules: '',
  timeZone: '',
  generateAt: '22:00',
  model: '',
  inject: {
    enabled: true,
    precision: 'halfhour',
    tomorrowAfter: '18:00',
    upcoming: 3,
    voiceOn: true,
    voice: '', // 留空 = 用默认的说话方式（lib/voice.js）
  },
  imageStudio: true,
  imageCharacter: '',
  link: { outfits: true, scenes: true, props: true, people: true },
  dayTypes: DEFAULT_DAY_TYPES,
}

export function normalizeConfig(raw) {
  const d = DEFAULT_CONFIG
  const r = isObj(raw) ? raw : {}
  const inj = isObj(r.inject) ? r.inject : {}
  const link = isObj(r.link) ? r.link : {}
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt)
  const at = parseClock(r.generateAt) === null || parseClock(r.generateAt) >= 1440 ? d.generateAt : String(r.generateAt).trim().replace('：', ':').padStart(5, '0')
  const after = parseClock(inj.tomorrowAfter) === null ? d.inject.tomorrowAfter : String(inj.tomorrowAfter).trim().replace('：', ':').padStart(5, '0')
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    characterName: str(r.characterName, 30).trim() || d.characterName,
    partnerName: str(r.partnerName, 30).trim(),
    personaFrom: r.personaFrom === 'custom' ? 'custom' : 'agent-md',
    personaText: str(r.personaText, 8000),
    extraRules: str(r.extraRules, 3000),
    timeZone: validTimeZone(r.timeZone) ? String(r.timeZone).trim() : '',
    generateAt: at,
    model: str(r.model, 200).trim(),
    inject: {
      enabled: typeof inj.enabled === 'boolean' ? inj.enabled : d.inject.enabled,
      precision: PRECISIONS.includes(inj.precision) ? inj.precision : d.inject.precision,
      tomorrowAfter: after,
      upcoming: int(inj.upcoming, 0, 8, d.inject.upcoming),
      voiceOn: bool(inj.voiceOn, d.inject.voiceOn),
      voice: str(inj.voice, 4000),
    },
    imageStudio: typeof r.imageStudio === 'boolean' ? r.imageStudio : d.imageStudio,
    imageCharacter: str(r.imageCharacter, 120).trim(),
    link: {
      outfits: bool(link.outfits, d.link.outfits),
      scenes: bool(link.scenes, d.link.scenes),
      props: bool(link.props, d.link.props),
      people: bool(link.people, d.link.people),
    },
    dayTypes: normalizeDayTypes(r.dayTypes),
  }
}

function deepMerge(base, patch) {
  if (!isObj(patch)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v
  return out
}

let config = normalizeConfig({})
export function getConfig() { return config }
export function timeZoneOf(cfg = config) { return cfg.timeZone || systemTimeZone() }

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function loadConfig() {
  try { config = normalizeConfig(JSON.parse(readFileSync(configPath(), 'utf8'))) } catch {
    config = normalizeConfig({})
    try { if (!existsSync(configPath())) writeJson(configPath(), config) } catch {}
  }
  return config
}

export function updateConfig(patch) {
  const p = isObj(patch) ? { ...patch } : {}
  const merged = deepMerge(config, p)
  if (Array.isArray(p.dayTypes)) merged.dayTypes = p.dayTypes
  config = normalizeConfig(merged)
  writeJson(configPath(), config)
  return config
}

// ---- 每日日程 -----------------------------------------------------------------

function dayFile(date) {
  if (!isDateKey(date)) throw Object.assign(new Error(`日期格式不对：${date}`), { status: 400 })
  return path.join(daysDir(), `${date}.json`)
}

// 注入每轮都会读今天 / 明天，留一个短缓存；写入时同步更新
const dayCache = new Map()
const DAY_TTL_MS = 30_000

export function readDay(date) {
  const hit = dayCache.get(date)
  if (hit && Date.now() - hit.at < DAY_TTL_MS) return hit.day
  let day = null
  try { day = JSON.parse(readFileSync(dayFile(date), 'utf8')) } catch {}
  dayCache.set(date, { day, at: Date.now() })
  if (dayCache.size > 60) dayCache.delete(dayCache.keys().next().value)
  return day
}

export function writeDay(day) {
  writeJson(dayFile(day.date), day)
  dayCache.set(day.date, { day, at: Date.now() })
  return day
}

export function clearDayCache() { dayCache.clear() }

/** 最近的若干天（新的在前），只读摘要字段。 */
export function listDays(limit = 30) {
  let names = []
  try { names = readdirSync(daysDir()).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)) } catch { return [] }
  names.sort().reverse()
  return names.slice(0, limit).map((n) => readDay(n.slice(0, 10))).filter(Boolean)
}
