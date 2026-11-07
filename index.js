// dsh-memory-ui
// Copyright 2026 蝠羽科技 (fuyu-technology)  —  https://github.com/fuyu-technology
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 允许二次修改与再分发，但必须保留上述署名与版权声明，不得删除或改写。
// 详见 LICENSE 与 NOTICE。
//

// dsh-memory-ui —— Host 侧。
//
// 职责：
//   1) 把 DSH 自身的会话数据（短期记忆：活跃上下文 + 最近消息）读出来给设置页
//   2) 维护「长期记忆」与「知识库」两个条目集合，默认落在 ~/.dsh/storages/dsh-memory-ui/
//      支持在面板里改成自定义绝对路径；配置文件固定为 <默认目录>/config.json，不随数据目录漂移
//   3) 复用 DSH 原生的会话归档机制（ctx.workspaceController.archiveSession /
//      unarchiveSession），给设置页提供多选 + 一键归档 / 一键取消
//   4) 彻底删除短期会话：删会话目录 + 投影缓存，并清理 workspace.json 里的引用
//      （归档只是隐藏，删除是物理移除；三个页签都能删）
//
// 数据来源（全部只读，不动 DSH 内部状态）：
//   ~/.dsh/storages/workspace.json                          工作区分组、archivedSessionIds、pinnedSessionIds
//   ~/.dsh/storages/session_projcache/sessions/<sid>.json   会话投影缓存：标题、轮数、token、上下文压力
//   ~/.dsh/sessions/<scope>/<sid>/session.v4.jsonl.zstd      会话正文（多帧 zstd 拼接）
//
// 会话正文是多帧 zstd 拼接的文件，Node 的 zstdDecompressSync 只消费单帧，
// 因此必须按魔数 28 B5 2F FD 切帧后逐帧解压（整段解只会拿到第一帧）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

export const name = 'dsh-memory-ui'

// 只声明 webServer：少了它会抛 `cannot get property "webServer" without inject`。
// workspaceController 用 ctx.get() 惰性取，取不到也不影响面板出现（归档降级为直接改
// workspace.json），避免某天 DSH 调整服务名时整块设置页跟着挂掉。
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// 配置固定放在默认目录下，不随自定义存储目录漂移；自定义目录只影响 memory.json / knowledge.json。
const BASE_DIR = path.join(DSH_HOME, 'storages', 'dsh-memory-ui')
const DEFAULT_DATA_DIR = BASE_DIR
const CONFIG_FILE = path.join(BASE_DIR, 'config.json')
const WORKSPACE_FILE = path.join(DSH_HOME, 'storages', 'workspace.json')
const PROJCACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')

const API_PREFIX = '/dsh-memory'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// ── 通用读写 ────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return value
}

// ── 存储目录配置 ────────────────────────────────────────────────────────────

let configCache = null

/** 规范化配置对象；autoCapture 默认开启，只有显式 false 才关闭。 */
function normalizeConfig(raw) {
  const dir = typeof raw?.storeDir === 'string' ? raw.storeDir.trim() : ''
  const autoCapture = typeof raw?.autoCapture === 'boolean' ? raw.autoCapture : true
  return { storeDir: dir, autoCapture }
}

function readConfig() {
  return normalizeConfig(readJson(CONFIG_FILE, null))
}

function getConfig() {
  if (!configCache) configCache = readConfig()
  return configCache
}

/** 当前生效的数据目录：自定义目录优先，未配置时用默认目录。 */
function dataDir() {
  return getConfig().storeDir || DEFAULT_DATA_DIR
}

function isCustomDir() {
  return !!getConfig().storeDir
}

function collectionFile(collection) {
  if (collection !== 'memory' && collection !== 'knowledge') {
    throw new Error(`未知集合：${collection}`)
  }
  return path.join(dataDir(), collection === 'memory' ? 'memory.json' : 'knowledge.json')
}

function saveConfig(next) {
  fs.mkdirSync(BASE_DIR, { recursive: true })
  const prev = getConfig()
  const merged = {
    storeDir: typeof next?.storeDir === 'string' ? next.storeDir : prev.storeDir,
    autoCapture: typeof next?.autoCapture === 'boolean' ? next.autoCapture : prev.autoCapture !== false
  }
  writeJson(CONFIG_FILE, {
    unit: 'dsh-memory-ui-config',
    version: 1,
    storeDir: merged.storeDir,
    autoCapture: merged.autoCapture,
    updatedAt: new Date().toISOString()
  })
  configCache = merged
  return configCache
}

/** 校验并准备自定义目录：绝对路径、是目录（或可创建）、可写。 */
function validateDataDir(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: '目录不能为空' }
  const dir = input.trim()
  if (!path.isAbsolute(dir)) return { ok: false, error: '请填写绝对路径，例如 D:\\dsh-memory' }
  if (dir.includes('\0')) return { ok: false, error: '路径非法' }
  let stat = null
  try { stat = fs.statSync(dir) } catch { stat = null }
  if (stat && !stat.isDirectory()) return { ok: false, error: '该路径已存在且不是目录' }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.dsh-memory-ui-write-test')
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
  } catch (e) {
    return { ok: false, error: `目录不可写：${e?.message || e}` }
  }
  return { ok: true, dir: path.resolve(dir) }
}

/** 把 memory.json / knowledge.json 从 fromDir 复制到 toDir；目标已存在则保留目标。 */
function migrateDataFiles(fromDir, toDir) {
  const moved = []
  if (!fromDir || !toDir || path.resolve(fromDir) === path.resolve(toDir)) return moved
  for (const name of ['memory.json', 'knowledge.json']) {
    const src = path.join(fromDir, name)
    const dst = path.join(toDir, name)
    try {
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue
      fs.copyFileSync(src, dst)
      moved.push(name)
    } catch {}
  }
  return moved
}

