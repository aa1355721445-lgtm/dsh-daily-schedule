/**
 * dsh-daily-schedule —— 用 DSH 自己的模型生成一天的日程。
 *
 * 喂给模型：人设（默认读 <DSH_HOME>/AGENT.md）、这一天的日程类型与框架、最近几天的日程摘要、
 * 用户的固定设定和这一天的要求；可选附上生图插件的情境关键词与场景名，让每段带上 situation。
 * 模型只输出 JSON；解析失败或调用失败时用类型模板兜底，保证这一天总有日程。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { linkItems, linkOn, wardrobePrompt } from './dress.js'
import { normalizeItems, pickDayType, templateItems } from './schedule.js'
import { dshHome, getConfig, readDay, writeDay } from './store.js'
import { addDays, dateLabel } from './time.js'
import { loadWardrobe } from './wardrobe.js'

function service(ctx, name) {
  try {
    const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    return v ?? ctx[name]
  } catch {
    return undefined
  }
}

/** 人设文本：custom 用设置里填的；否则读 AGENT.md（截断）。 */
export function personaText(cfg = getConfig()) {
  if (cfg.personaFrom === 'custom') return cfg.personaText.trim()
  try {
    const raw = readFileSync(path.join(dshHome(), 'AGENT.md'), 'utf8')
    return raw.replace(/\r/g, '').slice(0, 3500).trim()
  } catch {
    return cfg.personaText.trim()
  }
}

/** 可用的模型路由：[{ route: 'provider/model', name }]，默认选择排在第一。 */
export async function listModels(ctx) {
  const llm = service(ctx, 'llm')
  const out = []
  if (!llm || typeof llm.listProviders !== 'function') return { models: out, current: '' }
  for (const p of llm.listProviders() || []) {
    const pid = p && (p.id || p.provider)
    if (!pid) continue
    let models = []
    try { models = await llm.listModels(pid) } catch { continue }
    for (const m of models || []) if (m && m.id) out.push({ route: `${pid}/${m.id}`, name: m.name || m.id })
  }
  return { models: out, current: defaultRoute(ctx) }
}

export function defaultRoute(ctx) {
  try {
    const dm = service(ctx, 'agentDefaultModel')
    const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : null
    if (sel && sel.provider && sel.model) return `${sel.provider}/${sel.model}`
  } catch {}
  return ''
}

async function resolveRoute(ctx, cfg) {
  let route = cfg.model || defaultRoute(ctx)
  if (!route) {
    const { models } = await listModels(ctx)
    route = (models.find((m) => /flash/i.test(m.route)) || models[0] || {}).route || ''
  }
  const i = route.indexOf('/')
  if (i <= 0) throw new Error('没有可用的模型：到设置里选一个生成日程用的模型')
  return { provider: route.slice(0, i), model: route.slice(i + 1), route }
}

function recentSummary(date, n = 3) {
  const lines = []
  for (let i = n; i >= 1; i--) {
    const d = readDay(addDays(date, -i))
    if (!d) continue
    const main = d.items.filter((it) => it.activity !== '睡觉').slice(0, 8).map((it) => it.activity).join('、')
    const worn = [...new Set(d.items.map((it) => it.outfit).filter(Boolean))].join('、')
    const places = [...new Set(d.items.map((it) => it.scene).filter(Boolean))].join('、')
    lines.push(`- ${dateLabel(d.date)}（${d.dayType?.name || ''}）：${d.title || ''}${main ? `。做了：${main}` : ''}${worn ? `。穿过：${worn}` : ''}${places ? `。去过：${places}` : ''}`)
  }
  return lines.join('\n')
}

export function buildPrompt({ cfg, date, type, hint }) {
  const name = cfg.characterName
  const persona = personaText(cfg)
  const recent = recentSummary(date)
  const w = cfg.imageStudio ? loadWardrobe() : { available: false, situations: [] }
  const situations = w.available ? w.situations.map((s) => s.name) : []
  const wp = wardrobePrompt(cfg, w)
  const example = { start: '00:00', end: '07:30', activity: '睡觉', location: '家', ...wp.fields, detail: '', ...(situations.length ? { situation: '睡前' } : {}) }
  const lines = [
    `你在为角色「${name}」安排 ${dateLabel(date)} 这一整天的日程。这份日程会作为 ${name} 当天的生活背景，聊天时 ${name} 会按它知道自己此刻在做什么。`,
    persona ? `【人设】\n${persona}` : '',
    cfg.partnerName ? `【用户】${name} 称呼用户为「${cfg.partnerName}」。` : '',
    `【这一天的类型】${type.name}：${type.guide || '按这个类型合理安排。'}`,
    recent ? `【最近几天】\n${recent}\n这一天的安排、小插曲和穿搭不要和最近几天重复。` : '',
    wp.sections,
    cfg.extraRules.trim() ? `【固定设定】${cfg.extraRules.trim()}` : '',
    hint ? `【这一天的特别要求（优先满足）】${hint}` : '',
    '【要求】',
    '- 从 00:00 排到 24:00，时间连续、不重叠，24 小时制 HH:MM，最后一段的 end 写 24:00；一般 12–20 段。',
    '- 每段：activity 写在做什么（具体，10 字以内，例如「挤地铁去公司」「在茶水间偷吃饼干」）；location 写在哪；detail 写一两句当时的状态或小插曲（心情、吃了什么、碰到什么事、和谁在一起），让这一天有活人感。',
    `- 符合人设的性格和习惯，但别夸张成闹剧；睡觉时间合理。`,
    situations.length ? `- situation：从这些情境里挑最贴近的一个（${situations.join('、')}），都不贴近就留空。` : '',
    ...wp.rules,
    '只输出一个 JSON 对象，不要任何其他文字或代码块标记：',
    JSON.stringify({ title: '一句话概括这一天', mood: '这一天整体的心情', items: [example] }),
  ]
  return lines.filter(Boolean).join('\n')
}

