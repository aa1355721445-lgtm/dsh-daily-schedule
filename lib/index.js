/**
 * dsh-daily-schedule —— 宿主半：每晚生成第二天的日程，把「今天」注入对话。
 *
 *   定时器      每分钟检查：今天没有日程就补；每晚到点生成明天的
 *   systemPrompt  注入日期、时间、此刻在做什么、接下来、明天的安排（按会话决定注不注，见 sessions.js）
 *   /life       在某个会话里打开 / 关掉注入
 *   schedule_view / schedule_adjust  角色自己查看、临时调整日程
 *   webServer   /api/daily-schedule/*，设置页「每日日程」用
 *
 * 只 import node: 内置模块与同目录文件。
 */
import { createHandler, API_PREFIX } from './http.js'
import { dayText, injectionText } from './inject.js'
import { abortAll, tick } from './runner.js'
import { linkItems } from './dress.js'
import { applyChange, findItem } from './schedule.js'
import { parseClock } from './time.js'
import { getConfig, loadConfig, readDay, timeZoneOf, writeDay } from './store.js'
import { lifeCommand, sessionDecision, sessionFromAssembly } from './sessions.js'
import { addDays, zonedNow } from './time.js'

export const name = 'daily-schedule'
export const inject = ['tools', 'systemPrompt', 'webServer']

const TEXT_OUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

function dateFor(which) {
  const today = zonedNow(timeZoneOf(getConfig())).date
  if (which === 'tomorrow') return addDays(today, 1)
  if (which === 'yesterday') return addDays(today, -1)
  return today
}

