// v0.2 冒烟测试：和生图工作室的库联动（衣柜 / 场景 / 物品 / 人物），穿搭生成、校验、补全、注入、调整、补穿搭。
// 用法：node tests/smoke-wardrobe.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-dsw-'))
process.env.DSH_HOME = tmp
writeFileSync(path.join(tmp, 'AGENT.md'), '小鱼：贪吃又爱摸鱼的鲸鱼娘。', 'utf8')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const S = path.join(tmp, 'image-studio')
function entry(cat, id, meta, file = 'a.png', base = path.join(S, 'library', cat)) {
  const d = path.join(base, id)
  mkdirSync(d, { recursive: true })
  writeFileSync(path.join(d, 'entry.json'), JSON.stringify({ name: id, ...meta }), 'utf8')
  writeFileSync(path.join(d, file), PNG)
}
entry('characters', '鱼鱼', { aliases: ['小鱼', '大肥鱼'], tags: ['鲸鱼娘'], description: '蓝发鲸鱼娘', situationOutfits: { 外出: 'JK短裙' } })
entry('characters', 'Q版小鱼', { tags: ['Q版'] })
entry('characters', '阿星', { aliases: ['星星'], description: '小鱼的同事，短发眼镜' })
entry('outfits', '居家针织服', { tags: ['居家', '针织'] })
entry('outfits', '通勤休闲装', { tags: ['通勤'] })
entry('outfits', '复古', { tags: ['复古', '日常'] })
entry('outfits', 'JK短裙', { aliases: ['水手服短裙'], description: '藏青水手服配白色百褶裙' })
entry('scenes', '卧室', { aliases: ['房间'], defaultOutfit: '居家针织服' })
entry('scenes', '客厅', { defaultOutfit: '居家针织服' })
entry('scenes', '江畔暖灯咖啡屋', { aliases: ['江边小咖啡馆'], description: '江边的暖色小咖啡馆' })
// 道具库放到自定义目录，验证读生图插件的 dirs 设置
const propsDir = path.join(tmp, 'my-props')
entry('props', '游戏手柄', { tags: ['游戏'] }, 'a.png', propsDir)
writeFileSync(path.join(propsDir, '鲸鱼抱枕.png'), PNG)
writeFileSync(path.join(S, 'config.json'), JSON.stringify({ dirs: { characters: '', outfits: '', scenes: '', props: propsDir } }), 'utf8')
writeFileSync(path.join(S, 'presets.json'), JSON.stringify({ situation: [
  { name: '在家休息', aliases: ['在家'], scene: '卧室', outfit: '居家针织服' },
  { name: '睡前', aliases: ['睡觉'], scene: '卧室', outfit: '居家针织服' },
  { name: '客厅放松', scene: '客厅', outfit: '居家针织服' },
  { name: '工作学习', aliases: ['上班'], scene: '', outfit: '通勤休闲装' },
  { name: '外出', aliases: ['出门'], scene: '', outfit: '复古' },
  { name: '吃东西', scene: '', outfit: '' },
] }), 'utf8')

