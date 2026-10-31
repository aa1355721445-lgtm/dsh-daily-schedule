/**
 * dsh-daily-schedule 鈥斺€?浼氳瘽鏍囬锛氫粠浼氳瘽鏃ュ織閲岃鍑恒€岃繖涓細璇濆彨浠€涔堛€嶃€? *
 * 浼氳瘽鏃ュ織鏄?<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd锛? * 姣忎釜浜嬩欢涓€甯?zstd锛堣拷鍔犲啓锛夛紝鎵€浠ヨ鎸夊抚鍒囧紑銆侀€愬抚瑙ｃ€傚彧璇绘枃浠跺紑澶翠竴娈碉細
 * 鏍囬浜嬩欢锛坰ession/title锛夊拰绗竴鏉＄敤鎴锋秷鎭兘鍦ㄥ墠闈紝澶熺敤浜嗐€? */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { dshHome } from './store.js'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const HEAD_BYTES = 1024 * 1024
const MAX_FRAMES = 200
const TITLE_MAX = 48
const cache = new Map()

/** 鍜?DSH 鐨?encodeSegment 鍚屼竴濂楄浆涔夛紝鐢ㄦ潵鎷间細璇濈洰褰曞悕銆?*/
function encodeSegment(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out || '~0000'
}

/** 椤圭洰鐩綍鍚嶏細鍒嗛殧绗︽崲鎴?`-`锛屽叾瀹冧笉瀹夊叏瀛楃 `~XXXX`銆?*/
function projectKey(cwd) {
  if (!cwd) return ''
  let readable = ''
  let sep = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sep) readable += '-'
      sep = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      sep = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      sep = false
    }
  }
  return '--' + ((readable.replace(/^-+/, '') || 'root').slice(0, 251)) + '--'
}

function logPath(id, cwd) {
  return path.join(dshHome(), 'sessions', projectKey(cwd), encodeSegment(id), 'session.v4.jsonl.zstd')
}

function readHead(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const len = Math.min(statSync(file).size, HEAD_BYTES)
    const buf = Buffer.alloc(len)
    const got = readSync(fd, buf, 0, len, 0)
    return buf.subarray(0, got)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

function frameStarts(buf) {
  const out = []
  let i = 0
  while (i <= buf.length - 4) {
    const j = buf.indexOf(FRAME_MAGIC, i)
    if (j < 0) break
    out.push(j)
    i = j + 4
  }
  return out
}

/** 浠庢棩蹇楀紑澶磋鍑烘爣棰橈紱娌℃湁鏍囬浜嬩欢灏辩敤绗竴鏉′汉宸ユ秷鎭€?*/
export function readSessionTitle(id, cwd) {
  const key = String(id || '')
  if (!key) return ''
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const buf = readHead(logPath(key, cwd))
  if (!buf) return ''
  const starts = frameStarts(buf)
  let title = ''
  let firstUser = ''
  const limit = Math.min(starts.length, MAX_FRAMES)
  for (let k = 0; k < limit; k++) {
    const from = starts[k]
    const to = k + 1 < limit ? starts[k + 1] : buf.length
    let text = ''
    try { text = zstdDecompressSync(buf.subarray(from, to)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev = null
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'session/title') {
        const t = ev.data && ev.data.title
        if (typeof t === 'string' && t.trim()) title = t.trim()
      } else if (!firstUser && ev.type === 'user/message') {
        const src = ev.data && ev.data.source
        if (src === undefined || src.kind === 'user') {
          const c = ev.data && ev.data.content
          if (Array.isArray(c)) {
            const body = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
            if (body.trim()) firstUser = body.trim()
          }
        }
      }
    }
  }
  const out = (title || firstUser).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  if (out) cache.set(key, out)
  return out
}

/** 娴嬭瘯鐢ㄣ€?*/
export function clearTitleCache() { cache.clear() }
