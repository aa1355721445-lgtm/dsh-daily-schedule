/**
 * dsh-daily-schedule —— 读生图工作室（dsh-image-studio）的素材库：
 * 人物 / 服饰 / 场景 / 道具，以及它的情境关键词（含每个情境的默认场景和服饰）。
 *
 * 只读文件，不依赖生图插件的代码：生图插件没装时 available = false，一切照常。
 * 目录规则和生图插件一致：<库目录>/<条目>/entry.json + 图片，或库目录下的散图。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { dshHome } from './store.js'

const IMG = /\.(png|jpe?g|webp|gif)$/i
const TTL_MS = 60_000

export function studioRoot() { return path.join(dshHome(), 'image-studio') }

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const strs = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 30)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function scan(category, dir) {
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  const folders = new Set()
  for (const d of ents) {
    if (d.name.startsWith('.') || !d.isDirectory()) continue
    folders.add(d.name)
    const m = readJson(path.join(dir, d.name, 'entry.json')) || {}
    let imgs = []
    try { imgs = readdirSync(path.join(dir, d.name)).filter((f) => !f.startsWith('.') && IMG.test(f)).sort() } catch {}
    const cover = typeof m.cover === 'string' && imgs.includes(m.cover) ? m.cover : imgs[0] || ''
    let mtime = 0
    try { mtime = cover ? statSync(path.join(dir, d.name, cover)).mtimeMs : 0 } catch {}
    out.push({
      id: d.name,
      category,
      name: String(m.name || d.name).trim(),
      aliases: strs(m.aliases),
      tags: strs(m.tags),
      description: String(m.description || '').replace(/\s+/g, ' ').trim(),
      defaultOutfit: String(m.defaultOutfit || '').trim(),
      situationOutfits: isObj(m.situationOutfits) ? m.situationOutfits : {},
      cover,
      mtime,
      images: imgs.length,
    })
  }
  for (const d of ents) {
    if (d.name.startsWith('.') || !d.isFile() || !IMG.test(d.name)) continue
    const stem = d.name.replace(/\.[^.]+$/, '')
    const id = folders.has(stem) || out.some((e) => e.id === stem) ? d.name : stem
    out.push({ id, category, name: stem, aliases: [], tags: [], description: '', defaultOutfit: '', situationOutfits: {}, cover: d.name, mtime: 0, images: 1 })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return out
}

let cache = null
let cacheAt = 0

export function invalidateWardrobe() { cache = null }

/** { available, characters, outfits, scenes, props, situations } */
export function loadWardrobe(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache
  const root = studioRoot()
  let available = false
  try { available = statSync(root).isDirectory() } catch {}
  const w = { available, characters: [], outfits: [], scenes: [], props: [], situations: [] }
  if (available) {
    const cfg = readJson(path.join(root, 'config.json')) || {}
    const dirs = isObj(cfg.dirs) ? cfg.dirs : {}
    for (const c of ['characters', 'outfits', 'scenes', 'props']) {
      const custom = typeof dirs[c] === 'string' ? dirs[c].trim() : ''
      w[c] = scan(c, custom || path.join(root, 'library', c))
    }
    const presets = readJson(path.join(root, 'presets.json')) || {}
    w.situations = (Array.isArray(presets.situation) ? presets.situation : [])
      .filter((x) => isObj(x) && x.name)
      .map((x) => ({ name: String(x.name), aliases: strs(x.aliases), scene: String(x.scene || ''), outfit: String(x.outfit || ''), light: String(x.light || '') }))
      .slice(0, 40)
  }
  cache = w
  cacheAt = Date.now()
  return w
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')

/** 按 id / 名字 / 别名找条目；再退一步找唯一的包含匹配（和生图插件同一套规则）。 */
export function resolveEntry(list, ref) {
  const key = norm(ref)
  if (!key || !Array.isArray(list)) return null
  const exact = list.find((e) => norm(e.id) === key) || list.find((e) => norm(e.name) === key) || list.find((e) => e.aliases.some((a) => norm(a) === key))
  if (exact) return exact
  const loose = list.filter((e) => [e.name, ...e.aliases].some((n) => { const nn = norm(n); return nn.length >= 2 && (key.includes(nn) || nn.includes(key)) }))
  return loose.length === 1 ? loose[0] : null
}

export function findSituation(w, ref) {
  const key = norm(ref)
  if (!key) return null
  return w.situations.find((s) => norm(s.name) === key) || w.situations.find((s) => s.aliases.some((a) => norm(a) === key)) || null
}

/** 生图库里「她」是哪个人物条目：设置里指定的 > 按角色名 / 别名找 > 库里只有一个人物时就是它。 */
export function herEntry(cfg, w = loadWardrobe()) {
  if (cfg.imageCharacter) {
    const e = w.characters.find((x) => x.id === cfg.imageCharacter)
    if (e) return e
  }
  const byName = resolveEntry(w.characters, cfg.characterName)
  if (byName) return byName
  return w.characters.length === 1 ? w.characters[0] : null
}

/** 人物库里除了她（以及她的变体，如「Q版小鱼」）以外的人。 */
export function otherPeople(cfg, w = loadWardrobe()) {
  const her = herEntry(cfg, w)
  const names = [cfg.characterName, ...(her ? [her.name, ...her.aliases] : [])].map(norm).filter((n) => n.length >= 2)
  return w.characters.filter((e) => e !== her && ![e.name, ...e.aliases].some((n) => names.some((h) => norm(n).includes(h))))
}

/** 设置页 / 状态接口用的摘要。 */
export function wardrobeSummary(cfg, w = loadWardrobe()) {
  const pick = (e) => ({ id: e.id, name: e.name, aliases: e.aliases, tags: e.tags.slice(0, 6), cover: e.cover, mtime: e.mtime })
  const her = herEntry(cfg, w)
  return {
    available: w.available,
    her: her ? pick(her) : null,
    characters: w.characters.map(pick),
    outfits: w.outfits.map(pick),
    scenes: w.scenes.map(pick),
    props: w.props.map(pick),
    people: otherPeople(cfg, w).map(pick),
    situations: w.situations.map((s) => s.name),
  }
}