function newId(prefix) {
  const rand = Math.random().toString(16).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

function logQuiet(message) {
  try { console.warn(`[dsh-memory-ui] ${message}`) } catch {}
}

function loadCollection(collection) {
  const file = collectionFile(collection)
  const raw = readJson(file, null)
  if (!raw || !Array.isArray(raw.items)) {
    const empty = { unit: 'dsh-memory-ui', version: 1, collection, updatedAt: new Date().toISOString(), items: [] }
    // 自定义目录不可写时不能把整块面板拖垮：写入失败只记日志，返回内存空集合。
    try { writeJson(file, empty) } catch (e) { logQuiet(`初始化 ${collection}.json 失败：${e?.message || e}`) }
    return empty
  }
  return raw
}

function normalizeEntry(input, base = {}) {
  const now = new Date().toISOString()
  const content = typeof input.content === 'string' ? input.content : (base.content || '')
  return {
    id: typeof input.id === 'string' && input.id ? input.id : (base.id || newId('item')),
    title: (typeof input.title === 'string' ? input.title : (base.title || '')).trim() || '未命名条目',
    content,
    tags: Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean)
      : (base.tags || []),
    sourceSessionId: typeof input.sourceSessionId === 'string'
      ? input.sourceSessionId
      : (base.sourceSessionId || null),
    sourceTitle: typeof input.sourceTitle === 'string'
      ? input.sourceTitle
      : (base.sourceTitle || null),
    archived: typeof input.archived === 'boolean' ? input.archived : !!base.archived,
    pinned: typeof input.pinned === 'boolean' ? input.pinned : !!base.pinned,
    // ── 知识库检索用字段（纯本地关键词，不含模型产物）──
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map((t) => String(t).trim()).filter(Boolean).slice(0, 24)
      : (Array.isArray(base.keywords) ? base.keywords : []),
    auto: typeof input.auto === 'boolean' ? input.auto : !!base.auto,
    signature: typeof input.signature === 'string' && input.signature
      ? input.signature
      : (base.signature || null),
    createdAt: base.createdAt || now,
    updatedAt: now,
    archivedAt: typeof input.archived === 'boolean'
      ? (input.archived ? (base.archivedAt || now) : null)
      : (base.archivedAt || null)
  }
}

function saveEntry(collection, entry) {
  const doc = loadCollection(collection)
  const idx = doc.items.findIndex((it) => it.id === entry.id)
  if (idx >= 0) doc.items[idx] = { ...doc.items[idx], ...entry }
  else doc.items.unshift(entry)
  doc.updatedAt = new Date().toISOString()
  writeJson(collectionFile(collection), doc)
  return doc.items[idx >= 0 ? idx : 0]
}

function setArchivedFlag(collection, ids, archived) {
  const doc = loadCollection(collection)
  const set = new Set(ids)
  const now = new Date().toISOString()
  let changed = 0
  for (const it of doc.items) {
    if (!set.has(it.id)) continue
    it.archived = archived
    it.archivedAt = archived ? now : null
    it.updatedAt = now
    changed++
  }
  doc.updatedAt = now
  writeJson(collectionFile(collection), doc)
  return changed
}

function removeEntries(collection, ids) {
  const doc = loadCollection(collection)
  const set = new Set(ids)
  const before = doc.items.length
  doc.items = doc.items.filter((it) => !set.has(it.id))
  doc.updatedAt = new Date().toISOString()
  writeJson(collectionFile(collection), doc)
  return before - doc.items.length
}

function sortedEntries(collection) {
  const doc = loadCollection(collection)
  return doc.items
    .slice()
    .sort((a, b) => {
      if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    })
}

// ── 会话数据 ────────────────────────────────────────────────────────────────

const BOILERPLATE = ['你在 QQ 上的昵称是', '群聊黑话学习器', '【你的身份】']

function isBoilerplate(text) {
  return typeof text === 'string' && BOILERPLATE.some((b) => text.includes(b))
}

function cleanText(input, max = 80) {
  if (typeof input !== 'string') return ''
  let t = input.replace(/\r\n?/g, '\n')
  t = t.replace(/^【当前时间】[^\n（]*（Asia\/Shanghai）\s*\n*/, '')
  t = t.replace(/^【当前时间】[^\n]*\n*/, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 切 zstd 帧：返回每个帧的起始偏移 */
function frameOffsets(buf) {
  const offsets = []
  let p = 0
  while (true) {
    const i = buf.indexOf(ZSTD_MAGIC, p)
    if (i < 0) break
    offsets.push(i)
    p = i + 4
  }
  return offsets
}

function inflateFrame(buf, start, end) {
  try {
    return zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  } catch {
    return null
  }
}

/** 只解首帧拿会话头（cwd / createdAt / agentPreset），最多读 64KB */
function readSessionHeader(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const head = Buffer.alloc(Math.min(65536, size))
      fs.readSync(fd, head, 0, head.length, 0)
      const next = head.indexOf(ZSTD_MAGIC, 4)
      const end = next < 0 ? head.length : next
      const text = inflateFrame(head, 0, end)
      if (!text) return null
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'session') return obj
        } catch {}
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {}
  return null
}

function readProjCache(sessionId) {
  const file = path.join(PROJCACHE_DIR, `${sessionId}.json`)
  const raw = readJson(file, null)
  const rows = raw?.record?.rows
  if (!rows) return {}
  const val = (key) => rows[key]?.val ?? null
  return {
    projTitle: typeof val('title') === 'string' ? val('title') : null,
    firstInput: val('titleInput')?.first?.text ?? null,
    agentPreset: typeof val('agentPreset') === 'string' ? val('agentPreset') : null,
    turns: val('sessionStats')?.turns ?? null,
    steps: val('sessionStats')?.steps ?? null,
    surfaceTokens: val('contextPressure')?.surfaceTokens ?? null,
    contextWindow: val('contextPressure')?.contextWindow ?? null,
    tokens: val('tokenUsage')?.totals ?? null,
    lastPromptAt: val('sessionListMetadata')?.lastPromptAt ?? null,
    model: val('modelSelection')?.lastUsed ?? null
  }
}

function readWorkspaceState() {
  const raw = readJson(WORKSPACE_FILE, null)
  const global = raw?.global || {}
  const bySession = new Map()
  for (const [workspaceId, ws] of Object.entries(raw?.tables?.workspaces || {})) {
    for (const sid of ws?.sessionIds || []) {
      bySession.set(sid, { workspaceId, workspaceTitle: ws?.title || '', workspacePath: ws?.path || '' })
    }
  }
  return {
    archivedSessionIds: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [],
    pinnedSessionIds: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : [],
    bySession
  }
}

let sessionsCache = { at: 0, data: null, key: '' }

