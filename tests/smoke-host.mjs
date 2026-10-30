// 宿主半冒烟测试：模拟 DSH ctx（tools / systemPrompt / webServer / llm / agentDefaultModel）。
// 用法：node tests/smoke-host.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-ds-'))
process.env.DSH_HOME = tmp
writeFileSync(path.join(tmp, 'AGENT.md'), '小鱼是一只贪吃又爱摸鱼的鲸鱼娘，职业是 AI 助手。', 'utf8')
mkdirSync(path.join(tmp, 'image-studio'), { recursive: true })
writeFileSync(path.join(tmp, 'image-studio', 'presets.json'), JSON.stringify({ situation: [{ name: '在家休息' }, { name: '工作学习' }] }), 'utf8')

// ---- 假模型 ----
const calls = []
let mode = 'ok'
function fakeDay(label) {
  return {
    title: `${label}的一天`, mood: '有点困',
    items: [
      { start: '00:00', end: '07:30', activity: '睡觉', location: '家', detail: '' },
      { start: '07:30', end: '08:15', activity: '起床洗漱', location: '家', detail: '赖床五分钟' },
      { start: '08:15', end: '09:00', activity: '挤地铁去公司', location: '地铁', detail: '' },
      { start: '09:00', end: '12:00', activity: '写代码', location: '公司', detail: '偷吃饼干', situation: '工作学习' },
      { start: '12:00', end: '13:00', activity: '吃午饭', location: '公司楼下', detail: '牛肉面' },
      { start: '13:00', end: '18:00', activity: '继续上班', location: '公司', detail: '' },
      { start: '18:00', end: '19:00', activity: '回家', location: '路上', detail: '' },
      { start: '19:00', end: '23:00', activity: '窝沙发看剧', location: '家', detail: '', situation: '在家休息' },
      { start: '23:00', end: '24:00', activity: '睡觉', location: '家', detail: '' },
    ],
  }
}
const llm = {
  listProviders: () => [{ id: 'opencode-go' }],
  listModels: async () => [{ provider: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'Flash' }, { provider: 'opencode-go', id: 'deepseek-v4-pro', name: 'Pro' }],
  stream: async function* (opts) {
    calls.push(opts)
    if (mode === 'error') { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }; return }
    if (mode === 'garbage') { yield { type: 'text-delta', index: 0, text: '今天天气不错' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const t = '```json\n' + JSON.stringify(fakeDay(calls.length)) + '\n```'
    yield { type: 'reasoning-delta', index: 0, text: '想一想……' }
    for (let i = 0; i < t.length; i += 50) yield { type: 'text-delta', index: 1, text: t.slice(i, i + 50) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const tools = new Map()
const contexts = []
const commands = new Map()
let handler = null
const ctx = {
  plugin(p) { p.apply({ commands: { register(def) { commands.set(def.name, def); return () => {} } }, effect(fn) { return fn() } }) },
  logger: () => ({ info() {}, warn() {} }),
  tools: { register(def) { tools.set(def.name, def); return () => {} } },
  systemPrompt: { context(c) { contexts.push(c); return () => {} } },
  webServer: { register(r) { handler = r.handler; return () => {} } },
  effect(fn) { const d = fn(); return d },
  get(n) { return n === 'llm' ? llm : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) } : undefined },
}

const store = await import('../lib/store.js')
const { tick } = await import('../lib/runner.js')
const { injectionText } = await import('../lib/inject.js')
const { pickDayType } = await import('../lib/schedule.js')
const plugin = await import('../lib/index.js')
plugin.apply(ctx)
assert.ok(tools.has('schedule_view') && tools.has('schedule_adjust'))
assert.equal(contexts.length, 1)
assert.ok(commands.has('life'), '/life registered')
assert.ok(existsSync(path.join(tmp, 'daily-schedule', 'config.json')))
store.updateConfig({ timeZone: 'Australia/Sydney', partnerName: '涛涛', extraRules: '住在悉尼的小公寓' })

// Sydney 2026-10-28（周三）09:30 = 2026-10-27T22:30Z
const at = (iso) => new Date(iso)
const WED_0930 = at('2026-10-27T22:30:00Z')
let done = await tick(ctx, WED_0930)
assert.deepEqual(done, ['today:2026-10-28'], 'catch-up today')
const p0 = calls[0]
assert.equal(p0.provider, 'opencode-go'); assert.equal(p0.model, 'deepseek-v4.1-flash')
const prompt0 = p0.messages[0].content[0].text
assert.match(prompt0, /10月28日 星期三/)
assert.match(prompt0, /贪吃又爱摸鱼/)
assert.match(prompt0, /称呼用户为「涛涛」/)
assert.match(prompt0, /住在悉尼的小公寓/)
assert.match(prompt0, /在家休息、工作学习/)
const wkType = store.readDay('2026-10-28').dayType.id
assert.ok(['workday', 'homebody', 'overtime', 'slacking'].includes(wkType), 'weekday type on Wednesday: ' + wkType)
console.log('--- prompt ---\n' + prompt0 + '\n--------------')

// 还没到 22:00：不生成明天
done = await tick(ctx, WED_0930)
assert.deepEqual(done, [])

// 注入：上午写代码
let t = injectionText(store.getConfig(), at('2026-10-27T23:47:00Z')) // 10:47
console.log('--- inject 10:47 ---\n' + t + '\n--------------')
assert.match(t, /现在：10月28日 星期三 约 10:30（Australia\/Sydney）/)
assert.match(t, /她正在：写代码（公司），从 09:00 到 12:00 左右——偷吃饼干/)
assert.match(t, /她待会儿想做：12:00 吃午饭/)
assert.match(t, /她今天早些时候：起床洗漱 → 挤地铁去公司/)
// 说话方式：默认注入，去掉「按日程」口吻
assert.match(t, /【怎么把这些带进聊天】/); assert.match(t, /不要说「按照日程」「按计划」/); assert.match(t, /涛涛问起时/)
assert.match(t, /回复里不要提到/); assert.match(t, /对方让你做正事.*认真把事做完/)
{
  const facts = t.split('【怎么把这些带进聊天】')[0]
  assert.ok(!/按计划|按照日程|日程上|安排表/.test(facts), 'facts themselves avoid schedule-speak')
}
assert.match(t, /situation 填「工作学习」/)
assert.ok(!/明天/.test(t.split('【怎么把这些带进聊天】')[0]))
// 半小时内文本稳定（缓存友好）
assert.equal(injectionText(store.getConfig(), at('2026-10-27T23:31:00Z')), injectionText(store.getConfig(), at('2026-10-27T23:59:00Z')))

// 22:10 生成明天（周四）；模型先失败 → 不写模板、记错误、20 分钟内不重试
mode = 'error'
const WED_2210 = at('2026-10-28T11:10:00Z')
done = await tick(ctx, WED_2210)
assert.deepEqual(done, [])
assert.equal(store.readDay('2026-10-29'), null, 'no template for tomorrow on failure')
const { status } = await import('../lib/runner.js')
assert.match(status.lastError, /rate limited/)
done = await tick(ctx, WED_2210)
assert.deepEqual(done, [], 'backoff')
mode = 'ok'

// 注入：晚上显示明天（先手动生成明天）
const runner = await import('../lib/runner.js')
await runner.ensureDay(ctx, '2026-10-29', { fallback: false, by: 'test', hint: '和涛涛去看海' })
assert.match(calls.at(-1).messages[0].content[0].text, /特别要求（优先满足）】和涛涛去看海/)
assert.match(calls.at(-1).messages[0].content[0].text, /【最近几天】[\s\S]*10月28日/)
t = injectionText(store.getConfig(), WED_2210)
assert.match(t, /明天（10月29日 星期四，/)
// 深夜睡觉
t = injectionText(store.getConfig(), at('2026-10-28T12:40:00Z')) // 23:40
assert.match(t, /她正在：睡觉（[^）]*），从 23:00 到 24:00 左右|她正在：睡觉，从 23:00 到 24:00 左右/)
assert.match(t, /被叫醒的话会迷迷糊糊/)

// 模型胡言乱语 → 今天兜底用模板（今天必须有）
mode = 'garbage'
const SAT_1000 = at('2026-10-30T23:00:00Z') // 周六 10:00
done = await tick(ctx, SAT_1000)
assert.deepEqual(done, ['today:2026-10-31'])
const sat = store.readDay('2026-10-31')
assert.equal(sat.source, 'template')
assert.ok(['restday', 'outing', 'homebody'].includes(sat.dayType.id), 'weekend type: ' + sat.dayType.id)
assert.match(sat.error, /没有返回 JSON/)
mode = 'ok'

// 日程类型挑选：关掉上班日
const types = store.getConfig().dayTypes.map((x) => (x.id === 'workday' ? { ...x, enabled: false } : x))
for (let i = 0; i < 50; i++) assert.notEqual(pickDayType(types, '2026-10-28').id, 'workday')
assert.equal(pickDayType(types, '2026-10-28', 'outing').id, 'outing')
assert.equal(pickDayType([], '2026-10-28').id, 'restday')

// 工具：调整 + 查看（工具按真实的「今天」）
const { zonedNow } = await import('../lib/time.js')
const realToday = zonedNow('Australia/Sydney').date
await runner.ensureDay(ctx, realToday, { fallback: false, by: 'test', force: true })
const adj = await tools.get('schedule_adjust').execute({ start: '19:00', end: '21:30', activity: '和涛涛吃火锅', location: '火锅店', reason: '涛涛约我' })
assert.match(adj, /已记下：19:00–21:30 改成「和涛涛吃火锅」/); assert.match(adj, /别提「日程」「计划」「调整」/)
const today = store.readDay(realToday)
assert.ok(today.items.some((x) => x.start === '19:00' && x.end === '21:30' && x.activity === '和涛涛吃火锅'))
assert.ok(today.items.some((x) => x.start === '21:30' && x.end === '23:00' && x.activity === '窝沙发看剧'))
assert.equal(today.changes.length, 1)
assert.match(await tools.get('schedule_view').execute({}), /和涛涛吃火锅/)
assert.match(await tools.get('schedule_adjust').execute({ start: '21:00', end: '20:00', activity: 'x', reason: 'y' }).catch((e) => e.message), /end 要晚于 start/)

// HTTP
const srv = http.createServer((q, r) => handler(q, r))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const B = `http://127.0.0.1:${srv.address().port}/api/daily-schedule`
const j = async (p, body) => { const r = await fetch(B + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
let r = await j('/state')
assert.equal(r.status, 200)
assert.equal(r.json.timeZone, 'Australia/Sydney')
assert.equal(r.json.defaultModel, 'opencode-go/deepseek-v4.1-flash')
assert.match(r.json.personaPreview, /鲸鱼娘/)
assert.equal(r.json.config.dayTypes.length, 6)
r = await j('/config', { generateAt: '23:15', inject: { precision: 'block' }, characterName: '大肥鱼' })
assert.equal(r.json.config.generateAt, '23:15')
assert.equal(r.json.config.inject.precision, 'block')
assert.equal(r.json.config.inject.tomorrowAfter, '18:00')
r = await j('/config', { generateAt: '25:99' })
assert.equal(r.json.config.generateAt, '22:00', 'invalid time falls back')
r = await j('/daytypes', { dayTypes: [{ name: '上班日', weight: 3, days: 'weekday' }, { name: '海边日', weight: 2, days: 'weekend', guide: '去海边' }] })
assert.deepEqual(r.json.config.dayTypes.map((x) => x.name), ['上班日', '海边日'])
r = await j('/daytypes/reset', {})
assert.equal(r.json.config.dayTypes.length, 6)
r = await j('/models')
assert.equal(r.json.models.length, 2)
r = await j('/generate', { day: '2026-11-02', dayTypeId: 'outing', hint: '去邦迪海滩' })
let job
for (let i = 0; i < 40; i++) { await new Promise((s) => setTimeout(s, 100)); job = (await j('/job?id=' + r.json.jobId)).json; if (job.status !== 'running') break }
assert.equal(job.status, 'done', JSON.stringify(job))
assert.equal(job.day.dayType.id, 'outing')
r = await j('/day?date=2026-11-02')
assert.match(r.json.text, /外出日/)
const items = r.json.day.items.map((x) => (x.activity === '吃午饭' ? { ...x, activity: '海边吃炸鱼薯条' } : x))
r = await j('/day', { date: '2026-11-02', items, title: '去海边' })
assert.equal(r.json.day.title, '去海边')
assert.ok(r.json.day.items.some((x) => x.activity === '海边吃炸鱼薯条'))
r = await j('/day', { date: '2030-01-01', items })
assert.equal(r.status, 404)
r = await j('/days')
assert.ok(r.json.days.length >= 4)
assert.equal(r.json.days[0].date, '2026-11-02')

// ---- 说话方式：可关、可自定义（占位符）、留空用默认 ----
{
  const { DEFAULT_VOICE, voiceText } = await import('../lib/voice.js')
  const base = store.getConfig()
  const noon = at('2026-10-28T01:10:00Z')
  let st = await (await fetch(B + '/state')).json()
  assert.equal(st.defaults.voice, DEFAULT_VOICE); assert.equal(st.config.inject.voiceOn, true); assert.equal(st.config.inject.voice, '')
  store.updateConfig({ inject: { voiceOn: false } })
  let tt = injectionText(store.getConfig(), noon)
  assert.ok(!/【怎么把这些带进聊天】/.test(tt)); assert.match(tt, /schedule_adjust 记一下/, 'tool line stays')
  store.updateConfig({ inject: { voiceOn: true, voice: '【口吻】{角色名}说话软软的，叫对方{称呼}。' }, partnerName: '' })
  tt = injectionText(store.getConfig(), noon)
  assert.match(tt, new RegExp('【口吻】' + store.getConfig().characterName + '说话软软的，叫对方对方。')); assert.ok(!/【怎么把这些带进聊天】/.test(tt))
  store.updateConfig({ inject: { voice: '' }, partnerName: base.partnerName })
  assert.equal(voiceText(store.getConfig()), DEFAULT_VOICE.replace(/\{角色名\}/g, store.getConfig().characterName).replace(/\{称呼\}/g, base.partnerName || '对方'))
  // schedule_view 也提醒别说「日程上」
  const view = await tools.get('schedule_view').execute({ day: 'today' })
  assert.match(String(view), /别提「日程」「计划」/)
}

// ---- 分会话注入：子代理不注；all 模式下 /life off 单独关；session 模式下 /life on 单独开 ----
{
  const { clearSessionCache } = await import('../lib/sessions.js')
  const sess = (id, header = {}) => ({ id, header })
  const asm = (session) => (session ? { agent: { session } } : {})
  const inj = (session) => contexts[0].text(asm(session))
  const life = (session, rawInput) => commands.get('life').handler({ agent: { session }, rawInput })
  const S1 = sess('sess-aaaa-1111', { cwd: 'C:\\work\\proj' }); const S2 = sess('sess-bbbb-2222'); const SUB = sess('sess-sub', { origin: 'subagent', delegationDepth: 1 })
  assert.equal(store.getConfig().inject.scope, 'all')
  assert.match(inj(null), /此刻的生活/); assert.match(inj(S1), /此刻的生活/); assert.equal(inj(SUB), '', 'subagent never')
  let out = life(S1, '')
  assert.equal(out.kind, 'success'); assert.match(out.text, /正在注入/); assert.match(out.text, /跟随默认：所有会话都注入/)
  out = life(S1, 'off')
  assert.match(out.text, /关掉了.*的日常/); assert.equal(inj(S1), ''); assert.match(inj(S2), /此刻的生活/)
  assert.match(life(S1, '').text, /没有注入.*单独设置过/)
  assert.match(life(SUB, 'on').text, /子代理会话，始终不注入/); assert.equal(inj(SUB), '')
  assert.equal(life(S1, 'banana').kind, 'error')
  // 切到「只在打开的会话」
  r = await j('/config', { inject: { scope: 'session' } })
  assert.equal(r.json.config.inject.scope, 'session')
  assert.equal(inj(S2), ''); assert.equal(inj(null), ''); assert.equal(inj(S1), '')
  out = life(S2, '开')
  assert.match(out.text, /打开了/); assert.match(inj(S2), /此刻的生活/)
  assert.match(life(S1, 'auto').text, /恢复默认（只在打开的会话里注入）：现在不会注入/); assert.equal(inj(S1), '')
  // HTTP：列出单独设置过的会话，能一键恢复默认；重启后还在（读文件）
  r = await j('/state')
  assert.equal(r.json.sessions.scope, 'session'); assert.deepEqual(r.json.sessions.overrides.map((o) => [o.id, o.on]), [['sess-bbbb-2222', true]])
  clearSessionCache(); assert.match(inj(S2), /此刻的生活/)
  r = await j('/session', { id: 'sess-bbbb-2222', on: null })
  assert.equal(r.json.sessions.total, 0); assert.equal(inj(S2), '')
  assert.equal((await j('/session', { on: true })).status, 400)
  store.updateConfig({ inject: { scope: 'all' } })
  assert.match(inj(S2), /此刻的生活/)
}

srv.close()
console.log('ALL HOST TESTS PASSED')
