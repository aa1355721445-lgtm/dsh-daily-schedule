/**
 * dsh-daily-schedule —— 穿搭与场景：把生图库写进生成提示词，校验模型给的每段
 * outfit / outfit_note / scene / props / with，并在缺的时候按规则补上。
 *
 * 规则（和生图插件选服饰的顺序一致）：
 *   模型给的 > 延续上一段 > 她在这个情境的专属穿搭 > 情境默认 > 场景默认 > 她的默认服饰
 */
import { findSituation, herEntry, loadWardrobe, otherPeople, resolveEntry } from './wardrobe.js'

const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
const label = (e) => `${e.name}${e.aliases.length ? `（又名 ${e.aliases.slice(0, 2).join('/')}）` : ''}`
const brief = (e, max) => {
  const parts = []
  if (e.tags.length) parts.push(e.tags.slice(0, 5).join('、'))
  if (e.description) parts.push(oneLine(e.description, max))
  return parts.length ? `：${parts.join('；')}` : ''
}

export function linkOn(cfg) {
  const l = cfg.link || {}
  return {
    outfits: cfg.imageStudio && l.outfits !== false,
    scenes: cfg.imageStudio && l.scenes !== false,
    props: cfg.imageStudio && l.props !== false,
    people: cfg.imageStudio && l.people !== false,
  }
}

/** 她平时的穿搭习惯（情境 → 服饰、场景 → 服饰、默认）。 */
export function habitLines(cfg, w) {
  const her = herEntry(cfg, w)
  const out = []
  for (const s of w.situations) {
    const own = her && her.situationOutfits && her.situationOutfits[s.name]
    const o = own || s.outfit
    if (o) out.push(`${s.name}→${o}`)
  }
  for (const sc of w.scenes) if (sc.defaultOutfit) out.push(`在${sc.name}→${sc.defaultOutfit}`)
  if (her && her.defaultOutfit) out.push(`平时→${her.defaultOutfit}`)
  return [...new Set(out)]
}

/** 生成提示词里关于衣柜 / 场景 / 物品 / 人物的部分。返回 { sections: string, rules: string[], example: object } */
export function wardrobePrompt(cfg, w = loadWardrobe()) {
  const on = linkOn(cfg)
  if (!w.available || !(on.outfits || on.scenes || on.props || on.people)) return { sections: '', rules: [], fields: {} }
  const sec = []
  const rules = []
  const fields = {}
  if (on.outfits && w.outfits.length) {
    sec.push(`【她的衣柜】（生图工作室的服饰库，每段的 outfit 从这里选，写名字）\n${w.outfits.slice(0, 30).map((e) => `- ${label(e)}${brief(e, 70)}`).join('\n')}`)
    const habits = habitLines(cfg, w)
    if (habits.length) sec.push(`【她平时的穿搭习惯】${habits.join('；')}`)
    rules.push('- outfit：这一段穿着衣柜里的哪一套，写名字。穿搭要连续，只在合理的时候换（起床后、出门前、回到家、洗完澡、睡前），同一套可以连着很多段；按场合和天气挑，别一整天都同一套也别频繁乱换。衣柜里没有合适的（比如睡衣、泳衣、运动服），outfit 留空、在 outfit_note 写穿着什么；在衣柜那套的基础上有变化（加了件外套、系着围裙、换了双鞋），也写在 outfit_note。')
    // 示例用睡觉那一段：衣柜里有睡衣就写它，没有就示范 outfit_note
    const pj = w.outfits.find((e) => [e.name, ...e.aliases, ...e.tags].some((n) => /睡衣|睡裙|pajama/i.test(n)))
    fields.outfit = pj ? pj.name : ''
    fields.outfit_note = pj ? '' : '睡衣'
  }
  if (on.scenes && w.scenes.length) {
    sec.push(`【常去的地方】（场景库，地点就是这里时 scene 填名字）\n${w.scenes.slice(0, 20).map((e) => `- ${label(e)}${brief(e, 70)}`).join('\n')}`)
    rules.push('- scene：地点就是上面某个场景时填它的名字。在家时尽量落在库里有的房间；出门时可以多去库里有的地方，也可以去新地方——库里没有的地点 scene 留空，照常写 location。')
    const bed = w.scenes.find((e) => [e.name, ...e.aliases, ...e.tags].some((n) => /卧室|房间|睡觉|bedroom/i.test(n)))
    fields.scene = bed ? bed.name : ''
  }
  if (on.props && w.props.length) {
    sec.push(`【她的物品】（道具库，用到时 props 填名字）\n${w.props.slice(0, 20).map((e) => `- ${label(e)}${brief(e, 40)}`).join('\n')}`)
    rules.push('- props：这一段用到物品库里的东西时填名字，最多 2 个，没有就留空数组。')
    fields.props = []
  }
  const people = on.people ? otherPeople(cfg, w) : []
  if (people.length) {
    sec.push(`【认识的人】（人物库里的其他角色）\n${people.slice(0, 10).map((e) => `- ${label(e)}${brief(e, 50)}`).join('\n')}`)
    rules.push('- with：和上面认识的人在一起时填名字，没有就留空数组。别硬凑，大部分时候她是一个人或和用户在一起。')
    fields.with = []
  }
  return { sections: sec.join('\n'), rules, fields }
}

