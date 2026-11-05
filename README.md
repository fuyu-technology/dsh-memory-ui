# dsh-memory-ui

DeepSeek Harness 插件：在**设置页**里加一页「记忆与知识库」。

## 它能做什么

三个页签，每页都支持**多选**，以及**一键归档 / 一键取消归档**；长期记忆 / 知识库的**每条条目行内**还带「编辑 / 归档 / 删除」按钮，单条即可操作（删除前二次确认，直接复用宿主 `/entry` 的 `action: "remove"`）。

| 页签 | 内容 | 数据来源 |
| --- | --- | --- |
| 短期记忆（会话） | 会话列表：标题、工作区、轮数、上下文占用、累计 token、最近活动时间；展开可看**最近 30 条消息正文** | `~/.dsh/storages/workspace.json`、`~/.dsh/storages/session_projcache/sessions/*.json`、`~/.dsh/sessions/*/session.v4.jsonl.zstd` |
| 长期记忆 | 跨会话沉淀的关键条目（标题 / 内容 / 标签 / 来源会话 / 关键词），可新建、编辑、删除、归档，并可**关键词检索** | `<存储目录>/memory.json`，默认 `~/.dsh/storages/dsh-memory-ui/memory.json` |
| 知识库 | 归档后可随时检索的知识条目，可新建、编辑、删除、归档，并可**关键词检索** | `<存储目录>/knowledge.json`，默认 `~/.dsh/storages/dsh-memory-ui/knowledge.json` |

## 归档时自动写入知识库（不花钱）

「自动化」卡片里有一个开关「**归档时自动写入知识库**」（默认开启，写进 `config.json` 的
`autoCapture`，显式设成 `false` 才关闭）。

- 开启后，**每次归档会话都会自动**把该会话抽成一条知识库条目，不需要再手动点「提取」。
- 抽取过程**完全在本机做字符串处理**：分词 → 词频/停用词过滤 → 取 top-12 关键词；
  条目标题沿用会话标题，正文是"工作区 / 会话 / 轮数 + 首条用户消息 + 最近一条回复"的精简摘要
  （上限约 700 字），并记下来源会话 `sourceSessionId` 与 `signature`。
- **全程零模型调用，零 token 消耗**。同一会话重复归档会按 `sourceSessionId` 去重，
  只更新、不新增；若该会话已有**人工**条目，则跳过不覆盖用户内容。
- 想一次性把历史会话补齐：知识库页签里点「**补齐历史会话**」
  （等价于 `POST /capture { collection, all: true }`）。

## 关键词检索：只在被用到的那一刻才进上下文

两个页签顶部都有「**关键词检索（按需召回）**」卡片：输入关键词 → 命中列表显示标题、
相关度、`自动写入` 徽标、`#关键词` chip、精简片段、来源会话与更新时间。

- 检索走本机**倒排索引** `<存储目录>/index.json`：词 → 条目 id 的 postings 表；
  打分 = 关键词命中数 + 标题/正文字面包含兜底（标题 +3、正文 +1），取 **top-k（默认 3，上限 10）**。
- 索引按集合文件的指纹（`size:mtime:count`）判断是否失效，失效就自动重建，无需手工维护；
  查询词没命中的条目**不会被读出来**。
- 片段长度默认 200 字（可调 40–1000）；`/search` 响应刻意**不含 `state` 大对象**，
  真实数据下响应体约 1.3 KB（对比 `/state` 约 66 KB）。
- 检索同样是**纯字符串比较，不调用模型**。

**为什么这样最省 token**：长期记忆 / 知识库里存了多少条，都不影响日常对话——
只有被检索命中的那几条精简片段才会进入上下文。按需召回（top-3 ≈ 几百 token）
比每轮把全部条目塞进提示词便宜一到两个数量级。

## 自定义存储目录

面板顶部一行可查看并修改长期记忆 / 知识库的存放位置：

- 点「**选择文件夹…**」唤起**系统原生文件夹选择框**（Windows 资源管理器 / 系统对话框），
  自己浏览并选中目录即可，路径会自动回填并**立即保存**，无需手打路径。
  - 桌面端走 preload 暴露的 `window.__DSH_DIRECTORY_PICKER__.pick()`
    （主进程 `dialog.showOpenDialog({ properties: ['openDirectory','createDirectory'] })`）；
  - 取不到该桥时回退客户端服务 `ctx.uiWorkspace.pickDirectory()`；
  - 在对话框里点**取消**不会报错，也不改动当前配置。
- **浏览器环境下自动降级为手填**：`hasNativePicker()` 为假时，不渲染「选择文件夹…」按钮
  和「手动输入 / 用选择框」切换，只显示输入框 + 「保存」 + 「恢复默认」。
  若是在有选择框的环境里但调用失败（返回 `error: 'unsupported'`），会自动切到手填模式并提示
  「当前环境没有系统文件夹选择框，已切换为手动输入绝对路径。」，**此时不会发起任何保存请求**，
  等你填好再点「保存」。
- 路径校验：必须为绝对路径、是目录（不存在则创建）、可写，否则拒绝保存并返回原因
  （`目录不能为空` / `请填写绝对路径，例如 D:\dsh-memory` / `路径非法` /
  `该路径已存在且不是目录` / `目录不可写：…`）。
- 「迁移已有数据」（默认勾选）：切换目录时把现有的 `memory.json` / `knowledge.json`
  复制到新目录；目标已有同名文件则保留目标、不覆盖。
- 「恢复默认」把目录改回 `~/.dsh/storages/dsh-memory-ui/`，同样可按需迁回数据。
  （注意：恢复默认**不会**自动回到你之前自定义的目录；要回到自定义目录需重新选/填。）