function scanSessions(force = false, archivedOverride = null) {
  const now = Date.now()
  if (!force && sessionsCache.data && now - sessionsCache.at < 8000) return sessionsCache.data

  const ws = readWorkspaceState()
  const archived = new Set(Array.isArray(archivedOverride) ? archivedOverride : ws.archivedSessionIds)
  const pinned = new Set(ws.pinnedSessionIds)
  const out = []

  let scopes = []
  try {
    scopes = fs.readdirSync(SESSIONS_ROOT).filter((d) => d.startsWith('--'))
  } catch {
    scopes = []
  }

  for (const scope of scopes) {
    const dir = path.join(SESSIONS_ROOT, scope)
    let ids = []
    try {
      ids = fs.readdirSync(dir).filter((d) => d.startsWith('session-'))
    } catch {
      continue
    }
    for (const sessionId of ids) {
      const file = path.join(dir, sessionId, 'session.v4.jsonl.zstd')
      let stat = null
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      const proj = readProjCache(sessionId)
      const header = readSessionHeader(file)
      const wsInfo = ws.bySession.get(sessionId) || null

      const rawTitle = proj.projTitle || null
      const boiler = isBoilerplate(rawTitle)
      let title = boiler ? '' : cleanText(rawTitle, 60)
      if (!title) {
        const preset = proj.agentPreset || header?.agentPreset || ''
        title = preset ? `（自动会话 · ${preset}）` : '（未命名会话）'
      }
      const preview = boiler ? '' : cleanText(proj.firstInput, 90)

      out.push({
        sessionId,
        scope,
        cwd: header?.cwd || wsInfo?.workspacePath || '',
        createdAt: header?.createdAt || stat.birthtimeMs || null,
        agentPreset: proj.agentPreset || header?.agentPreset || null,
        title,
        preview,
        boilerplate: boiler,
        sizeBytes: stat.size,
        mtime: stat.mtimeMs,
        workspaceId: wsInfo?.workspaceId || null,
        workspaceTitle: wsInfo?.workspaceTitle || null,
        knownToWorkspace: !!wsInfo,
        archived: archived.has(sessionId),
        pinned: pinned.has(sessionId),
        turns: proj.turns,
        steps: proj.steps,
        surfaceTokens: proj.surfaceTokens,
        contextWindow: proj.contextWindow,
        tokens: proj.tokens || null,
        lastPromptAt: proj.lastPromptAt || null,
        model: proj.model || null,
        hasProjCache: !!(proj.agentPreset || proj.turns != null)
      })
    }
  }

  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  sessionsCache = { at: now, data: out, key: `${now}` }
  return out
}

function summarizeContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
  }
  return parts.join('\n').trim()
}

/** 从会话尾部往前解帧，凑够 limit 条消息为止 */
function readRecentMessages(file, limit = 20) {
  const messages = []
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return messages
  }
  const offsets = frameOffsets(buf)
  if (!offsets.length) return messages
  const batches = []
  let collected = 0
  for (let k = offsets.length - 1; k >= 0 && collected < limit; k--) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    const text = inflateFrame(buf, start, end)
    if (!text) continue
    const batch = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj.type === 'user/message') {
        const body = summarizeContent(obj.data?.content)
        if (!body) continue
        batch.push({
          role: 'user',
          text: body,
          time: obj.time || null,
          kind: obj.data?.source?.kind || 'user'
        })
      } else if (obj.type === 'assistant/message') {
        const body = summarizeContent(obj.data?.message?.content)
        if (!body) continue
        batch.push({
          role: 'assistant',
          text: body,
          time: obj.time || null,
          model: obj.data?.message?.source?.model || null,
          usage: obj.data?.usage || null
        })
      }
    }
    if (batch.length) {
      batches.unshift(batch)
      collected += batch.length
    }
  }
  for (const batch of batches) messages.push(...batch)
  return messages.slice(-limit)
}

function findSession(sessionId) {
  for (const s of scanSessions()) {
    if (s.sessionId === sessionId) return s
  }
  return null
}

// ── 彻底删除会话（短期记忆）──────────────────────────────────────────────────
// 会话列表是从磁盘扫出来的，所以「彻底删除」必须落到文件：
//   1) 删 <sessions>/<scope>/<sid>/ 整个目录（会话正文等多帧 zstd 都在里面）
//   2) 删 <storages>/session_projcache/sessions/<sid>.json 投影缓存
//   3) 从 workspace.json 抹掉该 sid 的引用（归档集 / 置顶集 / 各工作区 sessionIds）
// 归档（archive）只隐藏，删除是物理移除；两步都容错，逐条上报结果。

/** 定位会话的磁盘目录：按 scope 逐个查 <sessions>/<scope>/<sid>。只接受目录名形态的 id。 */
function locateSessionDir(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  // 挡掉路径穿越：会话 id 只能是目录名，不能含分隔符、.. 或 NUL。
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..') || sessionId.includes('\0')) {
    return null
  }
  let scopes = []
  try { scopes = fs.readdirSync(SESSIONS_ROOT) } catch { return null }
  for (const scope of scopes) {
    const dir = path.join(SESSIONS_ROOT, scope, sessionId)
    try {
      if (fs.statSync(dir).isDirectory()) return dir
    } catch {}
  }
  return null
}

/** 从 workspace.json 里抹掉某会话的引用；返回是否真的改动了文件。 */
function removeSessionRefs(sessionId) {
  const raw = readJson(WORKSPACE_FILE, null)
  if (!raw) return false
  let changed = false
  const drop = (arr) => {
    if (!Array.isArray(arr)) return arr
    const next = arr.filter((x) => x !== sessionId)
    if (next.length !== arr.length) changed = true
    return next
  }
  if (raw.global) {
    raw.global.archivedSessionIds = drop(raw.global.archivedSessionIds)
    raw.global.pinnedSessionIds = drop(raw.global.pinnedSessionIds)
  }
  for (const ws of Object.values(raw?.tables?.workspaces || {})) {
    if (Array.isArray(ws?.sessionIds)) ws.sessionIds = drop(ws.sessionIds)
  }
  if (changed) {
    try { writeJson(WORKSPACE_FILE, raw) } catch (e) {
      logQuiet(`清理 workspace.json 引用失败：${e?.message || e}`)
    }
  }
  return changed
}

/** 彻底删除一条会话：删目录 + 投影缓存 + workspace.json 引用；逐项容错。 */
function deleteSessionById(sessionId) {
  const out = { sessionId, ok: false, removedDir: false, removedCache: false, removedRefs: false, error: null }
  if (typeof sessionId !== 'string' || !sessionId) {
    out.error = '会话 id 非法'
    return out
  }
  const dir = locateSessionDir(sessionId)
  if (!dir) {
    out.error = '找不到该会话目录（可能已被删除）'
    return out
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch (e) {
    out.error = `删除会话目录失败：${e?.message || e}`
  }
  out.removedDir = !fs.existsSync(dir)
  try {
    const cache = path.join(PROJCACHE_DIR, `${sessionId}.json`)
    if (fs.existsSync(cache)) {
      fs.rmSync(cache, { force: true })
      out.removedCache = true
    }
  } catch {}
  try { out.removedRefs = removeSessionRefs(sessionId) } catch {}
  out.ok = out.removedDir
  if (!out.ok && !out.error) out.error = '删除失败'
  return out
}

// ── 归档 / 取消归档 ─────────────────────────────────────────────────────────

function workspaceControllerOf(ctx) {
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get('workspaceController') : undefined
    if (svc && typeof svc.archiveSession === 'function') return svc
  } catch {}
  try {
    const svc = ctx?.workspaceController
    if (svc && typeof svc.archiveSession === 'function') return svc
  } catch {}
  return null
}