// ---- 校验与补全 ---------------------------------------------------------------

const SIT_GUESS = [
  [/睡觉|入睡|睡着|午睡/, ['睡前']],
  [/起床|赖床|醒/, ['刚睡醒']],
  [/上班|工作|写代码|开会|干活|加班|摸鱼/, ['工作学习']],
  [/出门|逛|散步|约会|看展|公园|海边|外出|旅行|咖啡/, ['外出']],
  [/吃|饭|外卖|零食|夜宵|下午茶/, ['吃东西']],
  [/沙发|电视|看剧|看番|综艺|电影/, ['客厅放松']],
  [/游戏|追剧|刷手机|发呆|休息|宅/, ['在家休息']],
]

function guessSituation(item, w) {
  if (item.situation) {
    const s = findSituation(w, item.situation)
    if (s) return s
  }
  const hay = `${item.activity} ${item.location || ''}`
  for (const [re, names] of SIT_GUESS) {
    if (!re.test(hay)) continue
    for (const n of names) { const s = findSituation(w, n); if (s) return s }
  }
  return null
}

// 地点里「家」「-」这类前缀去掉后剩下的具体位置：「家-厨房」→「厨房」，「家」→ ''
function placeCore(loc) {
  return String(loc || '').replace(/[\s\-—–·・/|，,、（）()的]+/g, ' ').split(' ')
    .map((x) => x.replace(/^(在|我|她|自己)?(家|家里|屋里|房间里|公寓)?(的|里)?/, '')).filter(Boolean).join(' ')
}

/** 按地点文字认场景：库里的名字出现在地点里，或地点（去掉「家-」）是某个场景名字的一部分（「咖啡屋」→「江畔暖灯咖啡屋」）。 */
function sceneFromLocation(item, w) {
  const loc = String(item.location || '')
  if (!loc) return null
  const names = (e) => [e.name, ...e.aliases].map(String).filter((n) => n.length >= 2)
  let hits = w.scenes.filter((e) => names(e).some((n) => loc.includes(n)))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return null
  const parts = placeCore(loc).split(' ').filter((x) => x.length >= 2)
  hits = w.scenes.filter((e) => names(e).some((n) => parts.some((p) => n.includes(p))))
  return hits.length === 1 ? hits[0] : null
}

/** 地点只说了「家」「家里」，没说哪个房间。 */
function genericHome(loc) {
  const l = String(loc || '').trim()
  return l === '' || (/家|屋|房|公寓/.test(l) && placeCore(l) === '')
}

/**
 * 把模型给的穿搭 / 场景 / 物品 / 人物对上库里的名字，缺的按规则补。
 * 补穿搭时：这一段按规则该穿的和上一段一样（还是同一种场合），就延续上一段的穿着
 * （保留模型写的「加了件外套」这类细节）；场合变了（比如出门了）就换成规则给的那套。
 * @param items normalizeItems 之后的数组（会返回新数组）
 * @param opts { fill: true = 缺的补上 }
 */