- 配置写进 `~/.dsh/storages/dsh-memory-ui/config.json`（配置文件固定在此，不随数据目录漂移）。
- 目录不可写（盘符不在线等）时不会拖垮面板：读不到集合就按空集合展示，写入失败会在宿主日志留一行警告。

## 一键归档是怎么实现的

直接复用 DSH **原生**的会话归档机制，不自己造状态：

- 归档：`ctx.workspaceController.archiveSession({ sessionId, stopActivity })`
- 取消：`ctx.workspaceController.unarchiveSession({ sessionId })`

归档集就是 DSH 自己在 `workspace.json` 里维护的 `global.archivedSessionIds`。
面板上勾选多个会话 → 点一次按钮 → 逐个调用，逐条报告成功/失败（有运行中工作的会话会以
`workspace/session-active` 拒绝，面板把错误原文列出来，而且默认带 `stopActivity: true`）。
归档成功后，宿主会自动触发一次上述「自动写入」（受 `autoCapture` 开关控制）。

`ctx.workspaceController` 取不到时（DSH 改名或未提供该服务），会**降级**为直接改
`workspace.json`，并在面板顶部提示「需重启 DSH 生效」，不会让整块设置页挂掉。

## 安装

插件在**宿主侧**注册 HTTP 路由、在**客户端侧**注册 `settings.section` 插槽，不需要改
`app.asar`。

1. 插件源码放在 `~/.dsh/plugins/dsh-memory-ui/`
   （`index.js` 宿主、`client.js` 客户端、`README.md`、`package.json`、`cordis.patch.yml`、`locale/`）。
2. 在 `~/.dsh/profiles/desktop/package.json` 里：
   - `dependencies` 加 `"dsh-memory-ui": "link:C:/Users/<user>/.dsh/plugins/dsh-memory-ui"`
   - `dsh.profile.bundles` 数组加 `"dsh-memory-ui"`
3. 在 `~/.dsh/profiles/desktop/node_modules/` 下建同名符号链接指向插件目录（或跑 `pnpm install`）。
4. **重启 DSH**（改代码必须重启才生效），左下角账号菜单 → 设置 → 左侧导航「记忆与知识库」。

> 插件改的是设置页，不影响 DSH 主程序；卸载时把上面两处登记删掉、重启即可。

## 数据文件

| 文件 | 说明 |
| --- | --- |
| `<存储目录>/memory.json` | 长期记忆条目：`{ unit, version, collection, updatedAt, items[] }` |
| `<存储目录>/knowledge.json` | 知识库条目，同上结构 |
| `<存储目录>/index.json` | 倒排索引：`collections.<name>.{ fingerprint, postings, entries }`，按指纹自动重建 |

条目字段：`id / title / content / tags[] / sourceSessionId / sourceTitle / archived / pinned /
keywords[] / auto / signature / createdAt / updatedAt / archivedAt`。
自动写入的条目 id 形如 `kb-auto-<sessionId>`（长期记忆为 `mem-auto-<sessionId>`），`auto: true`。

## HTTP 接口

前缀 `/dsh-memory`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 总览：会话、长期记忆、知识库、统计、归档服务可用性，以及 `storeDir` / `defaultStoreDir` / `configFile` / `customDir` / `autoCapture` / `indexFile` |
| GET | `/session?id=&limit=` | 单个会话的最近消息 |
| GET | `/search?collection=&q=&k=&snippetMax=` | 关键词检索：`k` 夹到 1–10（默认 3），`snippetMax` 夹到 40–1000（默认 200）；返回 `{ok, collection, query, terms, indexSize, results[]}`，**不含 `state`** |
| POST | `/archive` | `{ sessionIds: [], stopActivity }`，归档后自动触发写入 |
| POST | `/unarchive` | `{ sessionIds: [] }` |
| POST | `/entry` | `{ collection, action: save/archive/unarchive/remove, ... }` |
| POST | `/promote` | `{ sessionIds: [], collection }`，手动把会话沉淀成条目（同会话只保留一条） |
| POST | `/capture` | `{ collection, sessionIds: [] 或 all: true, force }`，批量/补齐写入，返回 `{created, updated, skipped, unchanged, failed}` |
| POST | `/config` | `{ dir, migrate }` 设置自定义存储目录；`{ autoCapture }` 单独切开关；`{ reset: true, migrate }` 恢复默认 |

> 请求体请用 **UTF-8** 发送（客户端 `fetch` 默认即是）。用 `curl -d` 之类的命令行工具传
> 含中文的绝对路径时，注意终端参数编码，编码不对会写出乱码目录名。

## 注意

- 会话正文是**多帧 zstd 拼接**的 `session.v4.jsonl.zstd`；`zstdDecompressSync` 整段只会解出
  第一帧，必须按魔数 `28 B5 2F FD` 切帧后逐帧解压。读取最近消息时从尾部往前解帧，凑够条数即停。
- 会话标题来自投影缓存。QQ 桥接类会话的首条输入是身份提示词，会被识别并替换为「（自动会话 · preset）」，
  避免列表里出现一整屏提示词。
- 面板不改动 DSH 内部状态，除归档、条目增删改与存储目录配置外全部只读。
- 存储目录只影响长期记忆 / 知识库 / 索引三文件；会话归档状态仍由 DSH 自己的 `workspace.json` 提供。
- 客户端 hooks 顺序是硬约束：`MemoryPanel` / `EntryTab` 的 `useState` 数量与顺序不能变，
  新逻辑一律用 `useCallback` / `useMemo` / `useEffect`。

## License

MIT