/** 服务不可用时的兜底：直接改 workspace.json。DSH 运行中可能用内存态覆盖回去。 */
function fileFallbackArchive(ctx, ids, archived) {
  const raw = readJson(WORKSPACE_FILE, null)
  if (!raw || !raw.global) return { ok: false, error: '读不到 workspace.json' }
  const current = new Set(Array.isArray(raw.global.archivedSessionIds) ? raw.global.archivedSessionIds : [])
  for (const id of ids) {
    if (archived) current.add(id)
    else current.delete(id)
  }
  raw.global.archivedSessionIds = Array.from(current)
  writeJson(WORKSPACE_FILE, raw)
  return { ok: true, archivedSessionIds: raw.global.archivedSessionIds, requiresRestart: true }
}

async function findArchiveServiceReason(ctx) {
  const svc = workspaceControllerOf(ctx)
  if (svc) return null
  return 'ctx.workspaceController 不可用（DSH 未提供该服务或已被改名）'
}

async function doArchive(ctx, ids, stopActivity) {
  const svc = workspaceControllerOf(ctx)
  if (!svc) {
    const fallback = fileFallbackArchive(ctx, ids, true)
    return {
      ok: !!fallback.ok,
      mode: 'file-fallback',
      results: ids.map((sessionId) => ({ sessionId, ok: !!fallback.ok, error: fallback.error || null })),
      archivedSessionIds: fallback.archivedSessionIds || [],
      requiresRestart: true,
      notice: fallback.ok ? '归档函数不可用，已直接写入 workspace.json，重启 DSH 后生效。' : fallback.error
    }
  }
  const results = []
  // live 从当前归档集起算，再用服务返回的完整列表覆盖；这样响应里的 archivedSessionIds
  // 与逐条结果一致，不依赖 DSH 是否已经把这轮改动落盘。
  const live = new Set(readWorkspaceState().archivedSessionIds)
  for (const sessionId of ids) {
    try {
      const ret = await svc.archiveSession({ sessionId, stopActivity: !!stopActivity })
      const list = Array.isArray(ret?.archivedSessionIds) ? ret.archivedSessionIds : null
      if (list) {
        live.clear()
        for (const x of list) live.add(x)
      } else {
        live.add(sessionId)
      }
      results.push({ sessionId, ok: true, archived: list ? list.includes(sessionId) : true })
    } catch (e) {
      results.push({
        sessionId,
        ok: false,
        error: e?.message || String(e),
        code: e?.code || e?.name || null
      })
    }
  }
  sessionsCache = { at: 0, data: null, key: '' }
  return {
    ok: results.every((r) => r.ok),
    mode: 'service',
    results,
    archivedSessionIds: [...live]
  }
}

async function doUnarchive(ctx, ids) {
  const svc = workspaceControllerOf(ctx)
  if (!svc || typeof svc.unarchiveSession !== 'function') {
    const fallback = fileFallbackArchive(ctx, ids, false)
    return {
      ok: !!fallback.ok,
      mode: 'file-fallback',
      results: ids.map((sessionId) => ({ sessionId, ok: !!fallback.ok, error: fallback.error || null })),
      archivedSessionIds: fallback.archivedSessionIds || [],
      requiresRestart: true,
      notice: fallback.ok ? '取消归档函数不可用，已直接写入 workspace.json，重启 DSH 后生效。' : fallback.error
    }
  }
  const results = []
  const live = new Set(readWorkspaceState().archivedSessionIds)
  for (const sessionId of ids) {
    try {
      const ret = await svc.unarchiveSession({ sessionId })
      const list = Array.isArray(ret?.archivedSessionIds) ? ret.archivedSessionIds : null
      if (list) {
        live.clear()
        for (const x of list) live.add(x)
      } else {
        live.delete(sessionId)
      }
      results.push({ sessionId, ok: true, archived: list ? list.includes(sessionId) : false })
    } catch (e) {
      results.push({
        sessionId,
        ok: false,
        error: e?.message || String(e),
        code: e?.code || e?.name || null
      })
    }
  }
  sessionsCache = { at: 0, data: null, key: '' }
  return {
    ok: results.every((r) => r.ok),
    mode: 'service',
    results,
    archivedSessionIds: [...live]
  }
}

/** 把选中会话沉淀成长期记忆 / 知识库条目（同一条会话重复提取会原地更新） */
function promoteSessions(ctx, ids, collection) {
  const sessions = scanSessions(true).filter((s) => ids.includes(s.sessionId))
  const created = []
  for (const s of sessions) {
    const lines = []
    if (s.workspaceTitle) lines.push(`工作区：${s.workspaceTitle}`)
    if (s.cwd) lines.push(`路径：${s.cwd}`)
    if (s.turns != null) lines.push(`轮数：${s.turns}`)
    if (s.model?.provider) lines.push(`模型：${s.model.provider}/${s.model.model || ''}`)
    if (s.mtime) lines.push(`最近活动：${new Date(s.mtime).toLocaleString('zh-CN')}`)
    if (s.preview) lines.push(`首条输入：${s.preview}`)
    // 同一会话在该集合里只保留一条条目：优先复用同 id 的人工条目，其次接管「归档自动写入」
    // 的条目，避免「已自动写入过、又点一次提取」在同一集合留下两条重复。
    const defaultId = `${collection === 'memory' ? 'mem' : 'kb'}-${s.sessionId}`
    const doc = loadCollection(collection)
    const existing =
      doc.items.find((it) => it.id === defaultId) ||
      doc.items.find((it) => it.sourceSessionId === s.sessionId)
    const entry = normalizeEntry({
      title: s.title,
      content: lines.join('\n'),
      tags: [s.agentPreset, s.workspaceTitle].filter(Boolean),
      sourceSessionId: s.sessionId,
      sourceTitle: s.title,
      // 人工提取后不再标 auto，后续归档触发的自动写入就不会把它覆盖回精简片段
      auto: false,
      ...(existing ? {} : { id: defaultId })
    }, existing || {})
    created.push(saveEntry(collection, entry))
  }
  return created
}

// ── 纯本地知识库：关键词抽取 / 倒排索引 / 检索（全程零模型调用）────────────────
//
// 目的：给「自动写入 + 按需召回」提供零模型成本的底座。
//   1. 写入：把会话压成一条条目（关键词 + 精简片段）直接落到 <存储目录>/knowledge.json，
//      不需要人工点「提取」；归档动作也会自动触发。
//   2. 索引：<存储目录>/index.json 存倒排表（关键词 → 条目 id），按集合文件指纹自动重建。
//   3. 召回：GET /search 只回 top-k 条精简片段，每段有硬上限，
//      上层按需取几条即可，不必把整段历史或完整条目塞进上下文 —— 这是省 token 的关键。