export function linkItems(items, cfg, opts = {}, w = loadWardrobe()) {
  const on = linkOn(cfg)
  if (!w.available) return items
  const her = herEntry(cfg, w)
  const people = on.people ? otherPeople(cfg, w) : []
  const ruleOutfit = (it) => {
    const sit = guessSituation(it, w)
    const sceneE = it.scene ? resolveEntry(w.scenes, it.scene) : null
    const cands = [
      sit && her && her.situationOutfits && her.situationOutfits[sit.name],
      sit && sit.outfit,
      sceneE && sceneE.defaultOutfit,
      her && her.defaultOutfit,
    ].filter(Boolean)
    for (const c of cands) {
      const o = resolveEntry(w.outfits, c)
      if (o) return o.name
    }
    return ''
  }
  const out = []
  let prev = null
  let prevRule = ''
  for (const raw of items) {
    const it = { ...raw }
    // 场景：对上库里的正名；没给的按地点文字认
    if (on.scenes) {
      const s = it.scene ? resolveEntry(w.scenes, it.scene) : null
      if (!s && it.scene && !it.location) it.location = String(it.scene)
      it.scene = s ? s.name : ''
      if (!it.scene && opts.fill) {
        const byLoc = sceneFromLocation(it, w)
        if (byLoc) it.scene = byLoc.name
        else {
          const sit = guessSituation(it, w)
          if (sit && sit.scene && it.location && genericHome(it.location)) {
            const s2 = resolveEntry(w.scenes, sit.scene)
            if (s2) it.scene = s2.name
          }
        }
      }
    }
    // 服饰：库里的名字留在 outfit，库里没有的转进 outfitNote；缺的按规则补
    if (on.outfits) {
      const given = String(it.outfit || '').trim()
      const note = String(it.outfitNote || '').trim()
      const hit = given ? resolveEntry(w.outfits, given) : null
      it.outfit = hit ? hit.name : ''
      it.outfitNote = hit ? note : [given, note].filter(Boolean).join('，')
      const rule = opts.fill ? ruleOutfit(it) : ''
      if (opts.fill && !it.outfit && !it.outfitNote) {
        if (prev && (prev.outfit || prev.outfitNote) && (!rule || rule === prevRule)) {
          it.outfit = prev.outfit || ''
          it.outfitNote = prev.outfitNote || ''
        } else if (rule) it.outfit = rule
      }
      prevRule = rule
    }
    if (on.props) {
      const ps = (Array.isArray(it.props) ? it.props : []).map((p) => resolveEntry(w.props, p)).filter(Boolean).map((e) => e.name)
      it.props = [...new Set(ps)].slice(0, 3)
    }
    if (on.people) {
      const ws = (Array.isArray(it.with) ? it.with : []).map((p) => resolveEntry(people, p)).filter(Boolean).map((e) => e.name)
      it.with = [...new Set(ws)].slice(0, 4)
    }
    // 关掉的联动：生成时模型没被要求写这些，顺手写了也不要
    if (opts.fill) {
      if (!on.outfits) { delete it.outfit; delete it.outfitNote }
      if (!on.scenes) delete it.scene
      if (!on.props) delete it.props
      if (!on.people) delete it.with
    }
    for (const k of ['outfit', 'outfitNote', 'scene']) if (!it[k]) delete it[k]
    for (const k of ['props', 'with']) if (Array.isArray(it[k]) && !it[k].length) delete it[k]
    out.push(it)
    prev = it
  }
  return out
}

export function hasOutfits(day) {
  return !!(day && Array.isArray(day.items) && day.items.some((it) => it.outfit || it.outfitNote))
}

export function outfitLabel(it) {
  if (!it) return ''
  if (it.outfit && it.outfitNote) return `「${it.outfit}」（${it.outfitNote}）`
  if (it.outfit) return `「${it.outfit}」`
  return it.outfitNote || ''
}

/** 今天的换装：[{ start, end, label }]，相邻相同的合并。 */
export function outfitRuns(day) {
  const runs = []
  for (const it of (day && day.items) || []) {
    const lbl = outfitLabel(it)
    if (!lbl) continue
    const last = runs[runs.length - 1]
    if (last && last.label === lbl && last.end === it.start) last.end = it.end
    else runs.push({ start: it.start, end: it.end, label: lbl, outfit: it.outfit || '', note: it.outfitNote || '' })
  }
  return runs
}
