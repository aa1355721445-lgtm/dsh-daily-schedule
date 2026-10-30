// 浏览器半冒烟测试：用宿主半造出真实形状的 state，把设置页每个页签 / 状态渲染一遍。
// 用法：node tests/smoke-client.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import FakeReact, { render } from './fake-react.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-dsc-'))
process.env.DSH_HOME = tmp
writeFileSync(path.join(tmp, 'AGENT.md'), '小鱼：贪吃的鲸鱼娘。', 'utf8')

const store = await import('../lib/store.js')
const { createHandler } = await import('../lib/http.js')
const { normalizeItems } = await import('../lib/schedule.js')
const { zonedNow, addDays } = await import('../lib/time.js')
store.loadConfig()
store.updateConfig({ timeZone: 'Australia/Sydney' })
const today = zonedNow('Australia/Sydney').date
store.writeDay({ date: today, dayType: { id: 'workday', name: '上班日' }, title: '普通的周二', mood: '想摸鱼', source: 'llm', model: 'x/y', hint: '', changes: [{ at: 'x', by: 'tool', note: '19:00–21:00 改成「吃火锅」' }],
  items: normalizeItems([{ start: '00:00', end: '08:00', activity: '睡觉' }, { start: '08:00', end: '12:00', activity: '上班', location: '公司', detail: '偷吃饼干', situation: '工作学习' }, { start: '12:00', end: '24:00', activity: '下班后的时间', location: '家' }]) })
const ctx = { get: (n) => (n === 'llm' ? { listProviders: () => [{ id: 'p' }], listModels: async () => [{ provider: 'p', id: 'flash', name: 'F' }] } : undefined) }
const srv = http.createServer(createHandler(ctx))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const B = `http://127.0.0.1:${srv.address().port}/api/daily-schedule`
const state = await (await fetch(B + '/state')).json()
srv.close()

let def = null
const doc = { getElementById: () => null, createElement: () => ({ setAttribute() {}, set textContent(v) { doc.css = v } }), head: { appendChild() {} } }
const sandbox = { window: { __ModuleLoader__: { load(d) { def = d } } }, document: doc, console, Promise, setTimeout, clearTimeout, setInterval, clearInterval }
vm.runInNewContext(readFileSync(path.join(here, '../lib/client.js'), 'utf8'), sandbox)
assert.equal(def.id, 'dsh-daily-schedule')
const mod = def.factory((n) => { if (n === 'react') return FakeReact; throw new Error(n) })
const regs = []
mod.apply({ effect(fn) { return fn() }, slots: { inject(_n, fn) { return fn() }, register(o, c) { regs.push({ o, c }); return () => {} } } })
assert.equal(regs[0].o.name, 'settings.section'); assert.equal(regs[0].o.label(), '每日日程')
assert.ok(doc.css.includes('.ds-it-now'))
const T = mod.__test
const h = FakeReact.createElement
const txt = (el) => render(el).join(' ')
const toast = () => {}