const INDEX_UNIT = 'dsh-memory-ui-index'
const SEARCH_K_MAX = 10
const SNIPPET_MAX_CAP = 1000

/** 单字停用字：仅由这些字组成的中文 gram 直接丢弃。 */
const ZH_STOP_CHARS = new Set([
  '的', '是', '了', '在', '和', '与', '就', '有', '我', '你', '他', '她', '它', '们', '这', '那',
  '哪', '个', '些', '很', '也', '都', '不', '没', '要', '会', '能', '可', '对', '上', '下', '来',
  '去', '做', '说', '想', '如', '果', '为', '所', '以', '但', '而', '其', '实', '什', '么', '怎',
  '一', '直', '经', '还', '现', '目', '前', '通', '使', '进', '需', '出', '自', '样', '候', '问', '题'
])

const ZH_STOP_WORDS = new Set([
  '我们', '你们', '他们', '她们', '咱们', '什么', '怎么', '这个', '那个', '哪个', '这些', '那些',
  '可以', '就是', '不是', '没有', '因为', '所以', '但是', '而且', '如果', '然后', '现在', '已经',
  '还是', '一个', '自己', '这样', '那样', '时候', '问题', '需要', '进行', '通过', '使用', '出现',
  '一些', '一直', '这种', '那种', '非常', '特别', '感觉', '知道', '觉得', '应该', '可能', '或者',
  '以及', '还有', '只是', '不过', '真的', '一样', '很多', '多少', '这里', '那里', '之后', '之前',
  '以后', '以前', '于是', '的话'
])

const EN_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'yours', 'are', 'was', 'were', 'have',
  'has', 'had', 'not', 'but', 'can', 'will', 'would', 'could', 'should', 'from', 'they', 'them',
  'then', 'than', 'into', 'about', 'our', 'ours', 'its', 'it', 'is', 'be', 'been', 'being', 'as',
  'at', 'on', 'in', 'to', 'of', 'or', 'by', 'we', 'he', 'she', 'do', 'does', 'did', 'so', 'if',
  'all', 'any', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'very', 'just', 'also', 'there', 'here', 'while', 'because',
  'over', 'under', 'again', 'once', 'no', 'nor', 'off', 'per', 'via', 'get', 'got', 'use', 'used',
  'using', 'one', 'two', 'out', 'up', 'down', 'too'
])

function collapseWs(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim()
}

function truncateText(text, max) {
  const s = collapseWs(text).replace(/\n+/g, ' ⏎ ')
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

/** 会话预览里的套话（时间戳 / 会话令牌 / 身份提示）不进片段与关键词。 */
function isBoilerplateText(text) {
  const s = collapseWs(text)
  if (!s) return true
  if (/^https?:\/\/\S+$/.test(s)) return true
  if (/^【[^】]{1,24}】/.test(s) && s.length < 200) return true
  return false
}

function isStopToken(token) {
  if (!token || token.length < 2) return true
  if (EN_STOP.has(token) || ZH_STOP_WORDS.has(token)) return true
  if (/^[\d_\-.]+$/.test(token)) return true
  if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(token)) return true
  if (/^[\u4e00-\u9fa5]+$/.test(token) && [...token].every((ch) => ZH_STOP_CHARS.has(ch))) return true
  return false
}

/** 本地分词：英文/数字词整体成词；连续汉字段切 2-gram 与 3-gram。 */
function tokenize(text) {
  const out = []
  const s = collapseWs(text)
  if (!s) return out
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,23}/g)) out.push(m[0].toLowerCase())
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0]
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= seg.length; i += 1) out.push(seg.slice(i, i + n))
    }
  }
  return out
}

/** 词频取 top-N 关键词；被更高频长词覆盖的短词不再单列。 */
function extractKeywords(text, limit = 12) {
  const counts = new Map()
  for (const raw of tokenize(text)) {
    if (isStopToken(raw)) continue
    counts.set(raw, (counts.get(raw) || 0) + 1)
  }
  const cands = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1)
  )
  const picked = []
  for (const [term, count] of cands) {
    if (picked.length >= limit) break
    if (picked.some((p) => p.term.includes(term) && p.count >= count)) continue
    picked.push({ term, count })
  }
  return picked
}

/** 精简片段：会话元信息 + 首条真实用户输入 + 末条回复，硬上限 700 字。 */
function buildCaptureSnippet(meta, messages) {
  const lines = []
  if (meta.workspaceTitle) lines.push(`工作区：${collapseWs(meta.workspaceTitle)}`)
  if (meta.title) lines.push(`会话：${collapseWs(meta.title)}`)
  if (meta.turns != null) lines.push(`轮数：${meta.turns}`)
  const list = Array.isArray(messages) ? messages : []
  const users = list.filter((m) => m.role === 'user' && !isBoilerplateText(m.text))
  const bots = list.filter((m) => m.role === 'assistant' && !isBoilerplateText(m.text))
  if (users.length) lines.push(`用户：${truncateText(users[0].text, 160)}`)
  if (bots.length) lines.push(`回复：${truncateText(bots[bots.length - 1].text, 220)}`)
  return lines.join('\n').slice(0, 700)
}

function indexFile() {
  return path.join(dataDir(), 'index.json')
}

/** 集合文件指纹：大小 + mtime + 条数。变了就重建倒排表，避免增量维护出错。 */
function collectionFingerprint(collection) {
  let size = 0
  let mtime = 0
  try {
    const st = fs.statSync(collectionFile(collection))
    size = st.size
    mtime = Math.round(st.mtimeMs)
  } catch {}
  let count = 0
  try { count = loadCollection(collection).items.length } catch {}
  return `${size}:${mtime}:${count}`
}

function emptyCollectionIndex() {
  return { fingerprint: '', postings: {}, entries: {} }
}

function loadIndexDoc() {
  const raw = readJson(indexFile(), null)
  if (!raw || raw.unit !== INDEX_UNIT || !raw.collections) {
    return {
      unit: INDEX_UNIT,
      version: 1,
      updatedAt: null,
      collections: { memory: emptyCollectionIndex(), knowledge: emptyCollectionIndex() }
    }
  }
  for (const name of ['memory', 'knowledge']) {
    if (!raw.collections[name]) raw.collections[name] = emptyCollectionIndex()
  }
  return raw
}

