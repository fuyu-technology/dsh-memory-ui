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

// dsh-memory-ui —— 客户端：设置页里的「记忆与知识库」。
//
// 三个页签：
//   短期记忆 —— DSH 会话的活跃上下文（轮数 / token / 上下文压力 / 最近消息正文）
//   长期记忆 —— 跨会话沉淀的关键条目（~/.dsh/storages/dsh-memory-ui/memory.json）
//   知识库   —— 归档下来的可查条目（~/.dsh/storages/dsh-memory-ui/knowledge.json）
//
// 每个页签都支持多选 + 一键归档 / 一键取消归档；会话页签直接复用 DSH 原生归档机制。
// 面板顶部可查看并修改「存储目录」：点「选择文件夹…」唤起系统原生文件夹选择框，
// 也可手动填写绝对路径；支持迁移已有数据与恢复默认。

window.__ModuleLoader__.load({
  id: 'dsh-memory-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/dsh-memory'

    // apply() 时绑定的客户端根 ctx，用于取 uiWorkspace 服务（见 pickDirectoryNative）。
    let pluginCtx = null

    // 打开「系统原生文件夹选择框」，返回 { ok:true, dir, via } 或 { ok:false, error }。
    //   1) 桌面端（dsh-app://app）在 preload 通过 contextBridge 暴露的
    //      window.__DSH_DIRECTORY_PICKER__.pick()：主进程走
    //      dialog.showOpenDialog(window, { properties: ['openDirectory','createDirectory'] })
    //   2) 客户端服务 uiWorkspace.pickDirectory()
    //   3) 都没有（例如用普通浏览器打开面板）→ 'unsupported'，由调用方降级为手动填写
    // 用户在对话框里点取消时返回 { ok:true, dir:'' }，不算错误。
    async function pickDirectoryNative() {
      try {
        const bridge = typeof window !== 'undefined' ? window.__DSH_DIRECTORY_PICKER__ : undefined
        if (bridge && typeof bridge.pick === 'function') {
          const dir = await bridge.pick()
          return { ok: true, dir: typeof dir === 'string' ? dir : '', via: 'desktop' }
        }
        const uw = pluginCtx && (typeof pluginCtx.get === 'function' ? pluginCtx.get('uiWorkspace') : pluginCtx.uiWorkspace)
        if (uw && typeof uw.pickDirectory === 'function') {
          const dir = await uw.pickDirectory()
          return { ok: true, dir: typeof dir === 'string' ? dir : '', via: 'service' }
        }
        return { ok: false, error: 'unsupported' }
      } catch (e) {
        return { ok: false, error: e?.message || String(e) }
      }
    }

    // 当前环境是否具备系统原生选择能力（缺桥时按钮置灰并提示手填）。
    function hasNativePicker() {
      if (typeof window === 'undefined') return false
      const bridge = window.__DSH_DIRECTORY_PICKER__
      if (bridge && typeof bridge.pick === 'function') return true
      const uw = pluginCtx && (typeof pluginCtx.get === 'function' ? pluginCtx.get('uiWorkspace') : pluginCtx.uiWorkspace)
      return !!(uw && typeof uw.pickDirectory === 'function')
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '960px' },
      tabs: { display: 'flex', gap: '6px', borderBottom: '1px solid var(--dsw-alias-border-l2, #333)' },
      tab: (active) => ({
        fontSize: '13px',
        padding: '8px 14px',
        cursor: 'pointer',
        border: 'none',
        borderBottom: active ? '2px solid #4a6cf7' : '2px solid transparent',
        background: 'transparent',
        color: 'inherit',
        fontWeight: active ? 600 : 400,
        opacity: active ? 1 : 0.7
      }),
      card: {
        border: '1px solid var(--dsw-alias-border-l2, #333)',
        borderRadius: '10px',
        padding: '14px 16px',
        background: 'var(--dsw-alias-bg-l1, transparent)'
      },
      toolbar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l2, #333)',
        borderRadius: '10px'
      },
      btn: {
        fontSize: '12.5px',
        padding: '5px 12px',
        borderRadius: '7px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l3, #555)',
        background: 'var(--dsw-alias-button-floating-fill, transparent)',
        color: 'inherit'
      },
      btnPrimary: {
        fontSize: '12.5px',
        padding: '5px 12px',
        borderRadius: '7px',
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-button-primary-fill, #4a6cf7)',
        color: '#fff'
      },
      btnDanger: {
        fontSize: '12.5px',
        padding: '5px 12px',
        borderRadius: '7px',
        cursor: 'pointer',
        border: '1px solid rgba(255,90,90,.45)',
        background: 'rgba(255,90,90,.12)',
        color: '#ff6b6b'
      },
      input: {
        fontSize: '12.5px',
        padding: '5px 10px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2, #333)',
        background: 'var(--dsw-alias-bg-l1, transparent)',
        color: 'inherit',
        minWidth: '160px'
      },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08))'
      },
      list: { display: 'flex', flexDirection: 'column' },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { fontSize: '11.5px', opacity: 0.62, lineHeight: 1.55 },
      mono: { fontSize: '11px', opacity: 0.55, fontFamily: 'monospace', lineHeight: 1.5 },
      badge: { fontSize: '11px', padding: '2px 8px', borderRadius: '999px', fontWeight: 600, whiteSpace: 'nowrap' },
      badgeArchived: { background: 'rgba(255,190,90,.18)', color: '#e0a83c', border: '1px solid rgba(255,190,90,.35)' },
      badgeActive: { background: 'rgba(90,220,140,.15)', color: '#3ddc84', border: '1px solid rgba(90,220,140,.32)' },
      badgePin: { background: 'rgba(74,108,247,.18)', color: '#7f9bff', border: '1px solid rgba(74,108,247,.4)' },
      err: { fontSize: '12px', color: '#ff6b6b' },
      ok: { fontSize: '12px', color: '#3ddc84' },
      msgs: {
        maxHeight: '300px',
        overflowY: 'auto',
        marginTop: '8px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #333)',
        background: 'rgba(127,127,127,.06)'
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }
    }

    const fmtNum = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—')
    const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '—')

    function fmtTokens(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }

    function fmtSize(bytes) {
      if (typeof bytes !== 'number') return '—'
      if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
      if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`
      return `${bytes} B`
    }

    function Stat({ title, value, sub }) {
      return h('div', { style: { ...styles.card, padding: '10px 12px' } }, [
        h('div', { key: 't', style: styles.hint }, title),
        h('div', { key: 'v', style: { fontSize: '18px', fontWeight: 700, marginTop: '2px' } }, value),
        sub ? h('div', { key: 's', style: styles.hint }, sub) : null
      ].filter(Boolean))
    }

    function Badges({ item, kind }) {
      const nodes = []
      const archived = kind === 'session' ? item.archived : item.archived
      if (archived) nodes.push(h('span', { key: 'a', style: { ...styles.badge, ...styles.badgeArchived } }, '已归档'))
      else nodes.push(h('span', { key: 'n', style: { ...styles.badge, ...styles.badgeActive } }, '活跃'))
      if (item.pinned) nodes.push(h('span', { key: 'p', style: { ...styles.badge, ...styles.badgePin } }, '置顶'))
      if (kind === 'session' && !item.hasProjCache) {
        nodes.push(h('span', { key: 'c', style: { ...styles.badge, ...styles.badgeArchived } }, '无缓存'))
      }
      return h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, nodes)
    }

    // ── 会话（短期记忆）页签 ─────────────────────────────────────────────
    function SessionTab({ state, selected, setSelected, refresh, collection, promote, runArchive, remove, busy }) {
      const [query, setQuery] = useState('')
      const [expanded, setExpanded] = useState(null)
      const [messages, setMessages] = useState({})
      const [msgError, setMsgError] = useState(null)
      const [includeArchived, setIncludeArchived] = useState(true)

      const sessions = state.sessions || []
      const visible = useMemo(() => {
        const q = query.trim().toLowerCase()
        return sessions.filter((s) => {
          if (!includeArchived && s.archived) return false
          if (!q) return true
          return (
            String(s.title || '').toLowerCase().includes(q) ||
            String(s.preview || '').toLowerCase().includes(q) ||
            String(s.workspaceTitle || '').toLowerCase().includes(q) ||
            String(s.sessionId || '').toLowerCase().includes(q) ||
            String(s.cwd || '').toLowerCase().includes(q)
          )
        })
      }, [sessions, query, includeArchived])

      const allChecked = visible.length > 0 && visible.every((s) => selected.has(s.sessionId))

      const toggle = (id) => {
        const next = new Set(selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSelected(next)
      }

      const toggleAll = () => {
        const next = new Set(selected)
        if (allChecked) visible.forEach((s) => next.delete(s.sessionId))
        else visible.forEach((s) => next.add(s.sessionId))
        setSelected(next)
      }

      const invert = () => {
        const next = new Set(selected)
        visible.forEach((s) => {
          if (next.has(s.sessionId)) next.delete(s.sessionId)
          else next.add(s.sessionId)
        })
        setSelected(next)
      }

      const openSession = useCallback(async (id) => {
        setExpanded((prev) => (prev === id ? null : id))
        if (messages[id]) return
        setMsgError(null)
        try {
          const res = await fetch(`${API}/session?id=${encodeURIComponent(id)}&limit=30`, { credentials: 'same-origin' })
          const body = await res.json()
          if (body.ok) setMessages((prev) => ({ ...prev, [id]: body.messages }))
          else setMsgError(body.error || '读取失败')
        } catch (e) {
          setMsgError(e?.message || String(e))
        }
      }, [messages])

      const ids = Array.from(selected)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 'grid', style: styles.grid }, [
          h(Stat, { key: 'a', title: '会话总数', value: fmtNum(state.stats?.sessionCount), sub: `已归档 ${state.stats?.archivedCount ?? 0}` }),
          h(Stat, { key: 'b', title: '当前选中', value: fmtNum(ids.length), sub: '可批量归档 / 取消' }),
          h(Stat, { key: 'c', title: '长期记忆', value: fmtNum(state.stats?.memoryCount), sub: `已归档 ${state.stats?.memoryArchived ?? 0}` }),
          h(Stat, { key: 'd', title: '知识库', value: fmtNum(state.stats?.knowledgeCount), sub: `已归档 ${state.stats?.knowledgeArchived ?? 0}` })
        ]),

        state.archive && !state.archive.serviceAvailable
          ? h('div', { key: 'warn', style: styles.err }, `⚠️ ${state.archive.reason}`)
          : null,

        h('div', { key: 'bar', style: styles.toolbar }, [
          h('button', { key: 'all', style: styles.btn, disabled: busy, onClick: toggleAll },
            allChecked ? '取消全选' : `全选（${visible.length}）`),
          h('button', { key: 'inv', style: styles.btn, disabled: busy, onClick: invert }, '反选'),
          h('button', { key: 'clr', style: styles.btn, disabled: busy || !ids.length, onClick: () => setSelected(new Set()) }, '清空选择'),
          h('input', {
            key: 'q', style: styles.input, placeholder: '按标题 / 路径 / 工作区过滤', value: query,
            onChange: (e) => setQuery(e.target.value)
          }),
          h('label', { key: 'arch', style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' } }, [
            h('input', {
              key: 'c', type: 'checkbox', checked: includeArchived,
              onChange: (e) => setIncludeArchived(e.target.checked)
            }),
            '显示已归档'
          ]),
          h('button', {
            key: 'arch', style: styles.btnPrimary, disabled: busy || !ids.length,
            onClick: () => runArchive({ action: 'archive', ids })
          }, `一键归档${ids.length ? `（${ids.length}）` : ''}`),
          h('button', {
            key: 'unarch', style: styles.btn, disabled: busy || !ids.length,
            onClick: () => runArchive({ action: 'unarchive', ids })
          }, '一键取消归档'),
          h('button', {
            key: 'del', style: styles.btnDanger, disabled: busy || !ids.length,
            onClick: () => remove(ids)
          }, `删除${ids.length ? `（${ids.length}）` : ''}`),
          h('button', {
            key: 'promote', style: styles.btn, disabled: busy || !ids.length,
            onClick: () => promote(ids, collection)
          }, `提取到${collection === 'knowledge' ? '知识库' : '长期记忆'}`),
          h('button', { key: 're', style: styles.btn, disabled: busy, onClick: refresh }, '刷新')
        ]),

        h('div', { key: 'list', style: { ...styles.card, padding: 0, overflow: 'hidden' } },
          visible.length
            ? visible.map((s) => h('div', { key: s.sessionId, style: styles.row }, [
              h('input', {
                key: 'c', type: 'checkbox', checked: selected.has(s.sessionId),
                style: { marginTop: '3px', width: '15px', height: '15px', cursor: 'pointer' },
                onChange: () => toggle(s.sessionId)
              }),
              h('div', { key: 'b', style: { flex: 1, minWidth: 0 } }, [
                h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
                  h('span', { key: 't', style: styles.label }, s.title),
                  h(Badges, { key: 'b', item: s, kind: 'session' }),
                  h('span', { key: 'w', style: { ...styles.badge, background: 'rgba(127,127,127,.14)', border: '1px solid rgba(127,127,127,.3)', color: 'inherit', opacity: .8 } },
                    s.workspaceTitle || '不在工作区')
                ]),
                h('div', { key: 'l2', style: styles.hint }, [
                  `轮数 ${fmtNum(s.turns)} · ${fmtTime(s.mtime)}`,
                  s.surfaceTokens ? ` · 上下文 ${fmtTokens(s.surfaceTokens)}${s.contextWindow ? `/${fmtTokens(s.contextWindow)}` : ''}` : '',
                  s.tokens ? ` · 累计输入 ${fmtTokens(s.tokens.uncachedInputTokens)} / 缓存读 ${fmtTokens(s.tokens.cacheReadTokens)}` : '',
                  s.archived ? ' · 已从工作区分组中隐藏' : ''
                ].join('')),
                s.preview ? h('div', { key: 'l3', style: { ...styles.hint, marginTop: '3px' } }, s.preview) : null,
                h('div', { key: 'l4', style: { ...styles.mono, marginTop: '3px' } }, `${s.sessionId}${s.cwd ? `  ${s.cwd}` : ''}  ${fmtSize(s.sizeBytes)}`),
                expanded === s.sessionId
                  ? h('div', { key: 'msg', style: styles.msgs },
                    (messages[s.sessionId] || []).length
                      ? (messages[s.sessionId] || []).map((m, i) => h('div', { key: i, style: { marginBottom: '8px' } }, [
                        h('div', { key: 'h', style: { ...styles.hint, fontWeight: 600, opacity: .8 } },
                          `${m.role === 'user' ? '用户' : '助手'}${m.model ? ` · ${m.model}` : ''}${m.time ? ` · ${new Date(m.time).toLocaleTimeString('zh-CN')}` : ''}`),
                        h('div', { key: 't', style: { fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                          m.text.length > 1200 ? `${m.text.slice(0, 1200)}…` : m.text)
                      ]))
                      : h('div', { style: styles.hint }, '没有可展示的消息（或正在读取…）'))
                  : null
              ]),
              h('button', {
                key: 'o', style: styles.btn, disabled: busy, onClick: () => openSession(s.sessionId)
              }, expanded === s.sessionId ? '收起' : '查看最近消息'),
              h('button', {
                key: 'd', style: styles.btnDanger, disabled: busy, onClick: () => remove([s.sessionId])
              }, '删除')
            ]))
            : h('div', { style: { ...styles.hint, padding: '16px' } }, '没有匹配的会话')
        ),

        msgError ? h('div', { key: 'e', style: styles.err }, msgError) : null
      ].filter((n) => n !== null))
    }

    // ── 条目（长期记忆 / 知识库）页签 ────────────────────────────────────
    function EntryTab({ kind, title, state, refresh, toggleArchive, remove, busy }) {
      const itemsKey = kind
      const items = state[itemsKey] || []
      const [selected, setSelected] = useState(new Set())
      const [query, setQuery] = useState('')
      const [showArchived, setShowArchived] = useState(true)
      const [draft, setDraft] = useState(null)
      // 关键词检索：走宿主本地倒排索引，只取 top-k 精简片段（省 token 的关键）
      const [probe, setProbe] = useState('')
      const [hits, setHits] = useState(null)
      const [probing, setProbing] = useState(false)
      const [probeError, setProbeError] = useState(null)
      // 「补齐历史会话」：把还没写入过本集合的会话一次性写进来
      const [capturing, setCapturing] = useState(false)
      const [captureNote, setCaptureNote] = useState(null)

      useEffect(() => {
        const alive = new Set(items.map((it) => it.id))
        setSelected((prev) => {
          let changed = false
          const next = new Set()
          for (const id of prev) {
            if (alive.has(id)) next.add(id)
            else changed = true
          }
          return changed ? next : prev
        })
      }, [items])

      const visible = useMemo(() => {
        const q = query.trim().toLowerCase()
        return items.filter((it) => {
          if (!showArchived && it.archived) return false
          if (!q) return true
          return (
            String(it.title || '').toLowerCase().includes(q) ||
            String(it.content || '').toLowerCase().includes(q) ||
            (it.tags || []).join(' ').toLowerCase().includes(q)
          )
        })
      }, [items, query, showArchived])

      // 关键词检索：输入即查本地倒排索引，只取 top-5 精简片段（省 token 的关键一步）。
      // 纯字符串匹配 + 前缀包含，全程零模型调用；260ms 防抖避免逐字打请求。
      useEffect(() => {
        const q = probe.trim()
        if (q.length < 2) {
          setHits(null)
          setProbeError(null)
          setProbing(false)
          return undefined
        }
        let alive = true
        const timer = setTimeout(async () => {
          setProbing(true)
          setProbeError(null)
          try {
            const res = await fetch(
              `${API}/search?collection=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}&k=5&snippetMax=240`,
              { credentials: 'same-origin' }
            )
            const body = await res.json()
            if (!alive) return
            if (body.ok) setHits(body)
            else setProbeError(body.error || '检索失败')
          } catch (e) {
            if (alive) setProbeError(e?.message || String(e))
          } finally {
            if (alive) setProbing(false)
          }
        }, 260)
        return () => { alive = false; clearTimeout(timer) }
      }, [probe, kind])

      // 「补齐历史会话」：把还没写入过本集合的历史会话一次性写进来（宿主按 sourceSessionId 去重）。
      const captureMissing = useCallback(async () => {
        setCapturing(true)
        setCaptureNote(null)
        try {
          const res = await fetch(`${API}/capture`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ collection: kind, all: true })
          })
          const body = await res.json()
          if (body.ok) {
            setCaptureNote(`新增 ${body.created} 条 · 更新 ${body.updated} 条 · 已有跳过 ${body.skipped + body.unchanged} 条${body.failed ? ` · 失败 ${body.failed}` : ''}`)
            await refresh()
          } else {
            setCaptureNote(body.error || '写入失败')
          }
        } catch (e) {
          setCaptureNote(e?.message || String(e))
        } finally {
          setCapturing(false)
        }
      }, [kind, refresh])

      const allChecked = visible.length > 0 && visible.every((it) => selected.has(it.id))
      const ids = Array.from(selected)

      const toggle = (id) => {
        const next = new Set(selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSelected(next)
      }

      const save = useCallback(async (entry) => {
        const res = await fetch(`${API}/entry`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collection: kind, action: 'save', entry })
        })
        const body = await res.json()
        if (body.ok) {
          setDraft(null)
          await refresh()
        }
        return body
      }, [kind, refresh])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
        h('div', { key: 'head', style: { ...styles.card, padding: '12px 14px' } }, [
          h('div', { key: 't', style: { fontSize: '14px', fontWeight: 600 } }, title),
          h('div', { key: 'd', style: styles.hint },
            kind === 'memory'
              ? '跨会话沉淀下来的关键事实、决策与偏好。留在磁盘上，只有需要时才会被召回，不进日常对话上下文。'
              : '归档后可随时检索的知识条目。放在知识库里的内容不参与日常对话，按需取用。'),
          h('div', { key: 'p', style: { ...styles.mono, marginTop: '4px' } }, state.storeDir || '')
        ].filter(Boolean)),

        h('div', { key: 'bar', style: styles.toolbar }, [
          h('button', {
            key: 'all', style: styles.btn, disabled: busy,
            onClick: () => {
              const next = new Set(selected)
              if (allChecked) visible.forEach((it) => next.delete(it.id))
              else visible.forEach((it) => next.add(it.id))
              setSelected(next)
            }
          }, allChecked ? '取消全选' : `全选（${visible.length}）`),
          h('button', { key: 'inv', style: styles.btn, disabled: busy, onClick: () => {
            const next = new Set(selected)
            visible.forEach((it) => {
              if (next.has(it.id)) next.delete(it.id)
              else next.add(it.id)
            })
            setSelected(next)
          } }, '反选'),
          h('button', { key: 'clr', style: styles.btn, disabled: busy || !ids.length, onClick: () => setSelected(new Set()) }, '清空选择'),
          h('input', {
            key: 'q', style: styles.input, placeholder: '按标题 / 内容 / 标签过滤', value: query,
            onChange: (e) => setQuery(e.target.value)
          }),
          h('label', { key: 'sa', style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' } }, [
            h('input', { key: 'c', type: 'checkbox', checked: showArchived, onChange: (e) => setShowArchived(e.target.checked) }),
            '显示已归档'
          ]),
          h('button', {
            key: 'a', style: styles.btnPrimary, disabled: busy || !ids.length,
            onClick: () => toggleArchive(kind, ids, true)
          }, `一键归档${ids.length ? `（${ids.length}）` : ''}`),
          h('button', {
            key: 'u', style: styles.btn, disabled: busy || !ids.length,
            onClick: () => toggleArchive(kind, ids, false)
          }, '一键取消归档'),
          h('button', {
            key: 'rm', style: styles.btnDanger, disabled: busy || !ids.length,
            onClick: () => remove(kind, ids)
          }, `删除${ids.length ? `（${ids.length}）` : ''}`),
          h('button', {
            key: 'new', style: styles.btn, disabled: busy,
            onClick: () => setDraft({ title: '', content: '', tags: '' })
          }, '新建条目'),
          h('button', { key: 're', style: styles.btn, disabled: busy, onClick: refresh }, '刷新')
        ]),

        h('div', { key: 'probe', style: styles.card }, [
          h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
            h('div', { key: 'l', style: styles.label }, '关键词检索（按需召回）'),
            h('input', {
              key: 'i', style: { ...styles.input, flex: '1 1 260px', minWidth: '220px' },
              placeholder: '输入关键词，从本地倒排索引取 top-5 精简片段',
              value: probe, spellCheck: false,
              onChange: (e) => setProbe(e.target.value)
            }),
            h('button', {
              key: 'cap', style: styles.btn, disabled: busy || capturing,
              onClick: captureMissing
            }, capturing ? '写入中…' : '补齐历史会话'),
            probing ? h('span', { key: 'p', style: styles.hint }, '检索中…') : null
          ].filter(Boolean)),
          h('div', { key: 'd', style: styles.hint },
            '检索只读本地倒排索引，命中内容按需取用、不进日常对话上下文；不产生模型调用。'),
          captureNote ? h('div', { key: 'n', style: { ...styles.hint, marginTop: '4px' } }, captureNote) : null,
          probeError ? h('div', { key: 'e', style: styles.err }, probeError) : null,
          hits
            ? (hits.results || []).length
              ? h('div', { key: 'r', style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } }, [
                h('div', { key: 'meta', style: styles.hint },
                  `命中 ${hits.results.length} 条 · 索引词 ${hits.indexSize} 个${(hits.terms || []).length ? ` · 查询词 ${hits.terms.join(' ')}` : ''}`),
                ...hits.results.map((r) => h('div', {
                  key: r.id,
                  style: { padding: '8px 10px', border: '1px solid rgba(127,127,127,.25)', borderRadius: '6px' }
                }, [
                  h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
                    h('span', { key: 't', style: styles.label }, r.title),
                    h('span', { key: 's', style: styles.badge }, `相关度 ${r.score}`),
                    r.auto ? h('span', { key: 'a', style: { ...styles.badge, ...styles.badgePin } }, '自动写入') : null,
                    ...(r.keywords || []).slice(0, 6).map((kw, i) => h('span', {
                      key: `k${i}`,
                      style: { ...styles.badge, background: 'rgba(127,127,127,.14)', border: '1px solid rgba(127,127,127,.3)', color: 'inherit', opacity: .8 }
                    }, `#${kw}`))
                  ].filter(Boolean)),
                  h('div', { key: 'sn', style: { fontSize: '12.5px', whiteSpace: 'pre-wrap', marginTop: '4px', opacity: .88 } }, r.snippet),
                  h('div', { key: 'mt', style: { ...styles.mono, marginTop: '4px' } },
                    `${r.sourceSessionId ? `来源 ${r.sourceSessionId} · ` : ''}更新于 ${fmtTime(Date.parse(r.updatedAt))}`)
                ]))
              ])
              : h('div', { key: 'e', style: { ...styles.hint, marginTop: '8px' } },
                `没有命中「${probe}」相关条目。可点「补齐历史会话」先把历史会话写入本集合。`)
            : null
        ].filter(Boolean)),

        draft !== null
          ? h('div', { key: 'draft', style: styles.card }, [
            h('div', { key: 't', style: { ...styles.label, marginBottom: '8px' } }, '新建条目'),
            h('input', {
              key: 'ti', style: { ...styles.input, width: '100%', marginBottom: '8px' },
              placeholder: '标题', value: draft.title,
              onChange: (e) => setDraft({ ...draft, title: e.target.value })
            }),
            h('textarea', {
              key: 'ct',
              style: { ...styles.input, width: '100%', minHeight: '90px', marginBottom: '8px', fontFamily: 'inherit', resize: 'vertical' },
              placeholder: '内容', value: draft.content,
              onChange: (e) => setDraft({ ...draft, content: e.target.value })
            }),
            h('input', {
              key: 'tg', style: { ...styles.input, width: '100%', marginBottom: '8px' },
              placeholder: '标签（逗号分隔）', value: draft.tags,
              onChange: (e) => setDraft({ ...draft, tags: e.target.value })
            }),
            h('div', { key: 'b', style: { display: 'flex', gap: '8px' } }, [
              h('button', {
                key: 's', style: styles.btnPrimary, disabled: busy || !draft.title.trim(),
                onClick: () => save({
                  title: draft.title.trim(),
                  content: draft.content,
                  tags: draft.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
                })
              }, '保存'),
              h('button', { key: 'c', style: styles.btn, onClick: () => setDraft(null) }, '取消')
            ])
          ].filter(Boolean))
          : null,

        h('div', { key: 'list', style: { ...styles.card, padding: 0, overflow: 'hidden' } },
          visible.length
            ? visible.map((it) => h('div', { key: it.id, style: styles.row }, [
              h('input', {
                key: 'c', type: 'checkbox', checked: selected.has(it.id),
                style: { marginTop: '3px', width: '15px', height: '15px', cursor: 'pointer' },
                onChange: () => toggle(it.id)
              }),
              h('div', { key: 'b', style: { flex: 1, minWidth: 0 } }, [
                h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
                  h('span', { key: 't', style: styles.label }, it.title),
                  h(Badges, { key: 'b', item: it, kind: 'entry' }),
                  it.auto
                    ? h('span', { key: 'auto', style: { ...styles.badge, ...styles.badgePin } }, '自动写入')
                    : null,
                  ...(it.keywords || []).slice(0, 8).map((kw, i) =>
                    h('span', { key: `kw${i}`, style: { ...styles.badge, background: 'rgba(127,127,127,.14)', border: '1px solid rgba(127,127,127,.3)', color: 'inherit', opacity: .8 } }, `#${kw}`)),
                  ...(it.tags || []).map((tag, i) =>
                    h('span', { key: `tag${i}`, style: { ...styles.badge, background: 'rgba(127,127,127,.14)', border: '1px solid rgba(127,127,127,.3)', color: 'inherit', opacity: .8 } }, tag))
                ].filter(Boolean)),
                it.content
                  ? h('div', { key: 'ct', style: { fontSize: '12.5px', whiteSpace: 'pre-wrap', marginTop: '4px', opacity: .88 } },
                    it.content.length > 400 ? `${it.content.slice(0, 400)}…` : it.content)
                  : null,
                h('div', { key: 'mt', style: { ...styles.mono, marginTop: '4px' } },
                  `更新于 ${fmtTime(Date.parse(it.updatedAt))}${it.sourceSessionId ? ` · 来源 ${it.sourceSessionId}` : ''}`),
                h('div', { key: 'edit', style: { marginTop: '6px', display: 'flex', gap: '6px' } }, [
                  h('button', {
                    key: 'e', style: styles.btn, disabled: busy,
                    onClick: () => setDraft({ id: it.id, title: it.title, content: it.content, tags: (it.tags || []).join(', ') })
                  }, '编辑'),
                  h('button', {
                    key: 'a', style: styles.btn, disabled: busy,
                    onClick: () => toggleArchive(kind, [it.id], !it.archived)
                  }, it.archived ? '取消归档' : '归档'),
                  h('button', {
                    key: 'd', style: styles.btnDanger, disabled: busy,
                    onClick: () => remove(kind, [it.id])
                  }, '删除')
                ])
              ])
            ]))
            : h('div', { style: { ...styles.hint, padding: '16px' } }, '还没有条目。开启上方「归档时自动写入」后，归档会话会自动写入；也可以点「补齐历史会话」把已有历史会话写入，或点「新建条目」。')
        )
      ].filter((n) => n !== null))
    }

    // ── 面板主体 ─────────────────────────────────────────────────────────
    function MemoryPanel() {
      const [tab, setTab] = useState('session')
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [message, setMessage] = useState(null)
      const [sessionSelection, setSessionSelection] = useState(new Set())
      const [promoteTarget, setPromoteTarget] = useState('memory')
      const [dirDraft, setDirDraft] = useState('')
      const [migrateData, setMigrateData] = useState(true)
      // 无系统文件夹选择框（非桌面 / 未暴露桥）时直接降级为手动填写。
      const [manualMode, setManualMode] = useState(() => !hasNativePicker())
      const appliedDir = useRef('')
      const mounted = useRef(true)

      useEffect(() => () => { mounted.current = false }, [])

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/state`, { credentials: 'same-origin' })
          const body = await res.json()
          if (!mounted.current) return
          if (body.ok) {
            setState(body)
            setError(null)
          } else setError(body.error || '读取失败')
        } catch (e) {
          if (mounted.current) setError(e?.message || String(e))
        }
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(load, 20000)
        return () => clearInterval(timer)
      }, [load])

      // 存储目录草稿：跟随服务端值，但不覆盖用户正在输入的内容。
      useEffect(() => {
        const dir = state?.storeDir || ''
        if (!dir) return
        setDirDraft((cur) => ((cur && cur !== appliedDir.current) ? cur : dir))
        appliedDir.current = dir
      }, [state?.storeDir])

      const post = useCallback(async (routePath, body) => {
        setBusy(true)
        setError(null)
        try {
          const res = await fetch(`${API}${routePath}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          const out = await res.json()
          if (out.state) setState(out.state)
          if (!out.ok) {
            const failed = (out.results || []).filter((r) => !r.ok)
            setError(failed.length
              ? failed.map((r) => `${r.sessionId}: ${r.error || '失败'}${r.code ? `（${r.code}）` : ''}`).join('；')
              : (out.error || '操作失败'))
          } else {
            setMessage(out.notice || '已生效')
            setTimeout(() => setMessage(null), 2500)
          }
          await load()
          return out
        } catch (e) {
          setError(e?.message || String(e))
          return { ok: false }
        } finally {
          setBusy(false)
        }
      }, [load])

      const runArchive = useCallback(({ action, ids }) => {
        const verb = action === 'archive' ? '归档' : '取消归档'
        if (!window.confirm(`确认对选中的 ${ids.length} 个会话执行「${verb}」？`)) return
        return post(`/${action}`, { sessionIds: ids, stopActivity: true })
      }, [post])

      const toggleArchiveEntry = useCallback((collection, ids, archived) => {
        return post('/entry', { collection, action: archived ? 'archive' : 'unarchive', ids })
      }, [post])

      const removeEntries = useCallback((collection, ids) => {
        const what = ids.length === 1 ? '该条目' : `选中的 ${ids.length} 条`
        if (!window.confirm(`确认删除${what}？此操作不可撤销。`)) return
        return post('/entry', { collection, action: 'remove', ids })
      }, [post])

      const promote = useCallback((ids, collection) => {
        return post('/promote', { sessionIds: ids, collection })
      }, [post])

      // 彻底删除短期会话：删磁盘文件，不可撤销；删除前二次确认。
      const removeSessions = useCallback((ids) => {
        const what = ids.length === 1 ? '该会话' : `选中的 ${ids.length} 个会话`
        if (!window.confirm(`确认彻底删除${what}？将从磁盘移除会话记录，此操作不可撤销。`)) return undefined
        return post('/session-delete', { ids })
      }, [post])

      const saveStoreDir = useCallback(() => {
        const dir = (dirDraft || '').trim()
        if (!dir) { setError('请填写存储目录的绝对路径'); return undefined }
        return post('/config', { dir, migrate: migrateData })
      }, [post, dirDraft, migrateData])

      const chooseDir = useCallback(async () => {
        const res = await pickDirectoryNative()
        if (!res.ok) {
          if (res.error === 'unsupported') {
            setManualMode(true)
            setError('当前环境没有系统文件夹选择框，已切换为手动输入绝对路径。')
          } else {
            setError(`打开文件夹选择框失败：${res.error}`)
          }
          return undefined
        }
        const dir = (res.dir || '').trim()
        if (!dir) return undefined // 用户在对话框里点了取消
        setDirDraft(dir)
        return post('/config', { dir, migrate: migrateData })
      }, [post, migrateData])

      const resetStoreDir = useCallback(() => {
        if (!window.confirm('恢复为默认存储目录？已有的 memory.json / knowledge.json 会按当前选择处理。')) return undefined
        return post('/config', { reset: true, migrate: migrateData })
      }, [post, migrateData])

      // 「归档时自动写入知识库」开关：只切这一个布尔位，不动存储目录。
      const autoCaptureOn = state?.autoCapture !== false
      const toggleAutoCapture = useCallback(
        () => post('/config', { autoCapture: !(state?.autoCapture !== false) }),
        [post, state?.autoCapture]
      )

      if (!state && !error) {
        return h('div', { style: styles.wrap }, h('div', { style: styles.hint }, '正在读取记忆与知识库…'))
      }
      if (!state) {
        return h('div', { style: styles.wrap }, h('div', { style: styles.err }, `加载失败：${error}`))
      }

      const tabs = [
        ['session', '短期记忆（会话）'],
        ['memory', '长期记忆'],
        ['knowledge', '知识库']
      ]

      return h('div', { style: styles.wrap }, [
        h('div', { key: 'tabs', style: styles.tabs }, tabs.map(([id, label]) =>
          h('button', { key: id, style: styles.tab(tab === id), onClick: () => setTab(id) }, label))),

        h('div', { key: 'dir', style: styles.card }, [
          h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
            h('div', { key: 'l', style: styles.label }, '存储目录'),
            h('span', {
              key: 'b',
              style: { ...styles.badge, ...(state.customDir ? styles.badgePin : styles.badgeActive) }
            }, state.customDir ? '自定义' : '默认'),
            manualMode || !hasNativePicker()
              ? h('input', {
                key: 'i',
                style: { ...styles.input, flex: '1 1 300px', minWidth: '280px' },
                value: dirDraft,
                spellCheck: false,
                placeholder: state.defaultStoreDir,
                onChange: (e) => setDirDraft(e.target.value)
              })
              : h('code', {
                key: 'p',
                style: { ...styles.mono, fontSize: '12px', flex: '1 1 300px', wordBreak: 'break-all' },
                title: dirDraft || state.storeDir
              }, dirDraft || state.storeDir || state.defaultStoreDir),
            hasNativePicker()
              ? h('button', {
                key: 'pick',
                style: styles.btnPrimary,
                disabled: busy,
                onClick: chooseDir,
                title: '打开系统文件夹选择框'
              }, '选择文件夹…')
              : null,
            hasNativePicker()
              ? h('button', {
                key: 'tm',
                style: styles.btn,
                disabled: busy,
                onClick: () => setManualMode((v) => !v)
              }, manualMode ? '用选择框' : '手动输入')
              : null,
            manualMode || !hasNativePicker()
              ? h('button', { key: 's', style: styles.btnPrimary, disabled: busy, onClick: saveStoreDir }, '保存')
              : null,
            h('label', { key: 'm', style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '5px' } }, [
              h('input', {
                key: 'c', type: 'checkbox', checked: migrateData,
                onChange: (e) => setMigrateData(e.target.checked)
              }),
              '迁移已有数据'
            ]),
            h('button', {
              key: 'r', style: styles.btn, disabled: busy || !state.customDir, onClick: resetStoreDir
            }, '恢复默认')
          ]),
          h('div', { key: 'h', style: { ...styles.hint, marginTop: '6px' } },
            hasNativePicker()
              ? `长期记忆与知识库的 memory.json / knowledge.json 存放于此；点「选择文件夹…」在系统文件夹选择框里指定目录，选中即保存。默认目录 ${state.defaultStoreDir}。保存后立即生效并持久化，重启后依然有效。`
              : `当前环境没有系统文件夹选择框，请手动填写绝对路径。长期记忆与知识库的 memory.json / knowledge.json 存放于此，默认目录 ${state.defaultStoreDir}。`)
        ]),

        // 自动化：归档时是否自动把会话压成知识库条目（纯本地关键词抽取，零模型调用）
        h('div', { key: 'auto', style: styles.card }, [
          h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
            h('label', { key: 'l', style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } }, [
              h('input', {
                key: 'c', type: 'checkbox', checked: autoCaptureOn,
                disabled: busy, onChange: toggleAutoCapture
              }),
              '归档时自动写入知识库'
            ]),
            h('span', {
              key: 'b', style: { ...styles.badge, ...(autoCaptureOn ? styles.badgeActive : styles.badgeArchived) }
            }, autoCaptureOn ? '已开启' : '已关闭'),
            h('span', { key: 's', style: styles.hint }, `知识库已自动写入 ${state.stats?.knowledgeAuto || 0} 条 · 长期记忆 ${state.stats?.memoryAuto || 0} 条`)
          ]),
          h('div', { key: 'h', style: { ...styles.hint, marginTop: '6px' } },
            '开启后，归档会话会自动抽取关键词并写入知识库（不调用模型，只在本机做字符串处理）。写入的条目只在被检索命中的那一刻才进入上下文，因此不会推高日常对话的 token。')
        ]),

        tab === 'session'
          ? h('div', { key: 'sel', style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '8px' } }, [
            '提取到：',
            h('select', {
              key: 'p', style: styles.input, value: promoteTarget,
              onChange: (e) => setPromoteTarget(e.target.value)
            }, [
              h('option', { key: 'm', value: 'memory' }, '长期记忆'),
              h('option', { key: 'k', value: 'knowledge' }, '知识库')
            ])
          ].filter(Boolean))
          : null,

        tab === 'session'
          ? h(SessionTab, {
            key: 's', state, selected: sessionSelection, setSelected: setSessionSelection,
            refresh: load, collection: promoteTarget, promote, runArchive, remove: removeSessions, busy
          })
          : h(EntryTab, {
            key: tab, kind: tab, title: tab === 'memory' ? '长期记忆' : '知识库',
            state, refresh: load, toggleArchive: toggleArchiveEntry, remove: removeEntries, busy
          }),

        message ? h('div', { key: 'm', style: styles.ok }, message) : null,
        error ? h('div', { key: 'e', style: styles.err }, error) : null,
        h('div', { key: 'foot', style: styles.hint },
          `存储目录 ${state.storeDir} · 归档走 DSH 原生机制（${state.archive?.mode === 'service' ? '可用' : '降级写文件'}）· 上次读取 ${fmtTime(Date.parse(state.generatedAt))}`)
      ].filter((n) => n !== null))
    }

    // DSH 客户端插件契约：factory 必须返回带 apply 的对象；
    // inject: ['slots'] 少了它会在 boot 早期访问 ctx.slots 直接抛错。
    function apply(ctx) {
      // 记下客户端根 ctx：pickDirectoryNative 需要经它取 uiWorkspace 服务。
      pluginCtx = ctx
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'memory-ui',
        order: 26,
        label: '记忆与知识库'
      }, MemoryPanel))
    }

    return { inject: ['slots'], apply, name: 'dsh-memory-ui' }
  }
})