// ---- 假模型 ----
const calls = []
let mode = 'ok'
const GEN = {
  title: '和阿星去咖啡馆的一天', mood: '轻松',
  items: [
    { start: '00:00', end: '08:00', activity: '睡觉', location: '家·卧室', scene: '卧室', outfit: '睡衣', outfit_note: '', situation: '睡前' },
    { start: '08:00', end: '09:00', activity: '赖床刷手机', location: '家·卧室', scene: '房间', situation: '在家休息' },
    { start: '09:00', end: '12:00', activity: '窝沙发打游戏', location: '家·客厅', outfit: '居家针织服', props: ['游戏手柄', '不存在的东西'], situation: '客厅放松' },
    { start: '12:00', end: '13:00', activity: '换衣服出门', location: '家', outfit: '水手服短裙', outfit_note: '外面加了件开衫', situation: '外出' },
    { start: '13:00', end: '16:00', activity: '咖啡馆喝拿铁', location: '江边', scene: '江边小咖啡馆', with: ['星星', '路人甲'], situation: '外出' },
    { start: '16:00', end: '17:00', activity: '回家', location: '路上', situation: '外出' },
    { start: '17:00', end: '23:00', activity: '在家看剧', location: '家·客厅', outfit: '居家针织服', props: ['鲸鱼抱枕'], situation: '客厅放松' },
    { start: '23:00', end: '24:00', activity: '睡觉', location: '家·卧室', outfit_note: '睡衣', situation: '睡前' },
  ],
}
const llm = {
  listProviders: () => [{ id: 'p' }],
  listModels: async () => [{ provider: 'p', id: 'flash', name: 'F' }],
  stream: async function* (opts) {
    const prompt = opts.messages[0].content[0].text
    calls.push(prompt)
    if (mode === 'error') { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }; return }
    let out
    if (prompt.includes('已经定好的日程')) {
      out = { items: [{ i: 0, outfit_note: '睡衣', scene: '卧室' }, { i: 1, outfit: '居家针织服', scene: '客厅' }, { i: 2, outfit: '复古', scene: '江畔暖灯咖啡屋' }] }
    } else out = GEN
    yield { type: 'text-delta', index: 0, text: JSON.stringify(out) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const tools = new Map()
const contexts = []
let handler = null
const ctx = {
  logger: { info() {}, warn() {} },
  tools: { register(d) { tools.set(d.name, d); return () => {} } },
  systemPrompt: { context(c) { contexts.push(c); return () => {} } },
  webServer: { register(r) { handler = r.handler; return () => {} } },
  effect(fn) { return fn() },
  get(n) { return n === 'llm' ? llm : undefined },
}

const store = await import('../lib/store.js')
const W = await import('../lib/wardrobe.js')
const { injectionText } = await import('../lib/inject.js')
const runner = await import('../lib/runner.js')
const { zonedNow, addDays } = await import('../lib/time.js')
const plugin = await import('../lib/index.js')
plugin.apply(ctx)
store.updateConfig({ timeZone: 'Australia/Sydney', partnerName: '涛涛' })
const cfg = () => store.getConfig()

// ---- 读库 ----
const w = W.loadWardrobe(true)
assert.equal(w.available, true)
assert.deepEqual(w.outfits.map((e) => e.name).sort(), ['JK短裙', '复古', '居家针织服', '通勤休闲装'].sort())
assert.deepEqual(w.props.map((e) => e.name).sort(), ['游戏手柄', '鲸鱼抱枕'].sort(), 'custom props dir + loose file')
assert.equal(W.herEntry(cfg(), w).name, '鱼鱼', '小鱼 → 鱼鱼 via alias')
assert.deepEqual(W.otherPeople(cfg(), w).map((e) => e.name), ['阿星'], 'Q版小鱼 is her variant')
assert.equal(W.resolveEntry(w.scenes, '江边小咖啡馆').name, '江畔暖灯咖啡屋')

// ---- 生成 ----
const today = zonedNow('Australia/Sydney').date
const day = await runner.ensureDay(ctx, today, { fallback: false, by: 'test', force: true })
const prompt = calls.at(-1)
console.log('--- prompt (wardrobe part) ---\n' + prompt.slice(prompt.indexOf('【她的衣柜】'), prompt.indexOf('【要求】')) + '------------------------------')
assert.match(prompt, /【她的衣柜】[\s\S]*- JK短裙（又名 水手服短裙）：藏青水手服/)
assert.match(prompt, /【她平时的穿搭习惯】[^\n]*外出→JK短裙/, 'character situation outfit overrides preset')
assert.match(prompt, /在卧室→居家针织服/)
assert.match(prompt, /【常去的地方】[\s\S]*江畔暖灯咖啡屋（又名 江边小咖啡馆）/)
assert.match(prompt, /【她的物品】[^【]*游戏手柄/); assert.match(prompt, /【她的物品】[^【]*鲸鱼抱枕/)
assert.match(prompt, /【认识的人】[\s\S]*阿星（又名 星星）/)
assert.ok(!/【认识的人】[\s\S]*Q版小鱼/.test(prompt))
assert.match(prompt, /- outfit：/); assert.match(prompt, /- scene：/); assert.match(prompt, /- props：/); assert.match(prompt, /- with：/)
assert.match(prompt, /"outfit":"","outfit_note":"睡衣","scene":"卧室"/)

const it = day.items
const at = (s) => it.find((x) => x.start === s)
assert.equal(at('00:00').outfit, undefined); assert.equal(at('00:00').outfitNote, '睡衣', 'unknown outfit → note')
assert.equal(at('08:00').outfitNote, '睡衣', 'carry forward'); assert.equal(at('08:00').scene, '卧室', 'alias 房间 → 卧室')
assert.equal(at('09:00').scene, '客厅', 'scene from location 家·客厅'); assert.deepEqual(at('09:00').props, ['游戏手柄'])
assert.equal(at('12:00').outfit, 'JK短裙'); assert.equal(at('12:00').outfitNote, '外面加了件开衫')
assert.equal(at('13:00').scene, '江畔暖灯咖啡屋'); assert.deepEqual(at('13:00').with, ['阿星']); assert.equal(at('13:00').outfit, 'JK短裙')
assert.equal(at('16:00').outfit, 'JK短裙')
assert.deepEqual(at('17:00').props, ['鲸鱼抱枕'])
assert.ok(day.dressedAt)

// ---- 注入 ----
const nowAt = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const z = zonedNow('Australia/Sydney'); return new Date(Date.now() + ((h * 60 + m) - z.minute) * 60000) }
let t = injectionText(cfg(), nowAt('14:10'))
console.log('--- inject 14:10 ---\n' + t + '\n--------------------')
assert.match(t, /她正在：咖啡馆喝拿铁（江畔暖灯咖啡屋），从 13:00 到 16:00 左右/)
assert.match(t, /她身上穿着「JK短裙」（外面加了件开衫），和阿星在一起。/)
assert.match(t, /她今天换过的衣服：睡衣 → 09:00 起「居家针织服」 → 12:00 起「JK短裙」（外面加了件开衫）/)
assert.match(t, /characters 填「鱼鱼」；outfits 填「JK短裙」，prompt 里写上「外面加了件开衫」；scene 填「江畔暖灯咖啡屋」；situation 填「外出」/)
t = injectionText(cfg(), nowAt('07:00'))
assert.match(t, /outfits 留空，prompt 里写明穿着睡衣/)
assert.match(t, /scene 填「卧室」/)
t = injectionText(cfg(), nowAt('10:00'))
assert.match(t, /手边有游戏手柄/)

// ---- schedule_view / schedule_adjust ----
assert.match(await tools.get('schedule_view').execute({}), /穿着：「JK短裙」（外面加了件开衫）；和：阿星/)
let r = await tools.get('schedule_adjust').execute({ start: '18:00', end: '20:00', activity: '和涛涛吃火锅', location: '火锅店', reason: '涛涛约我' })
let d2 = store.readDay(today)
let x = d2.items.find((i) => i.start === '18:00')
assert.equal(x.outfit, '居家针织服', 'adjust inherits outfit')
r = await tools.get('schedule_adjust').execute({ start: '20:00', end: '21:00', activity: '换身衣服去江边', outfit: '复古', scene: '江边小咖啡馆', reason: '想出去走走' })
d2 = store.readDay(today)
x = d2.items.find((i) => i.start === '20:00')
assert.equal(x.outfit, '复古'); assert.equal(x.scene, '江畔暖灯咖啡屋')
assert.equal(d2.items.find((i) => i.start === '21:00').outfit, '居家针织服', 'later segment keeps its own outfit')

// ---- 旧日程自动补穿搭（模型）----
const yest = addDays(today, -1)
store.writeDay({ date: yest, dayType: { id: 'homebody', name: '宅家日' }, title: '旧的一天', mood: '', source: 'llm', items: [
  { start: '00:00', end: '10:00', activity: '睡觉', location: '家·卧室', detail: '' },
  { start: '10:00', end: '13:00', activity: '窝沙发', location: '家·客厅', detail: '' },
  { start: '13:00', end: '24:00', activity: '去咖啡屋', location: '咖啡屋', detail: '换了件卫衣' },
] })
const tomorrow = addDays(today, 1)
store.writeDay({ date: tomorrow, dayType: { id: 'homebody', name: '宅家日' }, title: '明天', mood: '', source: 'llm', items: [
  { start: '00:00', end: '09:00', activity: '睡觉', location: '家·卧室', detail: '' },
  { start: '09:00', end: '18:00', activity: '上班写代码', location: '公司', detail: '' },
  { start: '18:00', end: '24:00', activity: '在家看剧', location: '家·客厅', detail: '' },
] })
let done = await runner.tick(ctx)
assert.ok(done.includes(`dress:${tomorrow}`), 'auto-dress tomorrow: ' + done)
assert.ok(calls.at(-1).includes('已经定好的日程'))
assert.match(calls.at(-1), /换了件卫衣/)
const dt = store.readDay(tomorrow)
assert.equal(dt.items[0].outfitNote, '睡衣'); assert.equal(dt.items[1].outfit, '居家针织服'); assert.equal(dt.items[2].outfit, '复古')
assert.ok(dt.dressedAt); assert.match(dt.changes.at(-1).note, /按衣柜补上穿搭/)
done = await runner.tick(ctx)
assert.ok(!done.some((x) => x.startsWith('dress:')), 'no second dress')

// ---- 模型失败 → 按规则补 ----
mode = 'error'
const { dressDay } = await import('../lib/generate.js')
const dy = await dressDay({ ctx, date: yest })
assert.equal(dy.items[0].outfit, '居家针织服', 'rules: sleep in 卧室 → 睡前 → 居家针织服')
assert.equal(dy.items[0].scene, '卧室')
assert.equal(dy.items[1].scene, '客厅')
assert.equal(dy.items[2].outfit, 'JK短裙', 'rules: 咖啡 → 外出 → her situation outfit')
assert.match(dy.changes.at(-1).note, /按衣柜规则补上穿搭（模型没成功/)

// ---- 模板兜底也带穿搭 ----
const sat = '2026-11-07'
const tpl = await runner.ensureDay(ctx, sat, { fallback: true, by: 'test', force: true, dayTypeId: 'outing' })
assert.equal(tpl.source, 'template')
assert.ok(tpl.items.every((i) => i.outfit || i.outfitNote), 'template items dressed')
assert.ok(tpl.items.some((i) => i.outfit === 'JK短裙'))
mode = 'ok'

// ---- 关掉联动 ----
store.updateConfig({ link: { outfits: false, scenes: false, props: false, people: false } })
await runner.ensureDay(ctx, '2026-11-08', { fallback: false, by: 'test', force: true })
assert.ok(!/【她的衣柜】|【常去的地方】|- outfit：/.test(calls.at(-1)))
assert.ok(store.readDay('2026-11-08').items.every((i) => !i.outfit && !i.scene))
store.updateConfig({ link: { outfits: true, scenes: true, props: true, people: true } })

// ---- HTTP ----
const srv = http.createServer((q, s) => handler(q, s))
await new Promise((res) => srv.listen(0, '127.0.0.1', res))
const B = `http://127.0.0.1:${srv.address().port}/api/daily-schedule`
const j = async (p, body) => { const res = await fetch(B + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() } }
let s = await j('/state?fresh=1')
assert.match(s.json.build, /^v0\.[23]\.0$/)
assert.equal(s.json.wardrobe.her.name, '鱼鱼')
assert.equal(s.json.wardrobe.outfits.length, 4)
assert.deepEqual(s.json.wardrobe.people.map((e) => e.name), ['阿星'])
assert.ok(s.json.wardrobe.outfits.every((e) => e.cover === 'a.png'))
assert.equal(s.json.dressed.today, true)
s = await j('/config', { imageCharacter: 'Q版小鱼', link: { props: false } })
assert.equal(s.json.config.imageCharacter, 'Q版小鱼'); assert.equal(s.json.config.link.props, false); assert.equal(s.json.config.link.outfits, true)
assert.equal(s.json.wardrobe.her.name, 'Q版小鱼')
store.updateConfig({ imageCharacter: '', link: { props: true } })
s = await j('/dress', { day: 'yesterday' })
let job
for (let i = 0; i < 40; i++) { await new Promise((z) => setTimeout(z, 100)); job = (await j('/job?id=' + s.json.jobId)).json; if (job.status !== 'running') break }
assert.equal(job.status, 'done', JSON.stringify(job))
assert.equal(job.day.items[2].outfit, '复古')
// 手动编辑：名字对上库（别名 → 正名），库里没有的转成备注
s = await j('/day', { date: 'today', items: [{ start: '00:00', end: '12:00', activity: '睡懒觉', outfit: '水手服短裙', scene: '房间' }, { start: '12:00', end: '24:00', activity: '在家', outfit: '浴衣' }] })
assert.equal(s.json.day.items[0].outfit, 'JK短裙'); assert.equal(s.json.day.items[0].scene, '卧室'); assert.equal(s.json.day.items[1].outfitNote, '浴衣')
srv.close()
// 地点文字认场景：「家-客厅」→ 客厅；「咖啡屋」「江边的咖啡屋」→ 江畔暖灯咖啡屋；「家-厨房」不硬塞卧室
{
  const { linkItems } = await import('../lib/dress.js')
  W.invalidateWardrobe()
  const sceneOf = (location, activity = '发呆') => linkItems([{ start: '00:00', end: '24:00', activity, location }], store.getConfig(), { fill: true })[0].scene || ''
  assert.equal(sceneOf('家-客厅'), '客厅')
  assert.equal(sceneOf('咖啡屋', '喝拿铁'), '江畔暖灯咖啡屋')
  assert.equal(sceneOf('江边的咖啡屋', '喝拿铁'), '江畔暖灯咖啡屋')
  assert.equal(sceneOf('家-厨房', '煮泡面'), '')
  assert.equal(sceneOf('家-卫生间', '洗澡'), '')
  assert.equal(sceneOf('公司', '上班'), '')
}
console.log('ALL WARDROBE TESTS PASSED')