export function apply(ctx) {
  loadConfig()
  const logger = (() => {
    try { return typeof ctx.logger === 'function' ? ctx.logger('daily-schedule') : ctx.logger } catch { return null }
  })()
  const log = (level, msg) => { try { logger?.[level]?.(msg) } catch {} }
  const register = (def) => {
    try { return ctx.tools.register(def) } catch (error) {
      if (error instanceof Error && /already|duplicate|exists/i.test(error.message)) return () => {}
      throw error
    }
  }

  register({
    name: 'schedule_view',
    description: '回想自己某一天打算做什么、做过什么（今天 / 明天 / 昨天）。系统提示里只有此刻和接下来几件事，想知道全天或明天的细节时用。这是她自己记事用的，回复里别提到它，也别说「日程上…」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { day: { type: 'string', enum: ['today', 'tomorrow', 'yesterday'], description: '看哪一天，默认今天。' } },
    },
    output: TEXT_OUT,
    async execute(args) {
      const date = dateFor(args && args.day)
      return dayText(readDay(date))
    },
  })

  register({
    name: 'schedule_adjust',
    description: '她临时改主意时记一下：用新的一段覆盖某个时间段（原来的打算会被截断或拆开）。比如被约出去吃饭、突然想去散步、活干不完要加班、换了身衣服。只改真的变了的部分；没写 outfit / outfit_note 时沿用那个时间点原本的穿着。这是她给自己记事用的：回复里直接说她的决定（「那我不出门啦」），别说「我改一下日程 / 调整计划」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end', 'activity', 'reason'],
      properties: {
        day: { type: 'string', enum: ['today', 'tomorrow'], description: '改哪一天，默认今天。' },
        start: { type: 'string', description: '开始时间 HH:MM（24 小时制）。' },
        end: { type: 'string', description: '结束时间 HH:MM，24:00 表示到当天结束。' },
        activity: { type: 'string', description: '改成做什么（具体，10 字以内）。' },
        location: { type: 'string', description: '在哪。' },
        detail: { type: 'string', description: '一两句当时的状态或小插曲。' },
        situation: { type: 'string', description: '可选：对应的生图情境关键词。' },
        scene: { type: 'string', description: '可选：地点是生图场景库里的场景时填它的名字。' },
        outfit: { type: 'string', description: '可选：换了衣服就填衣柜（生图服饰库）里那套的名字。' },
        outfit_note: { type: 'string', description: '可选：衣柜里没有的穿着，或在那套基础上的变化（加了件外套之类）。' },
        reason: { type: 'string', description: '为什么改主意（例如「朋友约我吃火锅」）。' },
      },
    },
    output: TEXT_OUT,
    async execute(args) {
      const a = args && typeof args === 'object' ? args : {}
      const date = dateFor(a.day)
      const day = readDay(date)
      if (!day) return '这一天还没有日程，没法调整。'
      // 没说换衣服 / 换地方，就沿用那个时间点原本的穿着
      const at = parseClock(a.start)
      const was = at === null ? null : day.items[findItem(day, at)]
      const change = { ...a }
      if (was && !change.outfit && !change.outfit_note) {
        if (was.outfit) change.outfit = was.outfit
        if (was.outfitNote) change.outfit_note = was.outfitNote
      }
      const items = linkItems(applyChange(day.items, change), getConfig(), { fill: false })
      const note = `${a.start}–${a.end} 改成「${String(a.activity).slice(0, 40)}」：${String(a.reason || '').slice(0, 80)}`
      const next = { ...day, items, changes: [...(Array.isArray(day.changes) ? day.changes : []), { at: new Date().toISOString(), by: 'tool', note }].slice(-30) }
      writeDay(next)
      return `已记下：${note}\n回复里直接说她的决定和感受就好，别提「日程」「计划」「调整」。\n\n${dayText(next)}`
    },
  })

  ctx.effect(() => {
    try {
      return ctx.systemPrompt.context({
        name: 'daily-schedule:today',
        order: 260,
        // 按会话决定：子代理不注；模式 all 默认注、session 默认不注；/life on|off 单独覆盖
        text: (assembly) => {
          try {
            const cfg = getConfig()
            if (!sessionDecision(cfg, sessionFromAssembly(assembly)).on) return ''
            return injectionText(cfg)
          } catch { return '' }
        },
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) return () => {}
      throw error
    }
  }, 'dsh-daily-schedule: context')

  // /life 指令：放在只依赖 commands 的子插件里，没有指令服务时不影响其余功能
  try {
    ctx.plugin({
      name: 'daily-schedule-life-command',
      inject: ['commands'],
      apply(c) {
        c.effect(() => c.commands.register({
          name: 'life',
          description: `每日日程：在这个会话里打开 / 关掉${getConfig().characterName}的日常注入`,
          input: { hint: 'on 打开 / off 关掉 / auto 恢复默认；留空查看状态' },
          handler: (inv) => {
            const session = inv && inv.agent ? inv.agent.session : null
            const cfg = getConfig()
            let now = ''
            try { now = injectionText(cfg).split('\n').find((l) => l.startsWith('她正在：')) || '' } catch {}
            return lifeCommand(session, inv && inv.rawInput, cfg, now)
          },
        }), 'dsh-daily-schedule: /life')
      },
    })
  } catch (error) {
    log('warn', `/life 指令没注册上：${error?.message || error}`)
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: createHandler(ctx) })
    return () => { abortAll(); if (typeof dispose === 'function') dispose() }
  }, 'dsh-daily-schedule: http')

  ctx.effect(() => {
    let running = false
    const run = () => {
      if (running) return
      running = true
      tick(ctx).then((done) => { if (done.length) log('info', `日程：${done.join('，')}`) }, (e) => log('warn', `日程检查失败：${e?.message || e}`)).finally(() => { running = false })
    }
    const first = setTimeout(run, 15_000)
    const timer = setInterval(run, 60_000)
    first.unref?.()
    timer.unref?.()
    return () => { clearTimeout(first); clearInterval(timer) }
  }, 'dsh-daily-schedule: timer')

  const cfg = getConfig()
  log('info', `每日日程已加载：${cfg.enabled ? '开' : '关'} · ${cfg.characterName} · 每晚 ${cfg.generateAt} 生成 · ${timeZoneOf(cfg)}`)
}