function saveIndexDoc(doc) {
  doc.updatedAt = new Date().toISOString()
  try { writeJson(indexFile(), doc) } catch (e) { logQuiet(`写 index.json 失败：${e?.message || e}`) }
  return doc
}

/** 条目关键词：优先用已存字段，缺失时本地现算（老条目也能被检索到）。 */
function entryKeywords(entry) {
  if (Array.isArray(entry.keywords) && entry.keywords.length) return entry.keywords.slice(0, 24)
  return extractKeywords(`${entry.title || ''}\n${entry.content || ''}`, 12).map((x) => x.term)
}

/** 重建某集合的倒排表：postings = 关键词 → [条目 id]。 */
function rebuildCollectionIndex(doc, collection) {
  const col = emptyCollectionIndex()
  for (const it of loadCollection(collection).items) {
    const kws = entryKeywords(it)
    col.entries[it.id] = {
      title: it.title || '',
      keywords: kws,
      archived: !!it.archived,
      updatedAt: it.updatedAt || null
    }
    for (const k of kws) {
      if (!col.postings[k]) col.postings[k] = []
      if (!col.postings[k].includes(it.id)) col.postings[k].push(it.id)
    }
  }
  col.fingerprint = collectionFingerprint(collection)
  doc.collections[collection] = col
  return doc
}

/** 取（必要时重建）指定集合的倒排索引。 */
function ensureCollectionIndex(collection) {
  const doc = loadIndexDoc()
  const want = collectionFingerprint(collection)
  if (doc.collections[collection].fingerprint !== want) {
    rebuildCollectionIndex(doc, collection)
    saveIndexDoc(doc)
  }
  return doc.collections[collection]
}

/**
 * 关键词检索：返回 top-k 精简片段（默认 3 条 × 200 字），不回完整条目。
 * 打分：命中索引关键词长词 3 分、短词 2 分；子串兜底 +1；同分按更新时间倒序。
 */
function searchEntries(collection, query, k = 3, snippetMax = 200) {
  const col = ensureCollectionIndex(collection)
  const terms = []
  for (const t of extractKeywords(query, 8)) terms.push(t.term)
  for (const t of tokenize(query)) if (!isStopToken(t)) terms.push(t)
  const uniq = [...new Set(terms)].filter(Boolean)

  const score = new Map()
  const postings = col.postings || {}
  for (const t of uniq) {
    const w = t.length >= 3 ? 3 : 2
    for (const id of postings[t] || []) score.set(id, (score.get(id) || 0) + w)
    for (const [key, ids2] of Object.entries(postings)) {
      if (key === t) continue
      if (key.includes(t) || t.includes(key)) {
        for (const id of ids2) score.set(id, (score.get(id) || 0) + 1)
      }
    }
  }

  // 兜底召回：关键词只存 top-N，低频词（例如只在回复里出现的英文术语）会掉出索引，
  // 单靠 postings 会「明明正文里有却搜不到」。这里再按标题/正文字面包含补分，
  // 把口径修正为「真出现过就能被找到」。纯字符串比较，零模型调用。
  const allItems = loadCollection(collection).items
  if (uniq.length) {
    for (const it of allItems) {
      const title = String(it.title || '').toLowerCase()
      const body = String(it.content || '').toLowerCase()
      let bonus = 0
      for (const t of uniq) {
        if (title.includes(t)) bonus += 3
        else if (body.includes(t)) bonus += 1
      }
      if (bonus) score.set(it.id, (score.get(it.id) || 0) + bonus)
    }
  }

  const items = new Map(allItems.map((it) => [it.id, it]))
  const ranked = []
  for (const [id, s] of score.entries()) {
    const it = items.get(id)
    if (it) ranked.push({ entry: it, score: s })
  }
  if (!ranked.length && !String(query || '').trim()) {
    for (const it of loadCollection(collection).items.slice(0, k)) ranked.push({ entry: it, score: 0 })
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(b.entry.updatedAt || '').localeCompare(String(a.entry.updatedAt || ''))
  })
  const max = Math.min(Math.max(Number(k) || 3, 1), SEARCH_K_MAX)
  const cap = Math.min(Math.max(Number(snippetMax) || 200, 40), SNIPPET_MAX_CAP)
  const results = ranked.slice(0, max).map(({ entry, score: s }) => ({
    id: entry.id,
    title: entry.title,
    score: s,
    keywords: (Array.isArray(entry.keywords) ? entry.keywords : []).slice(0, 8),
    snippet: truncateText(entry.content, cap),
    auto: !!entry.auto,
    sourceSessionId: entry.sourceSessionId || null,
    updatedAt: entry.updatedAt || null
  }))
  return { terms: uniq, indexSize: Object.keys(postings).length, results }
}

/**
 * 把一条会话压成知识库条目：纯本地关键词 + 精简片段，零模型调用。
 * 去重：同会话的自动条目原地更新；关键词签名重复的条目跳过。
 */
function captureSession(sessionId, collection = 'knowledge', opts = {}) {
  const name = collection === 'memory' ? 'memory' : 'knowledge'
  const meta = findSession(sessionId)
  if (!meta) return { ok: false, sessionId, error: '找不到该会话' }
  const file = path.join(SESSIONS_ROOT, meta.scope, sessionId, 'session.v4.jsonl.zstd')
  const messages = readRecentMessages(file, opts.messageLimit || 30)
  const textForKeywords = [
    meta.title,
    meta.preview,
    meta.workspaceTitle,
    meta.agentPreset,
    ...messages.map((m) => m.text)
  ].filter(Boolean).join('\n')
  const keywords = extractKeywords(textForKeywords, 12).map((x) => x.term)
  const title = meta.title || '（未命名会话）'
  const content = buildCaptureSnippet(meta, messages)
  const signature = `${name}|${title}|${keywords.slice(0, 5).join(',')}`

  const doc = loadCollection(name)
  const sameSession = doc.items.find((it) => it.sourceSessionId === sessionId)

  // 该会话已有「人工提取/编辑」的条目 → 不覆盖用户内容，也不另建一条
  if (sameSession && !sameSession.auto && !opts.force) {
    return {
      ok: true, sessionId, created: false, updated: false, skipped: true,
      keptManual: true, id: sameSession.id, title, keywords
    }
  }

  if (!sameSession && !opts.force) {
    const dup = doc.items.find((it) => it.signature && it.signature === signature)
    if (dup) {
      return { ok: true, sessionId, created: false, updated: false, skipped: true, dedupOf: dup.id, title, keywords }
    }
  }
  if (
    sameSession &&
    sameSession.content === content &&
    (sameSession.keywords || []).join(',') === keywords.join(',')
  ) {
    return { ok: true, sessionId, created: false, updated: false, unchanged: true, id: sameSession.id, title, keywords }
  }

  const entry = normalizeEntry({
    id: sameSession?.id || `${name === 'memory' ? 'mem' : 'kb'}-auto-${sessionId}`,
    title,
    content,
    keywords,
    auto: true,
    signature,
    tags: [meta.agentPreset, meta.workspaceTitle].filter(Boolean),
    sourceSessionId: sessionId,
    sourceTitle: title
  }, sameSession || {})
  const saved = saveEntry(name, entry)
  return {
    ok: true,
    sessionId,
    id: saved.id,
    created: !sameSession,
    updated: !!sameSession,
    skipped: false,
    title: saved.title,
    keywords: saved.keywords,
    chars: content.length
  }
}