export function parseSchedule(textOut) {
  let s = String(textOut ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error(`模型没有返回 JSON：${s.slice(0, 120)}`)
  let j
  try { j = JSON.parse(s.slice(a, b + 1)) } catch (e) { throw new Error(`日程 JSON 解析失败：${e.message}`) }
  const items = normalizeItems(j.items)
  if (items.length < 4) throw new Error('模型给的日程太短了')
  return {
    title: String(j.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    mood: String(j.mood ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    items,
  }
}

async function askModel(ctx, cfg, prompt, signal) {
  const llm = service(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 的模型服务不可用')
  const { provider, model, route } = await resolveRoute(ctx, cfg)
  let out = ''
  for await (const chunk of llm.stream({ provider, model, maxTokens: 8000, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], ...(signal ? { signal } : {}) })) {
    if (!chunk) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && out === '' && typeof chunk.block.text === 'string') out = chunk.block.text
    else if (chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind
      if (kind === 'error' || kind === 'aborted') {
        const f = chunk.reason.failure
        throw new Error(`模型（${route}）出错：${(f && (f.message || f.code)) || kind}`)
      }
    }
  }
  return { text: out, route }
}

/**
 * 生成并保存某一天的日程。
 * @param o { ctx, date, dayTypeId?, hint?, signal?, by: 'timer'|'ui'|'tool' }
 */
export async function generateDay(o) {
  const cfg = getConfig()
  const type = pickDayType(cfg.dayTypes, o.date, o.dayTypeId)
  const hint = String(o.hint || '').trim().slice(0, 500)
  const base = { date: o.date, dayType: { id: type.id, name: type.name }, hint, generatedAt: new Date().toISOString(), changes: [] }
  let day
  try {
    const { text, route } = await askModel(o.ctx, cfg, buildPrompt({ cfg, date: o.date, type, hint }), o.signal)
    const parsed = parseSchedule(text)
    day = { ...base, ...parsed, items: linkItems(parsed.items, cfg, { fill: true }), source: 'llm', model: route }
  } catch (e) {
    if (o.signal && o.signal.aborted) throw e
    if (o.fallback === false) throw e
    day = { ...base, title: `${type.name}`, mood: '', items: linkItems(templateItems(type), cfg, { fill: true }), source: 'template', model: '', error: String(e?.message || e) }
  }
  if (linkOn(cfg).outfits) day.dressedAt = new Date().toISOString()
  writeDay(day)
  return day
}

// ---- 给已有的日程补穿搭 / 场景 -------------------------------------------------

export function dressPrompt(cfg, day) {
  const w = loadWardrobe()
  const wp = wardrobePrompt(cfg, w)
  const items = day.items.map((it, i) => ({ i, time: `${it.start}-${it.end}`, activity: it.activity, location: it.location || '', detail: it.detail || '' }))
  return [
    `下面是角色「${cfg.characterName}」${dateLabel(day.date)} 已经定好的日程。活动不要改，只给每一段配上穿着${linkOn(cfg).scenes ? '和场景' : ''}。detail 里已经写了穿着的（比如「换了件卫衣」），按它来挑最接近的那套或写进 outfit_note。`,
    wp.sections,
    '【要求】',
    ...wp.rules,
    `【日程】\n${JSON.stringify(items)}`,
    '只输出一个 JSON 对象，不要任何其他文字或代码块标记：',
    JSON.stringify({ items: [{ i: 0, ...wp.fields }] }),
  ].filter(Boolean).join('\n')
}

/**
 * 给已有的一天补穿搭（不改活动）：先问模型，失败就按情境 / 场景规则补。
 * @param o { ctx, date, signal, llm: false = 只用规则 }
 */
export async function dressDay(o) {
  const cfg = getConfig()
  const day = readDay(o.date)
  if (!day) throw Object.assign(new Error('这一天还没有日程'), { status: 404 })
  let items = day.items.map((it) => ({ ...it }))
  // 重新搭配：先把原来的穿着清掉，整天重配
  if (o.reset) for (const it of items) { delete it.outfit; delete it.outfitNote }
  let via = 'rules'
  let error = ''
  if (o.llm !== false) {
    try {
      const { text, route } = await askModel(o.ctx, cfg, dressPrompt(cfg, { ...day, items }), o.signal)
      const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
      const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
      for (const x of Array.isArray(j.items) ? j.items : []) {
        const i = Number(x && x.i)
        if (!Number.isInteger(i) || !items[i]) continue
        const it = items[i]
        if (x.outfit) it.outfit = String(x.outfit).slice(0, 40)
        const note = x.outfit_note ?? x.outfitNote
        if (note) it.outfitNote = String(note).slice(0, 60)
        if (x.scene) it.scene = String(x.scene).slice(0, 40)
        if (Array.isArray(x.props)) it.props = x.props
        if (Array.isArray(x.with)) it.with = x.with
      }
      via = route
    } catch (e) {
      if (o.signal && o.signal.aborted) throw e
      error = String(e?.message || e)
    }
  }
  items = linkItems(items, cfg, { fill: true })
  const next = {
    ...day,
    items,
    dressedAt: new Date().toISOString(),
    changes: [...(Array.isArray(day.changes) ? day.changes : []), { at: new Date().toISOString(), by: 'dress', note: via === 'rules' ? `按衣柜规则${o.reset ? '重新搭配' : '补上穿搭'}${error ? `（模型没成功：${error.slice(0, 80)}）` : ''}` : `按衣柜${o.reset ? '重新搭配' : '补上穿搭'}（${via}）` }].slice(-30),
  }
  writeDay(next)
  return next
}