assert.match(txt(regs[0].c({})), /加载中/)
// 外壳（预置 state）
FakeReact.__override([state, '', 'schedule', null])
let o = txt(h(T.Section, {}))
assert.match(o, /小鱼的每日日程/); assert.match(o, /每晚 22:00 生成/); assert.match(o, /日程类型/); assert.match(o, /往期/)
// 今天
o = txt(h(T.ScheduleTab, { state: { ...state, now: { ...state.now, minute: 9 * 60 } }, reload() {}, toast }))
assert.match(o, /普通的周二/); assert.match(o, /上班日/); assert.match(o, /心情：想摸鱼/); assert.match(o, /模型生成/); assert.match(o, /调整过 1 次/)
assert.match(o, /08:00–12:00/); assert.match(o, /此刻/); assert.match(o, /偷吃饼干/); assert.match(o, /工作学习/)
assert.match(o, /现在注入给模型的内容/)
// 明天（没有）
FakeReact.__override(['tomorrow'])
o = txt(h(T.ScheduleTab, { state, reload() {}, toast }))
assert.match(o, /明天的日程还没生成/); assert.match(o, /按星期随机挑/); assert.match(o, /下午和你去看电影/)
// 编辑
o = txt(h(T.EditDay, { day: state.today, toast, onDone() {} }))
assert.match(o, /编辑日程/); assert.match(o, /\[input:08:00\]/); assert.match(o, /\[input:上班\]/); assert.match(o, /加一段/)
// 模板兜底提示
o = txt(h(T.DayView, { which: 'today', date: today, day: { ...state.today, source: 'template', error: 'rate limited' }, nowMinute: 600, dayTypes: state.config.dayTypes, nextLabel: '', toast, onChanged() {} }))
assert.match(o, /模板兜底：模型生成失败（rate limited）/)
// 日程类型
o = txt(h(T.TypesTab, { state, onState() {}, toast }))
assert.match(o, /\[input:上班日\]/); assert.match(o, /\[input:休息日\]/); assert.match(o, /工作日 \d+%/); assert.match(o, /周末 \d+%/); assert.match(o, /加一种类型/)
// 设置
o = txt(h(T.SettingsTab, { state, onState() {}, toast }))
assert.match(o, /让她像真人一样提起自己的生活/); assert.match(o, /\[textarea:【怎么把这些带进聊天】/); assert.match(o, /正在用默认的说话方式/); assert.doesNotMatch(o, /已自定义/)
{
  const custom = { ...state, config: { ...state.config, inject: { ...state.config.inject, voice: '【口吻】软软的' } } }
  const oc = txt(h(T.SettingsTab, { state: custom, onState() {}, toast }))
  assert.match(oc, /\[textarea:【口吻】软软的\]/); assert.match(oc, /已自定义/); assert.match(oc, /恢复默认/)
  const off = { ...state, config: { ...state.config, inject: { ...state.config.inject, voiceOn: false } } }
  assert.doesNotMatch(txt(h(T.SettingsTab, { state: off, onState() {}, toast })), /\[textarea:【怎么把这些/)
}
assert.match(o, /角色名/); assert.match(o, /读 AGENT.md/); assert.match(o, /贪吃的鲸鱼娘/); assert.match(o, /\[input:22:00\]/); assert.match(o, /跟随 DSH 默认模型/); assert.match(o, /每半小时（推荐）/); assert.match(o, /和生图工作室联动/)
// 往期
assert.match(txt(h(T.HistoryTab, { toast })), /加载中/)
FakeReact.__override([[{ date: today, label: '10月28日 星期三', dayType: { name: '上班日' }, title: '普通的周二', changes: 1 }], null])
o = txt(h(T.HistoryTab, { toast }))
assert.match(o, /10月28日 星期三/); assert.match(o, /调整 1/)
console.log('ALL CLIENT TESTS PASSED')

// ======================= v0.2：联动生图工作室的衣柜 =======================
// 没装生图工作室：设置里提示，日程页不出「补穿搭」
assert.equal(state.wardrobe.available, false)
o = txt(h(T.SettingsTab, { state, onState() {}, toast }))
assert.match(o, /联动生图工作室/); assert.match(o, /没找到生图工作室的素材库/); assert.doesNotMatch(o, /她的衣柜/)
o = txt(h(T.ScheduleTab, { state, reload() {}, toast }))
assert.doesNotMatch(o, /按衣柜补上穿搭/)

// 造一个素材库（和用户的库同一个样子）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const put = (cat, name, extra = {}) => { const d = path.join(tmp, 'image-studio', 'library', cat, name); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'entry.json'), JSON.stringify({ name, aliases: [], tags: [], ...extra })); writeFileSync(path.join(d, 'a.png'), PNG) }
put('characters', '鱼鱼', { aliases: ['小鱼', '大肥鱼'] }); put('characters', 'Q版小鱼'); put('characters', '阿星', { aliases: ['星星'] })
for (const n of ['JK短裙', '居家针织服', '通勤休闲装', '复古']) put('outfits', n, { tags: ['日常'] })
for (const n of ['卧室', '客厅', '江畔暖灯咖啡屋']) put('scenes', n)
put('props', '游戏手柄')
const dressedItems = normalizeItems([
  { start: '00:00', end: '09:00', activity: '睡觉', scene: '卧室', outfitNote: '睡衣' },
  { start: '09:00', end: '12:00', activity: '窝沙发打游戏', scene: '客厅', outfit: '居家针织服', props: ['游戏手柄'] },
  { start: '12:00', end: '16:00', activity: '咖啡馆喝拿铁', location: '江边', scene: '江畔暖灯咖啡屋', outfit: 'JK短裙', outfitNote: '外面加了件开衫', with: ['阿星'] },
  { start: '16:00', end: '24:00', activity: '回家追剧', scene: '客厅', outfit: 'JK短裙', outfitNote: '外面加了件开衫' },
])
store.writeDay({ ...store.readDay(today), items: dressedItems, dressedAt: 'x' })
store.writeDay({ date: addDays(today, 1), dayType: { id: 'restday', name: '休息日' }, title: '宅家', mood: '', source: 'template', model: '', items: normalizeItems([{ start: '00:00', end: '24:00', activity: '在家' }]) })
const srv2 = http.createServer(createHandler(ctx))
await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
const B2 = `http://127.0.0.1:${srv2.address().port}/api/daily-schedule`
const ws = await (await fetch(B2 + '/state?fresh=1')).json()
srv2.close()
assert.equal(ws.wardrobe.available, true); assert.equal(ws.wardrobe.her.name, '鱼鱼'); assert.equal(ws.dressed.today, true); assert.equal(ws.dressed.tomorrow, false)

// 小工具
assert.deepEqual(JSON.parse(JSON.stringify(T.outfitRuns(dressedItems).map((r) => [r.start, r.end, r.outfit || r.note]))), [['00:00', '09:00', '睡衣'], ['09:00', '12:00', '居家针织服'], ['12:00', '24:00', 'JK短裙']])
assert.equal(T.autoHer(ws.wardrobe, '小鱼').name, '鱼鱼'); assert.equal(T.autoHer(ws.wardrobe, '大肥鱼').name, '鱼鱼'); assert.equal(T.autoHer(ws.wardrobe, '路人'), null)
const jk = ws.wardrobe.outfits.find((e) => e.name === 'JK短裙')
assert.match(T.coverSrc('outfits', jk), /^\/api\/image-studio\/file\?c=outfits&id=JK%E7%9F%AD%E8%A3%99&f=a\.png/)
assert.equal(T.coverSrc('outfits', null), '')

// 今天：时间线里有穿着 / 物品 / 和谁；换装条；「重新搭配」
o = txt(h(T.ScheduleTab, { state: { ...ws, now: { ...ws.now, minute: 14 * 60 } }, reload() {}, toast }))
assert.match(o, /这一天的穿搭/); assert.match(o, /换了 2 次衣服/); assert.match(o, /12:00–24:00 · 此刻/)
assert.match(o, /JK短裙/); assert.match(o, /· 外面加了件开衫/); assert.match(o, /睡衣/); assert.match(o, /游戏手柄/); assert.match(o, /和 阿星/)
assert.match(o, /江畔暖灯咖啡屋/, 'scene shown instead of location'); assert.match(o, /重新搭配/); assert.doesNotMatch(o, /按衣柜补上穿搭/)
// 明天：没穿搭 → 提示补上
FakeReact.__override(['tomorrow'])
o = txt(h(T.ScheduleTab, { state: ws, reload() {}, toast }))
assert.match(o, /这一天还没配穿搭/); assert.match(o, /按衣柜补上穿搭/); assert.doesNotMatch(o, /重新搭配/)
// 关掉穿搭联动 → 不提示
o = txt(h(T.DayView, { which: 'tomorrow', date: addDays(today, 1), day: ws.tomorrow, nowMinute: null, dayTypes: ws.config.dayTypes, nextLabel: '', wardrobe: ws.wardrobe, link: { outfits: false }, canDress: false, toast, onChanged() {} }))
assert.doesNotMatch(o, /按衣柜补上穿搭/)
// 编辑：穿着下拉 + 备注 + 场景下拉；库里没有的值也留着
o = txt(h(T.EditDay, { day: { ...ws.today, items: [...ws.today.items, { start: '23:00', end: '24:00', activity: '睡觉', outfit: '浴衣', scene: '阳台' }] }, wardrobe: ws.wardrobe, link: ws.config.link, toast, onDone() {} }))
assert.match(o, /穿着：不用衣柜里的/); assert.match(o, /场景：不用场景库/); assert.match(o, /\[input:外面加了件开衫\]/); assert.match(o, /\{ph:穿着备注/)
assert.match(o, /浴衣（库里没有）/); assert.match(o, /阳台（库里没有）/); assert.match(o, /通勤休闲装/)
o = txt(h(T.EditDay, { day: ws.today, wardrobe: null, link: {}, toast, onDone() {} }))
assert.doesNotMatch(o, /穿着：不用衣柜里的/)
// 设置：联动面板
o = txt(h(T.SettingsTab, { state: ws, onState() {}, toast }))
assert.match(o, /日程里的她是人物库里的/); assert.match(o, /自动：按角色名认出「鱼鱼」/); assert.match(o, /Q版小鱼/)
assert.match(o, /穿搭（衣柜里 4 套）/); assert.match(o, /场景（3 个地方）/); assert.match(o, /物品（1 件）/); assert.match(o, /认识的人（1 位）/)
assert.match(o, /她的衣柜/); assert.match(o, /常去的地方/); assert.match(o, /重新读取素材库/); assert.doesNotMatch(o, /没找到生图工作室/)
// 往期：打开一天，带换装条
FakeReact.__override([[], { label: '10月29日', day: ws.today }])
o = txt(h(T.HistoryTab, { toast, wardrobe: ws.wardrobe }))
assert.match(o, /10月29日/); assert.match(o, /这一天的穿搭/); assert.match(o, /JK短裙/)
// 外壳
FakeReact.__override([ws, '', 'schedule', null])
assert.match(txt(h(T.Section, {})), /这一天的穿搭/)
console.log('ALL V2 CLIENT TESTS PASSED')

// ======================= v0.4：分会话注入 =======================
assert.equal(ws.sessions.scope, 'all'); assert.equal(ws.sessions.total, 0)
o = txt(h(T.SettingsTab, { state: ws, onState() {}, toast }))
assert.match(o, /注入到哪些会话/); assert.match(o, /所有会话/); assert.match(o, /只在打开的会话/); assert.match(o, /\/life off/); assert.match(o, /还没有单独设置过的会话/)
o = txt(h(T.SettingsTab, { state: { ...ws, config: { ...ws.config, inject: { ...ws.config.inject, scope: 'session' } } }, onState() {}, toast }))
assert.match(o, /发 \/life on/)
o = txt(h(T.SessionOverrides, { sessions: { scope: 'all', total: 2, overrides: [{ id: 'abcdef123456', on: false, at: '2026-10-30T01:00:00Z', cwd: 'C:\\work\\proj' }, { id: 'zzz999', on: true, at: '', cwd: '' }] }, onState() {}, toast }))
assert.match(o, /单独设置过的会话（2）/); assert.match(o, /已关掉 abcdef12 proj/); assert.match(o, /已打开 zzz999/); assert.match(o, /恢复默认/)
console.log('ALL V4 CLIENT TESTS PASSED')