/** 归档后自动写入知识库（受配置 autoCapture 控制，纯本地）。 */
function autoCaptureAfterArchive(results, collection = 'knowledge') {
  if (getConfig().autoCapture === false) return []
  const out = []
  for (const r of Array.isArray(results) ? results : []) {
    if (!r?.ok) continue
    try {
      const c = captureSession(r.sessionId, collection)
      // 只把「真的新建/更新了条目」的结果算作 captured；未变、按签名去重、命中人工条目都跳过
      if (c?.ok && (c.created || c.updated)) out.push(c)
    } catch (e) {
      out.push({ ok: false, sessionId: r.sessionId, error: e?.message || String(e) })
    }
  }
  return out
}

/** 批量写入：把还没自动写入过的会话补进知识库（force=true 时整批重写）。 */
function captureMany(ids, collection = 'knowledge', opts = {}) {
  const out = []
  for (const id of Array.isArray(ids) ? ids : []) out.push(captureSession(id, collection, opts))
  return out
}

// ── 请求处理 ────────────────────────────────────────────────────────────────

function sendJson(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > 4e6) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function idsOf(body) {
  if (Array.isArray(body.sessionIds)) return body.sessionIds.filter((s) => typeof s === 'string')
  if (Array.isArray(body.ids)) return body.ids.filter((s) => typeof s === 'string')
  if (typeof body.id === 'string') return [body.id]
  return []
}

function buildState(ctx, archivedOverride = null) {
  const sessions = scanSessions(!!archivedOverride, archivedOverride)
  const ws = readWorkspaceState()
  const memory = sortedEntries('memory')
  const knowledge = sortedEntries('knowledge')
  const svc = workspaceControllerOf(ctx)
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    storeDir: dataDir(),
    defaultStoreDir: DEFAULT_DATA_DIR,
    configFile: CONFIG_FILE,
    customDir: isCustomDir(),
    // 归档时是否自动写入知识库（纯本地关键词抽取，零模型调用）
    autoCapture: getConfig().autoCapture !== false,
    indexFile: indexFile(),
    archive: {
      serviceAvailable: !!svc,
      mode: svc ? 'service' : 'file-fallback',
      reason: svc ? null : 'ctx.workspaceController 不可用，归档会直接写入 workspace.json（需重启 DSH 生效）'
    },
    stats: {
      sessionCount: sessions.length,
      archivedCount: sessions.filter((s) => s.archived).length,
      pinnedCount: sessions.filter((s) => s.pinned).length,
      memoryCount: memory.length,
      memoryArchived: memory.filter((m) => m.archived).length,
      knowledgeCount: knowledge.length,
      knowledgeArchived: knowledge.filter((k) => k.archived).length,
      knowledgeAuto: knowledge.filter((k) => k.auto).length,
      memoryAuto: memory.filter((m) => m.auto).length
    },
    sessions,
    memory,
    knowledge
  }
}

