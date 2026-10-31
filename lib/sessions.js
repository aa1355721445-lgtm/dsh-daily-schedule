/**
 * dsh-daily-schedule —— 分会话注入：哪些会话带上「她的日常」。
 *
 * 三种模式（config.inject.scope）：
 *   all      所有会话都注入（默认），单个会话里用 /life off 关掉；
 *   session  默认都不注入，只在用 /life on 打开的会话里注入；
 *   pick     只注入 config.inject.sessions 里列出的会话（设置页勾选）。
 * 子代理会话（header.origin === 'subagent' 或 delegationDepth > 0）始终不注入：它们是派出去干活的。
 *
 * 单个会话的开关记在 <DSH_HOME>/daily-schedule/sessions.json，不放进 config.json，
 * 免得设置页整份保存配置时把它覆盖掉。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { dataRoot } from './store.js'

export const SCOPES = ['all', 'session', 'pick']
const MAX_SESSIONS = 300

function file() { return path.join(dataRoot(), 'sessions.json') }

let cache = null
export function readSessions() {
  if (cache) return cache
  try {
    const raw = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { cache = {} }
  return cache
}

function save(map) {
  mkdirSync(path.dirname(file()), { recursive: true })
  const tmp = `${file()}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  renameSync(tmp, file())
  cache = map
}

/** 测试用。 */
export function clearSessionCache() { cache = null }

/**
 * 设置某个会话的开关。on = true / false；null = 删掉这条，回到模式默认。
 * @returns 新的整张表
 */
export function setSessionOverride(id, on, meta = {}) {
  const key = String(id || '').trim()
  if (!key) throw Object.assign(new Error('缺少会话 id'), { status: 400 })
  const map = { ...readSessions() }
  if (on === null || on === undefined) delete map[key]
  else {
    map[key] = {
      on: !!on,
      at: new Date().toISOString(),
      ...(meta.cwd ? { cwd: String(meta.cwd).slice(0, 300) } : {}),
      ...(meta.createdAt ? { createdAt: Number(meta.createdAt) || 0 } : {}),
    }
  }
  const keys = Object.keys(map)
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => String(map[a].at).localeCompare(String(map[b].at)))
    for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete map[k]
  }
  save(map)
  return map
}

export function scopeOf(cfg) {
  return cfg && cfg.inject && SCOPES.includes(cfg.inject.scope) ? cfg.inject.scope : 'all'
}

/** pick 模式下要注入的会话 id。 */
export function pickList(cfg) {
  const v = cfg && cfg.inject && cfg.inject.sessions
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '') : []
}

export function isSubagent(session) {
  const h = session && session.header
  return !!h && (h.origin === 'subagent' || Number(h.delegationDepth || 0) > 0)
}

/**
 * 这个会话该不该注入。
 * @returns {{ on: boolean, why: 'subagent'|'override'|'mode'|'global' }}
 */
export function sessionDecision(cfg, session) {
  if (!session) return { on: scopeOf(cfg) === 'all', why: 'global' }
  if (isSubagent(session)) return { on: false, why: 'subagent' }
  const o = readSessions()[String(session.id)]
  if (o && typeof o.on === 'boolean') return { on: o.on, why: 'override' }
  const scope = scopeOf(cfg)
  if (scope === 'pick') return { on: pickList(cfg).includes(String(session.id)), why: 'pick' }
  return { on: scope === 'all', why: 'mode' }
}

/** 从系统提示组装上下文里取出会话（DSH 的 AssembleContext 带着 agent.session）。 */
export function sessionFromAssembly(context) {
  try { return context && context.agent && context.agent.session ? context.agent.session : null } catch { return null }
}

const ON_WORDS = /^(on|open|enable|1|开|打开|开启|启用)$/i
const OFF_WORDS = /^(off|close|disable|0|关|关掉|关闭|停用)$/i
const AUTO_WORDS = /^(auto|default|reset|默认|自动|恢复)$/i

/**
 * /life 指令。
 * @param session 当前会话
 * @param rawInput 指令后面的文字
 * @param cfg 配置
 * @param now 用于状态文字（她此刻在做什么），可选
 * @returns {{ kind: 'success'|'error', text: string }}
 */
export function lifeCommand(session, rawInput, cfg, nowText = '') {
  const arg = String(rawInput || '').trim()
  const name = cfg.characterName || '她'
  const scope = scopeOf(cfg)
  const modeText = scope === 'all' ? '所有会话都注入（单个会话可以关掉）' : scope === 'pick' ? '只注入设置里挑的那几个会话' : '只在打开的会话里注入'
  if (!session) return { kind: 'error', text: '找不到当前会话。' }
  if (isSubagent(session)) return { kind: 'success', text: `这是子代理会话，始终不注入${name}的日常。` }
  if (ON_WORDS.test(arg)) {
    setSessionOverride(session.id, true, { cwd: session.header && session.header.cwd, createdAt: session.header && session.header.createdAt })
    return { kind: 'success', text: `这个会话打开了${name}的日常：之后的回复会按她此刻的状态来。${nowText ? `\n${nowText}` : ''}` }
  }
  if (OFF_WORDS.test(arg)) {
    setSessionOverride(session.id, false, { cwd: session.header && session.header.cwd, createdAt: session.header && session.header.createdAt })
    return { kind: 'success', text: `这个会话关掉了${name}的日常：之后不再带上她在做什么、穿什么，适合干正事。（已经说过的话还留在记录里，想完全干净就新开一个会话。）` }
  }
  if (AUTO_WORDS.test(arg)) {
    setSessionOverride(session.id, null)
    const d = sessionDecision(cfg, session)
    return { kind: 'success', text: `这个会话恢复默认（${modeText}）：现在${d.on ? '会' : '不会'}注入${name}的日常。` }
  }
  if (arg) return { kind: 'error', text: '用法：/life on 打开、/life off 关掉、/life auto 恢复默认、/life 查看状态。' }
  const d = sessionDecision(cfg, session)
  const why = d.why === 'override' ? '这个会话单独设置过' : `跟随默认：${modeText}`
  return { kind: 'success', text: `这个会话${d.on ? '正在' : '没有'}注入${name}的日常（${why}）。\n用法：/life on 打开、/life off 关掉、/life auto 恢复默认。` }
}