function apply(ctx) {
  let webServer
  try {
    webServer = (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined) || ctx?.webServer
  } catch {
    webServer = ctx?.webServer
  }

  try { fs.mkdirSync(BASE_DIR, { recursive: true }) } catch {}
  try { fs.mkdirSync(dataDir(), { recursive: true }) } catch (e) {
    logQuiet(`自定义存储目录不可用（${dataDir()}）：${e?.message || e}；已回退内存空集合`)
  }
  loadCollection('memory')
  loadCollection('knowledge')

  if (!webServer || typeof webServer.register !== 'function') {
    try {
      ctx?.logger?.warn?.('[dsh-memory-ui] webServer 不可用，设置页 API 路由未注册')
    } catch {}
    return
  }

  const disposers = []

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    try {
      // ── 总览 ──
      if (route === '/state' && req.method === 'GET') {
        sendJson(res, 200, buildState(ctx))
        return true
      }

      // ── 单个会话的最近消息（短期记忆正文） ──
      if (route === '/session' && req.method === 'GET') {
        const sessionId = url.searchParams.get('id') || ''
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100)
        const meta = findSession(sessionId)
        if (!meta) {
          sendJson(res, 404, { ok: false, error: '找不到该会话' })
          return true
        }
        const file = path.join(SESSIONS_ROOT, meta.scope, sessionId, 'session.v4.jsonl.zstd')
        sendJson(res, 200, { ok: true, session: meta, messages: readRecentMessages(file, limit) })
        return true
      }

      // ── 关键词检索：只回 top-k 精简片段（省 token 的关键） ──
      if (route === '/search' && req.method === 'GET') {
        const collection = url.searchParams.get('collection') === 'memory' ? 'memory' : 'knowledge'
        const query = url.searchParams.get('q') || ''
        const k = Math.min(Math.max(Number(url.searchParams.get('k')) || 3, 1), 10)
        const snippetMax = Math.min(Math.max(Number(url.searchParams.get('snippetMax')) || 200, 40), 1000)
        const found = searchEntries(collection, query, k, snippetMax)
        // 刻意不回 state：检索路径保持最小响应体，避免把面板全量数据塞回调用方上下文。
        sendJson(res, 200, { ok: true, collection, query, ...found })
        return true
      }

      const POST_ROUTES = ['/archive', '/unarchive', '/session-delete', '/entry', '/promote', '/config', '/capture']
      const GET_ROUTES = ['/state', '/session', '/search']
      if (!POST_ROUTES.includes(route) && !GET_ROUTES.includes(route)) {
        sendJson(res, 404, { ok: false, error: `未知接口：${route}` })
        return true
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `不支持的请求方法：${req.method}` })
        return true
      }

      const body = await readBody(req)

      // ── 会话归档（成功后按配置自动写入知识库，纯本地） ──
      if (route === '/archive') {
        const ids = idsOf(body)
        if (!ids.length) {
          sendJson(res, 400, { ok: false, error: '没有选择会话' })
          return true
        }
        const result = await doArchive(ctx, ids, body.stopActivity !== false)
        const captured = autoCaptureAfterArchive(result.results)
        sendJson(res, result.ok ? 200 : 207, {
          ...result,
          autoCapture: getConfig().autoCapture !== false,
          captured: captured.length,
          capturedEntries: captured.slice(0, 20),
          state: buildState(ctx, result.archivedSessionIds)
        })
        return true
      }

      // ── 手动写入知识库：把选中会话压成条目；all=true 时把还没写入过的会话一次补齐 ──
      if (route === '/capture') {
        const collection = body.collection === 'memory' ? 'memory' : 'knowledge'
        const force = body.force === true
        let ids = idsOf(body)
        if (body.all) {
          // 只要该会话已在本集合有条目（无论自动写入还是人工提取）就不再重复补写
          const done = new Set(
            loadCollection(collection).items.filter((it) => it.sourceSessionId).map((it) => it.sourceSessionId)
          )
          ids = scanSessions(true)
            .filter((s) => force || !done.has(s.sessionId))
            .map((s) => s.sessionId)
        }
        if (!ids.length) {
          sendJson(res, 400, { ok: false, error: '没有可写入的会话' })
          return true
        }
        const entries = captureMany(ids, collection, { force })
        sendJson(res, 200, {
          ok: true,
          collection,
          created: entries.filter((e) => e.ok && e.created).length,
          updated: entries.filter((e) => e.ok && e.updated).length,
          skipped: entries.filter((e) => e.ok && e.skipped).length,
          unchanged: entries.filter((e) => e.ok && e.unchanged).length,
          failed: entries.filter((e) => !e.ok).length,
          entries: entries.slice(0, 40),
          state: buildState(ctx)
        })
        return true
      }

      // ── 彻底删除会话（短期记忆）：删磁盘目录 + 投影缓存 + workspace.json 引用 ──
      if (route === '/session-delete') {
        const ids = idsOf(body)
        if (!ids.length) {
          sendJson(res, 400, { ok: false, error: '没有选择会话' })
          return true
        }
        const results = ids.map((id) => deleteSessionById(id))
        sessionsCache = { at: 0, data: null, key: '' }
        const removed = results.filter((r) => r.ok).length
        sendJson(res, removed === results.length ? 200 : 207, {
          ok: removed === results.length,
          removed,
          results,
          state: buildState(ctx)
        })
        return true
      }

      if (route === '/unarchive') {
        const ids = idsOf(body)
        if (!ids.length) {
          sendJson(res, 400, { ok: false, error: '没有选择会话' })
          return true
        }
        const result = await doUnarchive(ctx, ids)
        sendJson(res, result.ok ? 200 : 207, { ...result, state: buildState(ctx, result.archivedSessionIds) })
        return true
      }

      // ── 条目增删改 / 归档 ──
      if (route === '/entry') {
        const collection = body.collection === 'knowledge' ? 'knowledge' : 'memory'
        const action = body.action || 'save'
        if (action === 'save') {
          const existing = body.id
            ? loadCollection(collection).items.find((it) => it.id === body.id)
            : null
          const saved = saveEntry(collection, normalizeEntry(body.entry || body, existing || {}))
          sendJson(res, 200, { ok: true, entry: saved, state: buildState(ctx) })
          return true
        }
        if (action === 'archive' || action === 'unarchive') {
          const changed = setArchivedFlag(collection, idsOf(body), action === 'archive')
          sendJson(res, 200, { ok: true, changed, state: buildState(ctx) })
          return true
        }
        if (action === 'remove') {
          const removed = removeEntries(collection, idsOf(body))
          sendJson(res, 200, { ok: true, removed, state: buildState(ctx) })
          return true
        }
        sendJson(res, 400, { ok: false, error: `未知操作：${action}` })
        return true
      }

      // ── 存储目录 / 自动写入配置 ──
      if (route === '/config') {
        const fromDir = dataDir()
        const autoCapture =
          typeof body.autoCapture === 'boolean' ? body.autoCapture : getConfig().autoCapture !== false
        // 只切「归档时自动写入知识库」开关时，不带 dir 也不带 reset。
        if (!body.reset && !body.dir && typeof body.autoCapture === 'boolean') {
          saveConfig({ autoCapture })
          sendJson(res, 200, {
            ok: true,
            mode: isCustomDir() ? 'custom' : 'default',
            storeDir: dataDir(),
            migrated: [],
            autoCapture: getConfig().autoCapture !== false,
            state: buildState(ctx)
          })
          return true
        }
        if (body.reset) {
          const prev = getConfig().storeDir
          let migrated = []
          if (prev) {
            try { fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true }) } catch {}
            if (body.migrate !== false) migrated = migrateDataFiles(prev, DEFAULT_DATA_DIR)
          }
          saveConfig({ storeDir: '', autoCapture })
          sendJson(res, 200, {
            ok: true,
            mode: 'default',
            storeDir: dataDir(),
            migrated,
            autoCapture: getConfig().autoCapture !== false,
            state: buildState(ctx)
          })
          return true
        }
        const v = validateDataDir(body.dir)
        if (!v.ok) {
          sendJson(res, 400, { ok: false, error: v.error, state: buildState(ctx) })
          return true
        }
        let migrated = []
        if (body.migrate !== false && path.resolve(v.dir) !== path.resolve(fromDir)) {
          migrated = migrateDataFiles(fromDir, v.dir)
        }
        saveConfig({ storeDir: v.dir, autoCapture })
        // 新目录里若还没有集合文件，立即补齐，保证面板马上读得到。
        loadCollection('memory')
        loadCollection('knowledge')
        sendJson(res, 200, {
          ok: true,
          mode: 'custom',
          storeDir: dataDir(),
          migrated,
          autoCapture: getConfig().autoCapture !== false,
          state: buildState(ctx)
        })
        return true
      }

      // ── 从会话来提取条目 ──
      if (route === '/promote') {
        const ids = idsOf(body)
        if (!ids.length) {
          sendJson(res, 400, { ok: false, error: '没有选择会话' })
          return true
        }
        const collection = body.collection === 'knowledge' ? 'knowledge' : 'memory'
        const created = promoteSessions(ctx, ids, collection)
        sendJson(res, 200, { ok: true, created: created.length, entries: created, state: buildState(ctx) })
        return true
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${route}` })
      return true
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message || String(e) })
      return true
    }
  }

  disposers.push(webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))

  const dispose = () => {
    for (const d of disposers) {
      try {
        d?.dispose?.()
      } catch {}
    }
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, 'dsh-memory-ui: api routes')

  try {
    ctx?.logger?.info?.(`[dsh-memory-ui] API 就绪 ${API_PREFIX}；归档服务 ${workspaceControllerOf(ctx) ? '可用' : '不可用（降级写文件）'}`)
  } catch {}
  return dispose
}

export { apply }