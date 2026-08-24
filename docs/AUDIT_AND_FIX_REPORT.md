# AI Bookmark OS 全量审查与修复报告

- 报告日期：2026-08-22（第一~三轮）／2026-08-24（第四轮：复核 + 新一轮排查）／2026-08-25（第五轮：RSS 累积功能 + 全量审查）
- 审查范围：全仓库（`src/core`、`src/sidepanel`、`src/bookmark-nav`、`src/timeline`、`scripts`、构建与清单配置）
- 审查方法：多路静态审计（核心逻辑 / React UI / 原生时间线模块）→ 对每条发现逐条对照当前源码实证核验（剔除审计代理误报的过期项）→ 分组修复 → 每组修复配回归测试 → **变异验证测试有效性** → 全量门禁验证
- 验证门禁：`npm test`（60 个测试文件）、`npm run typecheck`、`npm run build`、`npm run preview:check`、`node scripts/audit-project.mjs`、Playwright 真实浏览器 E2E（`scripts/e2e-extension.mjs`，加载重建后的 `dist/`）

> 五轮修复合计：**第一轮 24 项**（功能闭环 / P1 交互 / 存储安全），**第二轮 14 项**（遗留项全部处置：12 项修复 + 2 项评估后判定不改），**第三轮 4 项**（用户反馈的主动学习链路：手工移动不自动学习 + “采用首选”报错滞留 + 批量程序性移动学习隔离），**第四轮 16 项**（复核前三轮修复 + 新排查：1 项 P0 XSS、2 项前三轮修复留下的时序漏洞、13 项 RSS/存储/权限缺陷），**第五轮 9 项**（RSS 累积保留新功能 + 该功能引入的 3 项分页回归 + 5 项既有缺陷）。第一~三轮已提交于 `b189936`，第四轮于 `95316cd`，第五轮见本轮提交。

---

## 一、问题清单与修复结果

严重级别定义：P0 数据丢失/崩溃；P1 功能破坏；P2 边界场景破坏或闭环缺失；P3 次要/体验/性能。

### 第一轮修复（已在前次会话完成并验证）

| # | 级别 | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|---|
| 1 | P2 | manifest 无 `unlimitedStorage`：书签镜像+标签缓存+草稿在 10MB 默认配额下写入失败 | `manifest.json`、`scripts/package-extension.mjs` | 两处权限清单同步新增 `unlimitedStorage`（不触发安装警告） | dist 清单抽查 + preview:check |
| 2 | P2 | 分类缓存读写失败会中止整次分类（已完成批次全部作废） | `src/core/classifier.ts` | 读失败降级为空缓存、写失败停用本轮缓存（`persistCache` 包装），不再上抛 | test-classification-cache / test-optimizations |
| 3 | P2 | 分类数据导出/导入模块（transfer.ts）无任何 UI 入口，changelog 已宣称该能力 | `src/sidepanel/App.tsx` | 侧边栏顶栏新增“分类数据管理”弹窗：导出（下载 JSON 包）、导入（文件选择 + 错误码映射为可行动提示 + 成功后整页刷新对账） | test-ui-polish-regressions + 构建产物字符串抽查 |
| 4 | P2 | changelog 断层（最新 0.5.1 vs 版本 1.0.9）：升级弹窗对之后所有升级静默失效 | `src/core/changelog.ts`、`App.tsx` | 补 1.0.9/1.0.7 条目；新增 `resolveWhatsNewEntries` 兜底（版本变化但无条目时给通用升级提示） | test-changelog-whatsnew |
| 5 | P1 | 草稿树 `key` 含 `updatedAt`：每次拖拽/重命名/批量移动整树重挂载，目录全收起、勾选丢失 | `App.tsx` | key 只随草稿切换/历史版本变化（`draft:${activeDraftKey}`），编辑间保持挂载 | test-classification-workspace-ui 断言更新 |
| 6 | P2 | 搜索框在“当前书签树/变更记录”Tab 静默无效；方案搜索不匹配分类名 | `App.tsx`、`src/core/i18n.ts` | 非 draft 视图禁用输入框并以占位符说明（`searchDraftOnly`×9 语言）；分类名命中保留整棵子树 | test-ui-polish-regressions |
| 7 | P2 | 历史版本星标失败静默；备份下载无错误反馈、可连点重复下载 | `App.tsx` | 两处补 catch→`setError`；下载加 `backupDownloading` 防连点+禁用态 | test-ui-polish-regressions |
| 8 | P2 | 书签导航页并发加载无防乱序；“摘要暂不可用”横幅出现后永不复位；标签数据源断裂（演示标签为死数据） | `src/bookmark-nav/BookmarkNavPage.tsx` | 请求序号丢弃过期响应；新一轮加载复位横幅；标签三级兜底（时间线→分类结果→标签缓存），演示模式读 `DEMO_CLASSIFY_RESULT.labels` | test-ui-polish-regressions |
| 9 | P2 | RSS 订阅源加星是死功能（状态可存、无任何视图消费） | `src/timeline/pages/standalone/feed-view.js` | 加星即持久化置顶（`rssReorderFeeds`），显示顺序与存储顺序一致、不破坏拖拽 | test-ui-polish-regressions |
| 10 | P2 | popup HTML 导入丢文件夹结构/与设置页行为不一致 | 新增 `src/timeline/shared/import-parser.js` | 抽取共享解析器（DOM 解析保留 folderPath/ADD_DATE/URL 白名单），popup 与 settings 均委托 | test-import-parser + test-data-safety 更新 |
| 11 | P2 | 变更记录树：同名兄弟目录被合并 + React key 冲突 | `src/sidepanel/changeHistory.ts`、`ChangeHistoryTree.tsx` | 叶子目录按节点 ID 区分实例，节点增加唯一 `key` 字段 | test-change-history-tree 扩展 |
| 12 | P2 | 目录展开无键盘可达路径 | `src/sidepanel/Tree.tsx`、`sidepanel.css` | 目录行 `role="button"`/`tabIndex`/`aria-expanded`/Enter+Space，焦点样式 | test-ui-polish-regressions |
| 13 | P3 | 增量队列 `enqueueIncrementalBookmarks` 不检查后台响应，失败静默 | `src/core/incrementalQueue.ts` | 检查 `success` 并上抛 | test-ai-governance 扩展 |
| 14-24 | P2/P3 | 检查页结果落盘撑爆配额（整条镜像含正文）、删除书签依赖镜像、健康批量删除撤销后置、onVisited 全量重写、popup 导入失败无反馈、RSS guid 随机退化、设置读取不自愈、pageRouter 聚焦失败不回退、listModels 无超时、图谱 fit 后缩放标签失真、DST 日期分组、乱码注释清理等 | 见对应文件 diff（均已在工作区，带注释说明） | 既有 51 个测试文件全部保持通过 |

### 第二轮修复（本轮，处置前次报告列出的全部遗留项）

| # | 级别 | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|---|
| 25 | P3（数据正确性） | LLM JSON 修复篡改字符串值：全角冒号`：`→`:`、单引号→双引号的全局替换会改写摘要内容（“教程：入门”、"it's"），修复“成功”后写进标签/缓存的是被改数据 | `src/core/llm.ts` | 新增 `mapOutsideDoubleQuotedStrings` 词法扫描器（与 `sliceBalancedJson` 同一套字符串/转义规则）：全角结构字符与尾逗号只在双引号字符串之外处理；单引号仅在定界符位置（前后邻结构符/空白）转双引号，词中撇号保留 | test-residual-fixes §1：6 个用例（值内全角冒号/撇号保留、结构位修复仍生效、`'don't panic'` 混合、值内 ", }" 不受尾逗号修复影响） |
| 26 | P3（数据安全） | 归档版本取消星标会被 10 条轮换静默删除，与“星标版本只能手动删除”设计冲突；且 `deleteClassificationPlanVersion` 全仓无调用方（无删除入口） | `src/core/classificationPlanArchive.ts`、`App.tsx` | `toggleClassificationPlanVersionPin` 取消星标前模拟轮换，若会被淘汰则拒绝并抛 `UNPIN_WOULD_EVICT_VERSION`；UI 映射为可行动提示并新增“删除版本”按钮（confirm + 错误反馈），补上显式删除闭环 | test-classification-plan-archive 新增 unpin 守卫用例（拒绝后版本仍在、星标不变；对照：最新版本加/卸星标正常） |
| 27 | P3 | AI 日志并发丢条：get→push→set 无队列 | `src/timeline/shared/ai-logger.js` | 模块级 Promise 链串行化（`enqueueLogWrite`，链上吞错防短路） | test-residual-fixes §4：并发 25 条 + 放大交错窗口 → 全部落盘 |
| 28 | P3 | smart-tagger 全部语料/规则/队列/统计为无队列读改写，并发丢更新 | `src/timeline/shared/smart-tagger.js` | 新增 `runSerializedMutation(key, task)` 按 key 串行化，包装 14 个变更函数（df 语料、贝叶斯语料、用户覆盖、动态规则 9 个变更点、审核队列、学习统计） | test-residual-fixes §5b：并发 20 次语料更新零丢失；既有推荐/学习测试保持通过 |
| 29 | P3 | `getTagColor` 每个新标签一次 get+全量 set（首屏串行 IO）；`saveTagColor` 无队列并发覆盖丢色 | `smart-tagger.js` | 颜色改为：本上下文一次缓存 + 串行**批量**写（`saveTagColorsBulk`）；规则色/哈希色是确定性的，按需计算不再 eagerly 落盘；分类流程的逐标签保存循环合并为一次批量写 | test-residual-fixes §5a：确定性 + 零 eager 写 |
| 30 | P3（性能） | 死链检测公共后缀分组：`.co.uk`/`github.io`/`blogspot.com` 等所有站点共享 2 并发槽，近乎串行 | `src/core/health.ts` | 最小公共后缀集合（30 个常见二级后缀与 PaaS 域），命中时取后三段；`rootDomain` 导出 | test-residual-fixes §2：6 个用例 |
| 31 | P3（性能） | full apply 预检与 moves 记录逐书签 `chrome.bookmarks.get`（数千书签=数千次往返），且 apply 路径执行两遍 | `src/core/bookmarks.ts` | 新增 `buildBookmarkNodeIndex`（单次 getTree 建 id→节点索引）：`assertFullPlannedBookmarksExist` 与首次应用的 moves 循环改走索引，未命中回退单条 get（语义与旧实现完全等价）；空方案短路不触发任何书签 API | test-regressions（含“存在撤销记录时不得先调书签 API”顺序断言）+ 55 文件全绿 |
| 32 | P3 | RSS 1.0（RDF）与命名空间 Atom 解析失败，误报“无文章” | `src/timeline/shared/rss-parser.js` | ① `tagContent`/`tagBlocks` 允许可选命名空间前缀（开闭标签前缀必须一致，反向引用保证）；② RDF 时 item 以 channel 兄弟节点回退到全文检索；③ `parseFeed` 路由与 `extractFeedBlock` 前缀容忍 | test-residual-fixes §3：RDF 2 条、`atom:feed/atom:entry` 2 条、RSS 2.0 不回归 |
| 33 | P3 | 独立工作台主题：未设置时默认 light（其他页为 system）、system 被一次性解析为固定值，系统深浅色切换后不跟随 | `standalone.js` | 与 popup/checker 语义对齐：默认 `system`，system 不加主题类、交给 CSS `prefers-color-scheme`（实时跟随） | test-residual-fixes §6 源码契约 |
| 34 | P3 | 图谱初始加载后缩放标签固定写 100%，与实际缩放不符 | `graph.js` | 初始加载同样回填 `cy.zoom()` 真实值（resetView 处第一轮已修） | test-residual-fixes §6 |
| 35 | P3 | 增量分类失败文案使用过期闭包 `d`（语言切换后报错为旧语言） | `App.tsx` | catch 内改 `t(uiSettingsRef.current.language)` 现取 | test-residual-fixes §6 |
| 36 | P3 | 状态横幅残留：`notice`/`error` 只在下一次操作时清除，浏览期间旧状态长挂 | `App.tsx` | notice 8 秒自动消失；切换工作区视图时清空 error+notice（error 保留至切换，保证操作期可见） | test-residual-fixes §6 |
| 37 | P3 | 保存期间的编辑静默丢弃（有意防覆盖设计），但无“保存中”反馈 | `App.tsx` | 草稿编辑区在 `savingDraft` 期间显示“正在保存方案修改…”提示（利用既有状态） | test-residual-fixes §6 |
| 38 | P3 | 侧边栏 topbar 导航按钮与 4 处错误文案硬编码中文，英文用户混合语言 | `App.tsx`、`i18n.ts` | 16 个新键 ×9 语言（zh/en/ja/ko/fr/de/es/pt/ru）；错误文案在异步回调中使用 `uiSettingsRef` 实时取词，避免语言切换后的过期闭包 | typecheck（`typeof zh` 全量约束）+ test-classification-version-ui 断言更新 |

### 第三轮修复（主动学习链路，用户反馈驱动）

用户反馈：“主动学习要手动采用首选，并且还报错了。既然是主动学习，应该是自动学习手工分配收藏夹的规则。”

| # | 级别 | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|---|
| 39 | P1（设计缺陷） | 手工移动书签只生成 `move_observation` 待复核项，必须去设置页人工点“确认为手动移动”才产生学习反馈——“主动学习”实为“被动等待确认”，与用户预期（自动学习手工归档规则）相悖 | `background.js` `queueBookmarkMoveObservation` | 手工移动即最终事实：直接落一条 `accepted` 反馈（selection=目标目录），驱动 domain→folder 规则自动学习，不再入人工复核队列。安全性不降级：程序性移动早经 `markProgrammaticBookmarkMove` 过滤；规则需 **≥2 个不同 URL 指纹** 才从 candidate 激活为 active（单次误移不会成规则）；同域多目标自动标记 `conflicted`；移动到书签根目录（空路径）不学习。附带收益：反馈携带 bookmarkId 会顺带清掉该书签遗留的“智能分类建议”待复核项——用户已亲自归档，建议自然作废。旧队列中已存在的 `move_observation` 项保留可继续人工处理（resolve 路径未删） | 新增 `test-active-learning-autolearn.mjs`：§1 移动即反馈不入队；§2 两个不同 URL 激活规则（candidate→active，指纹去重）；§3 遗留建议项被手工移动自动清理；§4 根目录移动零学习 |
| 40 | P1（用户所报报错） | “采用首选”对书签状态变化的防御检查全部**硬报错且条目永滞队列**：用户整理过书签后（移动/改标签/删除/目标目录改名），点击必现 `处理失败：bookmark_changed`（或 `folder_selection_mismatch`/`bookmark_not_found`/`no_applicable_candidate`/快照 TTL 边界的 `recommendation_not_found`），且失效项无法消除、反复报错 | `background.js` `resolveRecommendationReview` | 全部过期场景改为**自动移除 + `{success:true, staleDiscarded:true}`**：快照缺失、URL 指纹不匹配、书签已删、用户已移动/改标签（sourceParentId/sourceTags 过期）、目标目录已改名/消失、无可应用候选。语义依据：建议生成后用户已自行整理 → 手工结果优先（其移动已被 #39 自动学习），不应套用旧建议也不应报错；过期丢弃**不产生**任何学习反馈/统计/规则变动 | `test-active-learning-autolearn.mjs` §5（移动过期/删除过期两例：staleDiscarded、条目移除、反馈计数不变）+ `test-recommendation-review.mjs` 过期用例契约更新（原断言“报错且滞留”改为“自动移除”） |
| 41 | P3 | 报错 toast 直接展示原始错误码（“处理失败：bookmark_changed”），用户无法理解 | `settings.js`、`shared/i18n.js` | 新增 `recommendationResolveErrorText` 映射（`review_item_not_found`→“该项已被处理或移除”等）；`staleDiscarded` 结果以成功类 toast 提示“书签已变动，过期建议已自动移除”；新增 i18n 键 `reviewStaleDiscarded`/`reviewItemMissing`（en + zh_CN） | 源码契约断言（§6）：映射存在、双语言键齐全 |
| 42 | P1（#39 引入风险的闭环，审计自查发现） | #39 让手工移动自动学习后，**批量程序性移动**必须与之隔离，否则一次全量分类应用（数百~数千次 `chrome.bookmarks.move`）会把分类器自身输出误学为用户归档意图，污染全部学习规则；设置页“应用建议”也会因移动+建议反馈双重记账。程序性标记（`markProgrammaticBookmarkMove`）原本只覆盖 background 内部 3 处，`src/core/bookmarks.ts` 的全量/局部应用与撤销（sidepanel 上下文执行）完全未标记 | `background.js`、`src/core/bookmarks.ts`、`settings.js` | 三层隔离：① 抑制窗口——新消息 `setMoveLearningSuppression`（10 分钟硬上限防调用方崩溃后永不恢复），`handleSingleBookmarkMoved` 在窗口内只更新镜像不学习；② core 四入口（`applyToBookmarks`/`applyPartialToBookmarks`/`undoApply`/`undoLatestApply`）改为薄导出包装：进入时暂停、`finally` 恢复（嵌套计数防误恢复；无 runtime 的测试桩下静默跳过）；③ 单条标记——新消息 `markProgrammaticMove`，设置页“应用建议”移动前标记（其学习反馈由 `submitBookmarkRecommendationFeedback` 统一产生，避免重复）；导航页拖放/编辑选目录是真实手工归档，**保留学习** | `test-active-learning-autolearn.mjs` §7：抑制窗口内镜像更新但零学习；窗口结束后恢复正常学习；单条程序性标记不学习；§8 契约：四入口 Internal+包装+finally 恢复、两个新消息、10 分钟上限、设置页标记存在 |

### 第四轮修复（对前三轮修复的复核 + 新一轮全量排查）

复核结论：前三轮 42 项修复**在当前代码中全部真实存在**，实现方式与报告描述一致（逐项回源码核对，重点复验了 `llm.ts` 词法扫描器、`health.ts` 公共后缀表、`bookmarks.ts` 树索引、`classificationPlanArchive.ts` unpin 守卫、第三轮主动学习三层隔离）。但第三轮 #42 的"程序性移动隔离"存在**两处同源实现缺陷**（下表 #43/#44）：隔离判定被放在异步串行队列的**出队时刻**，而批量应用的真实时序会让判定失效。原测试直接调用 `handleSingleBookmarkMoved`、绕过了 `onMoved` 监听器与队列，因此漏过。

| # | 级别 | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|---|
| 43 | P1（学习数据污染） | 抑制窗口判定发生在队列**出队时**：批量应用瞬间产生海量 `onMoved` 全部入队，队列每条都要 `bookmarks.get` + `loadBookmarkFolderOptions`（读全树）+ 镜像写入，消费远慢于产生；core 侧 `finally` 的"恢复学习"早已执行，积压事件遂以"未抑制"状态出队，把分类器自身输出误学为用户手工归档规则 | `background.js` `onMoved` 监听器 / `handleSingleBookmarkMoved` | 抑制状态改为在**事件到达时同步捕获**（`suppressedAtEvent`），随事件传入处理函数；判定取"事件时"与"当前"的并集，兼容函数被直接调用（无事件上下文）的场景 | 新增 `test-move-learning-queue-race.mjs`：走真实 `onMoved` 路径 + 闸门控制队列积压，复现"抑制期入队→解除→出队"。改回旧逻辑实测泄漏 3 条规则 |
| 44 | P1（学习数据污染） | 单条程序性标记（`markProgrammaticBookmarkMove`，设置页"应用建议"用）带 30 秒 TTL，但 `consumeProgrammaticBookmarkMove` 同样在**出队时**才校验：批量应用建议时队列积压超过 30 秒，标记被判为"已过期"而漏判，同样造成误学 | 同上 | 标记消费同样移到事件到达时刻（`programmaticAtEvent`）；处理函数直接采信该结论，不再重复消费。标记按书签 id 记录，文件夹移动事件查不到条目、不会误消费 | 同上，§TTL 场景用可控时钟推进 31 秒复现；改回旧逻辑实测误学 1 条 |
| 45 | **P0（XSS，可提权到扩展 origin）** | `escapeHtml` 走 `textContent`→`innerHTML`，**只转义 `& < >`，不转义引号**，却被用于 21 处 HTML **属性**上下文（如 `<img src="${esc(url)}">`）。RSS `extractImageUrl` 取到属性值后又执行 `decodeEntities`，把 `&quot;` 还原成真引号 → 恶意订阅源可闭合属性注入 `onerror`，在扩展页面 origin 内执行任意脚本（可访问 `chrome.bookmarks` 等全部权限） | `standalone.js`、`popup.js`、`settings.js`、`checker.js`、`mdi-manager.js` 各自的 `escapeHtml` | 五处实现统一补齐 `"`→`&quot;`、`'`→`&#39;`（在各自原有风格上最小改动，不改函数名/签名/调用点）。`graph.js`、`escapeHtmlForExport`、`escapeHtmlForTagRules` 原本已正确转义引号，不动 | `test-audit-round4-fixes.mjs` §1：5 个文件逐一断言引号被转义 + 实测注入载荷 `url="...&quot; onerror=&quot;alert(1)"` 无法闭合属性 |
| 46 | P1（单字符致订阅源永久失效） | `decodeEntities` 用 `String.fromCodePoint(code)` 只校验 `code > 0`，**缺上界**：`&#1114112;` / `&#x110000;` 抛 `RangeError`，异常经 `stripTags`→`parseFeed` 冒泡，被 `feed-fetcher` 当成拉取失败（`failCount++`、`lastError:"Invalid code point 1114112"`），累计 3 次进入退避，一个字符即可让订阅源永不恢复 | `rss-parser.js` | 抽出 `codePointToString`：越界（`> 0x10FFFF`）或非法时丢弃该实体，并保留 `try/catch` 兜底；emoji 等增补平面字符行为不变 | §2：三种越界写法均正常解析，`&#128512;`（😀）仍正确解码 |
| 47 | P1（条目链接损坏） | 标签匹配正则的开标签段 `(?:\s[^>]*)?>` 中 `[^>]*` 会吞掉自闭合斜杠，把 `<atom:link rel="self" href="..."/>` 当作开标签；闭合侧 `(?:\1:)?` 为可选组，后面真正的 `</link>` 又能闭合它，于是 `<link>` 正文被整段吞入。WordPress 类源近乎通用 | `rss-parser.js` `tagContent`/`tagBlocks` | 提取共用 `tagRegExp`，开标签属性段结尾禁止为 `/`（`(?:\s[^>]*[^/>])?\s*>`） | §3：`siteUrl` 从 `"<link>https://ex.com/site"` 修正为 `"https://ex.com/site"`；条目 `link` 同样修正 |
| 48 | P1（第三轮 #32 未闭环） | 第三轮给 `tagContent`/`tagBlocks`/`extractFeedBlock` 加了命名空间前缀容忍，但 `collectLinks` 的 `/<link\s([^>]*?)(?:\/?)>/gi` **未加**，而 Atom 的 `siteUrl` 与 `entry.link` 全部依赖它 → 带前缀的 Atom"能解析出条目但全部不可点击" | `rss-parser.js` `collectLinks` | 正则补可选前缀 `<(?:[\w.-]+:)?link\s...`，与其余标签匹配保持一致 | §4：`<atom:feed>` 的 `siteUrl` 与 entry `link` 由 `""` 修正为正确 URL |
| 49 | P2（本次前缀容忍引入的回归） | 前缀容忍让 `<itunes:title>`/`<dc:title>`/`<media:description>` 与无前缀标签**等价竞争**，`tagContent` 取第一个匹配、谁先出现谁赢：播客源的 `title`/`link`/`description`/`author` 会被命名空间标签劫持 | `rss-parser.js` | 改为**无前缀优先**：扫描全部匹配，命中无前缀标签立即返回；仅当整篇不存在无前缀标签时才回退到带前缀（继续支持通篇命名空间的 Atom）。`tagBlocks` 同构处理 | §5：`<itunes:title>WRONG</itunes:title>` 先于 `<title>RIGHT</title>` 时，结果为 `RIGHT`；RSS2/Atom/RDF 全部回归通过 |
| 50 | P1（用户数据静默丢失） | `upsertItems` 达上限后 `existing.length = limit` 纯按时间序截断，**不保护** `starred:true` / `bookmarkId != null` 的条目。星标视图直接读同一分片，且这些用户状态（星标、与书签的关联 id）**无任何别处备份** → 加星的旧文章被新文章挤出即永久消失 | `feed-store.js` | 截断时先保留全部受保护条目（星标 / 已建书签），剩余额度再按时间序填补普通条目，最终仍按时间序输出 | §6：受保护条目在截断后留存；对照场景（无受保护条目）截断行为与原来完全一致 |
| 51 | P2（清空后日志复活） | 第二轮把 `logAIEvent` 串行化进 `logWriteChain`，但 `clearAILogs` 直接 `storage.remove`**绕过同一条链**：某次写入已完成 `get`（持有 400 条旧数组）、正 `await set` 时用户点"清空"，`remove` 先生效，随后 `set` 把旧数组连同新条目写回。UI 已提示"日志已清空"，刷新后全部复活 | `ai-logger.js` | `clearAILogs` 改为走 `enqueueLogWrite`，与写入共用同一条串行链 | §7：闸门卡住在飞 `set` 后触发清空，结果为空数组；清空后新日志照常写入 |
| 52 | P2（订阅普通网页"成功"后永久报错） | `fetchAndInit` 只判 `if (!parsed) throw`，**不校验 `items.length`**；而 `fetchOne` 判 `items.length === 0` 就 `throw empty_feed`。把普通 HTML 页加为订阅会"添加成功"（`title` 取自 `<title>`），此后每轮拉取都以 `empty_feed` 失败并累积退避 | `feed-fetcher.js` | `fetchAndInit` 补 `items.length === 0` → `empty_feed`，与 `fetchOne` 判定对齐（代理分支的 `_fetchViaProxy` 内部已有同样校验） | §9：普通 HTML 页订阅被正确拒绝；对照：真实 feed 仍订阅成功 |
| 53 | P2（304 永久锁死，文章永久丢失） | `fetchOne` 先 `updateFeed(patch)` 提交 `etag`/`lastStatus:'succeeded'`，**之后**才 `upsertItems`。若条目写入失败，异常被捕获按失败处理，但 **etag 已持久化** → 下一轮带 `If-None-Match` 得到 304 直接标记成功返回 `added:[]`，这批文章永远不会再写入 | `feed-fetcher.js` | 直连与代理两个分支统一改为**先落条目、再提交元信息** | §10：源码顺序断言 + 行为断言（`upsertItems` 抛错时 `etag` 未落库、状态记为 `failed`） |
| 54 | P2（异常逃逸 + badge 停更） | `try { global.onFeedPollComplete(results); } catch {}` 是**同步** try，而回调是 `async` 函数：其内部 `getSettings()`/`getAllFeeds()` 一旦 reject 就变成 unhandled rejection（同步 catch 抓不到），且回调末尾的 `await updateBadge()` 不再执行，未读数长期停在旧值 | `feed-fetcher.js` `pollAll` | 改为 `await global.onFeedPollComplete(results)` 后再吞错 | §13：回调 reject 时 `pollAll` 不抛出、且已等待其完成（行为级区分 await 与否） |
| 55 | P3（功能被误伤） | `_isPrivateOrLocalHost` 用 `host.startsWith('fc')/('fd')` 判定 IPv6 ULA，但对**任意主机名**做前缀匹配：`fcbarcelona.com`、`fdroid.org`、`fc2.com`、`fedoraproject.org` 均被判为私有地址，代理回退被静默禁用且用户看不到原因 | `feed-fetcher.js` | 前缀判断限定在 IPv6 字面量内（`host.includes(':')` 守卫内），IPv4 与域名走原有分支 | §8：5 个公网域名判定为 false，12 个真实私有/本地地址仍全部拦截 |
| 56 | P3（孤儿分片永久泄漏） | `removeFeed` 先从 `rss_feeds` 摘除、再删 `rss_items_<id>`，两次独立写入。若第二步失败或 SW 在两步间被回收，`rss_items_<id>` 成为孤儿：后续所有遍历都以 `getAllFeeds()` 为起点，**无任何路径能再发现或清理它**，也没有 GC | `feed-store.js` | 两次写入无法原子化，改为挑**失败后可恢复**的顺序：先删条目分片、再摘除 feed。本序失败只留下"条目为空但仍在列表里的 feed"，下一轮拉取即可自行补齐 | §11：分片删除失败时索引保留（可恢复）；对照：正常删除同时清掉索引与分片 |
| 57 | P3（权限缺失伪装成"没有源"） | `discoverInTab` 的 `catch { return [] }` 覆盖了 `executeScript` 因未授予 `optional_host_permissions` 而抛的异常 → UI 显示"未发现可订阅的 RSS 源"，用户无从得知真实原因是缺权限，也不会被引导授权 | `feed-discover.js`、`background.js` 右键订阅 | 权限类错误上抛可识别错误码 `rss_discover_permission_denied`（其余错误仍返回 `[]`）；右键订阅路径补一条可行动通知提示去授权。消息通道 `rssDiscoverActive` 原有 catch 已能返回 `{success:false,error}` | §12：权限错误正确上抛；对照：真正无源仍返回 `[]`、不可注入页面（`chrome://`）仍静默返回 `[]` |
| 58 | P3（测试自身缺陷，凌晨必然失败） | `test-popup-timeline-grouping.mjs`（v1.0.9 会话新增）以 `Date.now()` 为基准构造 `now-60s` 与 `now-3h` 两个"今天"样本：在 00:00~03:00 之间运行时 `now-3h` 落到前一天，多出"昨天"分组令断言无故失败（本次即在 00:19 触发）。产品代码正确 | `scripts/test-popup-timeline-grouping.mjs` | 基准锚定到"当天本地正午"，小时级偏移始终留在同一天；日期级偏移（10/11 天）行为不变 | 修复后任意时刻稳定通过 |

**变异验证**：为避免"测试空转"，逐项把修复改回旧逻辑并重跑测试，确认 **15/15 变异全部被捕获**（含 #43/#44 的队列时序、#45 五处 `escapeHtml`、#50 星标保护、#53 落库顺序、#54 的 await）。变异脚本每次改写后立即校验恢复结果，全部文件已确认复原。

### 第五轮：RSS 累积保留（新功能）+ 全量审查

本轮先按用户需求实现"RSS 订阅累积保留"，再做一次全项目审查。累积功能本身改变了一个既有前提——**单个源的条目数从有上限变成无上限**，因此必须同时处理两条配套链路，否则功能上线即引入性能与正确性问题：条目全量经 `sendMessage` 结构化克隆回前台（负载随历史无上限增长）、单 feed 视图一次性渲染全部条目（DOM 节点数无上限）。

#### 新功能实现

| # | 内容 | 位置 | 说明 |
|---|---|---|---|
| N1 | `maxItemsPerFeed: 0` 表示"不限制（累积保留）"，并设为新默认值 | `feed-store.js` | 关键点：不能用 `maxItems \|\| 100` 兜底，那会把"0 = 不限制"错当成未设置。新增 `resolveItemLimit` 显式区分 `0`（不限制）与 `undefined/NaN`（回退 100）。截断分支加 `limit > 0` 守卫 |
| N2 | 旧默认值一次性迁移 | `feed-store.js` `normalizeSettings` | 老用户存量设置若"无 `settingsVersion` 且恰为旧默认值 100"，视为从未主动改过 → 迁到累积模式；选过 50/200/500 的属主动选择，保持不变。`getSettings` 与 `setSettings` 共用同一归一化函数——否则未迁移的旧值会随 `stored` 展开被写回，迁移永远无法落地 |
| N3 | 三个有界查询 | `feed-store.js` + `background.js` | `getItemsPage`（单 feed 分页）、`getFeedOverview`（每源只回预览条目 + 真实总数）、`getStarredItems`（后台过滤）。`rssGetItems` 原语义保留不动，供导出等需要全量的场景 |
| N4 | 单 feed 视图增量分页渲染 | `feed-view.js` | 复用项目既有的 scroll + 哨兵惯例（与 standalone 时间轴一致），未引入新机制 |
| N5 | 设置页"不限制（累积保留）"选项 + en/zh_CN 文案 | `settings.html`、`settings.js`、`i18n.js` | 顺带修掉设置页未读徽标为算一个数字而拉取全量条目的问题（改用新增的 `rssGetUnreadCount`） |

#### 审查发现并修复的问题

其中 #59~#61 是我自己在 N4 里引入的回归，由审查代理实测复现后修正。

| # | 级别 | 问题 | 位置 | 修复方式 | 验证 |
|---|---|---|---|---|---|
| 59 | P1（漏条，本轮引入） | offset 分页在数据集变化时错位：开着"仅未读"读掉一篇后，后台的未读数组整体前移一位，而前台仍用已渲染条数当 offset → 下一页跳过一条，**该文章永远不再出现**，但侧栏未读数仍把它算在内（未读数降不到 0，用户找不到剩下哪几篇） | `feed-view.js`、`feed-store.js` | 改**游标分页**：游标是上一页最后一条的 `{sortKey, id}`，只取"排在该条之后"的条目，与位置无关。同时给排序加 id 兜底形成全序（否则同时间戳条目相对次序不定，游标无法稳定定位）。游标条目自身被读掉也能正确定位（不靠 `findIndex(id)`） | 实测：读掉 10 篇后第二页首条仍为 `i050`，漏条 0 |
| 60 | P1（重复，本轮引入） | 同一机制的另一面：翻页期间轮询写入新文章插在数组头部，原 offset 位置的条目下移 → 下一页重复回传已渲染的条目。重复卡片会让加星/存书签的 DOM 更新只作用于其中一张，另一张状态永久不同步 | 同上 | 同上（游标是内容基准，不受插入影响）；并保留已渲染 id 集合作为兜底 | 实测：新增 10 篇后重复条数 0 |
| 61 | P1（本轮引入，高频触发） | 读一篇文章就把已翻的页数全部丢弃：`setRead`/`toggleStar` 写 `rss_items_*` → `storage.onChanged` **在本窗口同样触发** → 重渲染把已加载条数归零、只取第一页。用户滚了 150 篇、点开第 120 篇去读，回来只剩 50 篇且滚动回到顶部。读得越深代价越大 | `feed-view.js` | 记录分页状态所属视图（含未读过滤开关），同视图重渲染时按已加载条数取回并恢复滚动位置；仅视图真正切换时才归零 | 变异验证覆盖（改回归零即失败） |
| 62 | P2（既有） | overview/starred 卡片的星标按钮 `data-act="star-item"`，而 `toggleStar` 查 `[data-act="star"]`——属性选择器是**精确等值匹配**，拿到 `null` 后 `btn.classList.toggle` 抛 TypeError 被 catch 吞掉，连同"取消星标即移除卡片"一起失效 | `feed-view.js` | 选择器同时列出两种形态 `[data-act="star"], [data-act="star-item"]`，并加空值守卫 | 源码契约断言 |
| 63 | P2（既有） | "已加星"视图的"标记全部已读"：条目真被标记了，但计数重置逻辑用 `else if (currentView !== 'starred')` 把 starred 排除 → 侧栏与 Tab 徽标停在旧数字，用户看到"更新成功"却觉得未读数没动 | `feed-view.js` | starred 跨多源无法整源清零，改为按实际标记成功的条目逐源扣减 | 源码契约断言 |
| 64 | P2（既有） | 设置页保存 RSS 设置：后台校验失败（非 https 代理模板 / 多个 `{url}` / 超长）时 `setSettings` 抛错，但被 background 的 catch 转成**正常返回**的 `{success:false}`——`sendMessage` 不会 reject。`saveRssSetting` 丢弃返回值，7 处调用方无条件提示"已保存"，而配置根本没写进存储 | `settings.js` | `saveRssSetting` 显式检查 `success` 并抛错（这也**激活了 proxyFallback 开关处已有但一直是死代码的回滚 catch**）；新增统一反馈助手：失败时提示可行动原因并从存储回读纠正控件状态 | 源码契约断言 + 裸调用计数 |
| 65 | P2（既有） | JSON Feed 缺 `id` 与 `url` 的条目被静默丢弃：RSS（278 行）与 Atom（318 行）都有 `fallbackItemGuid` 兜底，JSON Feed 路径独独没有 → 空 guid 被 `upsertItems` 无条件 skip，既不入库也不计入新增，且每轮拉取都重新丢弃一次 | `rss-parser.js` | 按同一模式补齐兜底 guid 链 | 实测：3 条中 2 条无 id/url 的条目从丢弃变为正常入库，且跨轮 guid 稳定（不会误判为新文章） |
| 66 | P3（既有） | 订阅成功提示的篇数是解析条数而非落库条数（"订阅成功（3 篇）"但列表只有 1 篇） | `background.js` 两处订阅路径 | 改用 `upsertItems` 返回的真实 `added` 长度 | dist 产物核验 |
| 67 | P3（既有） | `getEffectiveDomain` 对多级公共后缀取到后缀本身：`a.b.co.uk` → `co.uk`、`a.b.c.com.cn` → `com.cn` | `smart-tagger.js` | 复用 `core/health.ts` 的公共后缀表思路补一份 | 9 个用例逐一验证 |
| 68 | P1（既有，core 侧） | 全量撤销部分失败时**静默返回**，UI 显示"已撤销，恢复 N 条书签"：局部撤销的同一情形会抛错，全量路径不会。而 `App.tsx handleUndo` 只在 catch 里报错，成功分支无条件显示成功 → 用户在仍有书签留在 AI 目录的情况下看到成功提示并关闭面板，不知道需要再撤销一次 | `src/core/bookmarks.ts` `undoFullApply` | 与局部路径对齐抛出同类错误，并提取共用错误常量避免两处文案漂移。撤销记录仍保留（数据不丢，可重试），仅改错误上报 | 更新既有测试 `testUndoKeepsUnrestoredBookmarks` 的契约（保留其"不递归删除、保留记录"的原始意图，新增"必须抛错"维度） |

#### 审查代理报了但我判定不改的一项

`undoFullApply` 在"书签已全部恢复、但 `removeOwnedCreatedFolders` 失败"时会写回 `{moves: []}` 并保留记录，审查代理判定为"记录永久卡死、UI 可撤销永久亮着"。我实测复现了该现象，但**撤回了修复**：`test-full-replacement.mjs:321` 与 `test-regressions.mjs` 两处测试都明确断言这一行为，说明是刻意设计——目录删不掉正是因为用户往里放了自己的东西，保留记录是为了让用户手工移走内容后**再点一次撤销即可完成目录清理**。出口是用户先移走自己的内容，不是无出口循环。单方面推翻两处明确的测试契约不合适；若要改成"达成撤销义务即清除记录"，属产品语义决策，应由用户确认。已在代码中加注释说明为何不能改。

### 评估后判定不修（附理由）

| 项 | 位置 | 不修理由 |
|---|---|---|
| createLevel 每建一个文件夹全量落盘 apply record（O(文件夹数×记录大小)） | `bookmarks.ts` | 该日志承载崩溃恢复正确性：代码注释明确"Never removeTree"（防止用户在崩溃后自存入暂存目录的书签被级联删除）。节流会让未入账的暂存目录在崩溃后永久泄漏（含用户书签时不可自动清理）。正确性优先于该写入成本，保留原设计。 |
| `prunePartialResults`/`listSavedClassifyResults` 的 `storage.local.get(null)` 全量读 | `classifier.ts` | 两处需要读取值本体做校验（`isSavedClassifyResult`/`createdAt`），Chrome storage 无键枚举 API；仅发生在保存/列出草稿时，非高频路径。引入索引键需迁移方案，风险大于收益。 |
| partial 预检的全树索引化 | `bookmarks.ts` | 既有测试守护的设计不变量："partial 范围禁止读取整棵书签树”。partial 目标目录内数量有限，逐条 get 成本可控（第二轮实现中先做索引后回退，正是被该测试拦下）。 |

---

## 二、主要修改文件

**第一轮**：`manifest.json`、`scripts/package-extension.mjs`、`src/core/{classifier,transfer,changelog,settings,llm,pageRouter,incrementalQueue,bookmarks}.ts`、`src/sidepanel/{App,Tree,ChangeHistoryTree,changeHistory}.tsx/ts`、`sidepanel.css`、`src/bookmark-nav/BookmarkNavPage.tsx`、`src/core/i18n.ts`、`src/timeline/background/background.js`、`pages/{checker/checker,graph/graph,popup/popup,settings/settings,standalone/standalone}.*`、`shared/{i18n,rss-parser}.js`、新增 `shared/import-parser.js`。

**第二轮**：`src/core/llm.ts`（词法感知修复）、`classificationPlanArchive.ts`（unpin 守卫）、`health.ts`（公共后缀）、`bookmarks.ts`（树索引）、`i18n.ts`（16 键×9 语言）、`src/sidepanel/App.tsx`（删除版本按钮、横幅自动清除、保存指示、i18n 接入、实时取词）、`src/timeline/shared/{ai-logger,smart-tagger,rss-parser}.js`、`pages/{standalone,graph}`、删除死代码 `src/sidepanel/HealthPanel.tsx`。

**测试**：新增 `test-residual-fixes.mjs`（6 节）、`test-import-parser.mjs`、`test-changelog-whatsnew.mjs`、`test-ui-polish-regressions.mjs`；扩展 `test-classification-plan-archive`、`test-ai-governance`、`test-change-history-tree`、`test-data-safety`、`test-classification-workspace-ui`、`test-classification-version-ui`、`test-folder-restore-order`（stub 补 getTree/根节点）。

**第三轮**：`src/timeline/background/background.js`（`queueBookmarkMoveObservation` 自动学习、`resolveRecommendationReview` 过期自动移除、移动学习抑制窗口 + `setMoveLearningSuppression`/`markProgrammaticMove` 消息）、`src/core/bookmarks.ts`（四入口程序性移动抑制包装）、`src/timeline/pages/settings/settings.js`（结果文案映射 + 重新评估应用移动标记）、`src/timeline/shared/i18n.js`（2 键 × en/zh_CN）；新增 `test-active-learning-autolearn.mjs`（8 节），更新 `test-recommendation-review.mjs` 过期契约。

**第四轮**：`src/timeline/background/background.js`（`onMoved` 事件时捕获抑制状态与程序性标记、右键订阅权限提示）、`src/timeline/shared/rss-parser.js`（`codePointToString` 上界保护、`tagRegExp` 统一标签匹配 + 自闭合斜杠、无前缀优先、`collectLinks` 前缀容忍）、`src/timeline/shared/feed-store.js`（截断保护星标/已建书签条目、`removeFeed` 可恢复顺序）、`src/timeline/shared/ai-logger.js`（`clearAILogs` 入写入队列）、`src/timeline/background/feed-fetcher.js`（先落条目再提交 etag ×2 分支、`fetchAndInit` 校验条目数、await 异步回调、ULA 判定限定 IPv6）、`src/timeline/background/feed-discover.js`（权限错误上抛）、五处 `escapeHtml` 补引号转义（`standalone.js`、`popup.js`、`settings.js`、`checker.js`、`mdi-manager.js`）；新增 `test-audit-round4-fixes.mjs`（13 节）、`test-move-learning-queue-race.mjs`（真实 `onMoved` 路径 + 队列积压/TTL 时序），修复 `test-popup-timeline-grouping.mjs` 的时间依赖缺陷。

第四轮改动共 12 个源文件、158 增 45 删（不含新增测试 828 行）。全部修改遵循"不新增/不重命名函数、不改签名与数据格式"的约束：唯一的接口面变化是 `handleSingleBookmarkMoved` 新增一个可选 `options` 参数（默认 `{}`，省略时行为与旧实现完全一致），`rss-parser.js` 内部新增 `codePointToString`/`tagRegExp`/`unwrapCdata` 三个私有辅助函数（不进导出面）。

**第五轮**：`src/timeline/shared/feed-store.js`（累积模式默认值 + 一次性迁移、`resolveItemLimit`、游标分页 `getItemsPage`、有界查询 `getFeedOverview`/`getStarredItems`、全序比较器 `compareByNewest`）、`src/timeline/pages/standalone/feed-view.js`（游标翻页 + 同视图重渲染保留已加载范围与滚动位置 + 渲染去重兜底 + 星标按钮双选择器 + starred 未读计数扣减）、`src/timeline/background/background.js`（4 个新消息 `rssGetItemsPage`/`rssGetFeedOverview`/`rssGetStarredItems`/`rssGetUnreadCount`、两处订阅报数改用真实落库数）、`src/timeline/pages/settings/settings.js`（`saveRssSetting` 检查 `success` 并抛错 + `saveRssSettingWithFeedback` 统一反馈 + 徽标改用计数消息）、`src/timeline/pages/settings/settings.html`（"不限制（累积保留）"选项）、`src/timeline/shared/rss-parser.js`（JSON Feed 兜底 guid）、`src/timeline/shared/smart-tagger.js`（`getEffectiveDomain` 公共后缀表）、`src/timeline/shared/i18n.js`（3 键 × en/zh_CN）、`src/core/bookmarks.ts`（全量撤销部分失败改为抛错 + `PARTIAL_RESTORE_ERROR` 常量）；新增 `test-rss-accumulate.mjs`（10 节）、`test-audit-round5-fixes.mjs`（8 节），更新 `test-regressions.mjs` 的撤销契约。

第五轮改动共 10 个源文件、517 增 87 删（含新增测试）。接口面变化仅为新增：`getItemsPage` 的 `options.cursor`（不传则回退 offset，旧调用方行为不变）、4 个新消息（`rssGetItems` 原语义完整保留供导出等全量场景使用）。唯一的行为契约变更是 `undoApply` 在部分恢复失败时由"静默返回"改为"抛错"，已同步更新守护测试。

## 三、配置 / 接口 / 依赖变更

- manifest（含打包脚本）：`+unlimitedStorage`；无其他权限/依赖变更，无 npm 依赖增删，无 storage schema 变更（新增 UI 全部复用既有键与后台单写者消息）。
- popup 导入消息补传 `folderPaths`/`duplicateStrategy`（后端既有字段，两入口对齐）。

## 四、测试与验证证据（最终状态）

| 命令 | 结果 |
|---|---|
| `npm test` | **All 60 test files passed**（58 → 60：+`test-rss-accumulate` +`test-audit-round5-fixes`） |
| `npm run typecheck` | 通过（`typeof zh` 约束下 9 语言字典全量一致） |
| `npm run build` + `npm run preview:check` | 构建成功，`VERIFY PASS` |
| `node scripts/audit-project.mjs` | `PROJECT AUDIT PASS` |
| dist 产物核验 | 第四轮 22 项 + 第五轮 17 项逐条抽查通过（含 manifest 版本） |
| E2E（`scripts/e2e-extension.mjs`，加载重建后的 `dist/`） | **Extension E2E passed**（真实浏览器：SW 启动、合成书签、时间线、设置 AI 连接 mock、RSS、推荐审核、键盘焦点、溢出检查） |

说明：Playwright 官方 chromium-1228 下载在本网络停滞，E2E 经 `executablePath` 使用本机已有的 chromium 构建运行（Chrome 140+，高于 manifest 要求的 114）。

E2E 稳定性：第五轮共运行 4 次，通过 3 次。唯一一次失败落在**主动学习列表分页**断言（`actual: 4, expected: 5`），与本轮 RSS/撤销改动无代码交集；随后连续两次运行均通过。该次失败的完整堆栈已随进程输出被截断，仅存的 `generatedMessage: true` 与脚本中唯一"期望 5"的断言（第 671 行，带自定义消息）相矛盾，因此**未能可靠定位到具体断言行**，作为既有不稳定项如实记录，未纳入本轮修复清单。

### 第四轮的变异验证（测试有效性证明）

新增测试若只是"跟着现有实现写断言"，无法证明它真的守护了缺陷。因此对第四轮每一项修复，都把源码临时改回修复前的旧逻辑，重跑对应测试，确认它**会失败**，随后恢复并校验文件复原：

```
变异被捕获: 15/15    所有文件已恢复: YES
```

15 项逐条为：#1 引号转义、#2 实体上界、#3 自闭合斜杠、#4 前缀 link、#5 星标保护、#6 清空入队、#7 标签劫持、#8 条目数校验、#10 etag 顺序、#11 await 回调、#12 ULA 守卫、#14 删除顺序、#15 权限上抛、#A 抑制时序、#B 标记 TTL。

首轮变异脚本暴露出两个问题，均已处置：一是 #11 当时为 `WEAK`（改回旧逻辑测试仍通过 → 说明缺乏守护），补 §13 行为断言后转为 `OK`；二是脚本在 Windows 下恢复 `feed-fetcher.js` 时写入失败（errno -4094），把该文件留在了变异状态——已即时发现并恢复，重写后的脚本对每次恢复做写后校验与重试，并在最终统一核对全部文件。

### 第五轮的变异验证

RSS 累积功能与本轮修复分两批做变异验证，全部通过：

```
累积功能：      变异被捕获: 8/8    所有文件已恢复: YES
第五轮修复：    变异被捕获: 8/8    所有文件已恢复: YES
```

累积 8 项：默认累积、`resolveItemLimit` 的 0 边界、累积模式跳过淘汰、旧默认值迁移、`setSettings` 归一化落地、overview 负载有界、分页排序口径、单 feed 不再全量拉取。
修复 8 项：游标分页、重渲染保留范围、星标双选择器、starred 计数扣减、`saveRssSetting` 检查 `success`、JSON Feed 兜底 guid、`getEffectiveDomain` 后缀表、全量撤销部分失败上报。

首轮同样暴露出两处测试自身的弱点，均已修正：**#2「重渲染保留已加载范围」当时为 `WEAK`** —— 断言只检查 `preservedCount` 这个标识符是否出现，把它改成常量 `0` 仍能通过；加严为断言完整表达式 `sameView ? articleLoadedCount : 0` 与 `Math.max(ARTICLE_PAGE_SIZE, preservedCount)` 后转为 `OK`。**#6 锚点未命中被跳过** —— 变异脚本里写的 guid 表达式与源码不一致（源码用 `itemLink`），修正锚点后转为 `OK`。这两处正是变异验证的价值所在：不做变异就会把"看起来在守护"的空转断言当成有效覆盖。

## 五、残余风险与后续建议

1. **跨上下文写竞争（收敛但未根除）**：smart-tagger/ai-logger 现在同上下文内严格串行（第四轮把 `clearAILogs` 也纳入同一条链）；popup/SW/独立窗口多上下文同时写同一 key 仍有最后写者覆盖窗口。根治需迁移到后台 `mutateStorageResource` 单写者（建议后续单独一轮做，配合消息协议改造）。
2. **词法感知修复的边界**：模型输出含未闭合双引号时，字符串状态跟踪可能错位，导致修复不生效——此时行为退回“解析失败→JSON 修复请求/重连”，与修复前一致，无数据风险。
3. **公共后缀表为人工维护**：未覆盖的二级后缀（如小众国别后缀）仍按后两段分组，仅影响并发度不影响正确性。
4. **RSS 解析器是正则实现，存在结构性上限**：第四轮修掉了自闭合标签、命名空间前缀、越界实体三类问题，但 CDATA 内出现 `</item>` 字面量仍会截断条目块（实测该条目 `link` 解析为空，标题仍在）。正则无法理解 CDATA 边界，根治需换 XML 解析器；SW 环境无 `DOMParser`，需引入依赖，属独立技术选型，未在本轮改动。
5. **`escapeHtml` 现在转义引号，产出串变长**：`&quot;`/`&#39;` 比原字符长，若某处把 `escapeHtml` 的结果用于长度计算或再解码，行为会变化。已核查全部调用点均为 HTML 拼接，无此类用法。
6. **`removeFeed` 仍非原子**：第四轮只把两次写入调整为"失败后可自愈"的顺序（先删分片再摘索引，失败只留空条目的 feed，下轮拉取自行补齐），并未实现真正的事务。Chrome storage 无多键原子写，根治需引入写前日志。
7. **累积模式下 storage 读写粒度仍是整个分片**（第五轮新增）：`chrome.storage` 无法只读一页，`getItemsPage` 仍要把整个 `rss_items_<feedId>` 读进内存再切片。游标分页解决的是**跨进程传输体积**（sendMessage 的结构化克隆），不是磁盘读取量。单源累积到极大量级（数万条）时，后台单次读取的内存与 JSON 解析成本会显现。根治需按时间分片存储（如 `rss_items_<feedId>_<yyyymm>`），属存储结构改造，未在本轮做。
8. **全量撤销的"目录清理失败"仍保留撤销记录**（第五轮评估后判定不改）：审计代理将其报为"记录永久卡死"，但 `test-full-replacement.mjs:321` 与 `test-regressions.mjs` 两处测试都明确断言该行为。复查后认定这是刻意设计而非缺陷——记录保留是为了让用户**先把自己放进 AI 目录的内容移走，再点一次撤销即可完成目录清理**，出口在用户手里。代价是撤销按钮在此期间持续可点且提示"恢复 0 条书签"，体验不佳但数据安全。改变它需要推翻两处既有测试契约，属产品决策，已在源码补注释说明，留待确认。
9. **E2E 存在一处未定位的不稳定项**（第五轮如实记录）：本轮 4 次运行中有 1 次失败于**主动学习列表分页**断言（`actual: 4, expected: 5`），随后连续两次运行均通过。该区域与本轮 RSS/undo 改动无交集。残留输出中失败断言带 `generatedMessage: true`（表示未传自定义消息），而脚本内唯一期望 5 的断言（`e2e-extension.mjs:671`）是带自定义消息的，两者矛盾，因此**未能从残留输出可靠定位到具体断言行**，不排除是注入 105 条 UI 状态后有在飞的 `loadActiveLearning()` 落地将其冲掉的测试自身竞态（`actual: 4` 恰等于该测试早前断言的真实反馈条数）。此项未修，如实记录待复现后处理。
10. **E2E 浏览器版本**：本机 chromium 构建运行；标准 CI 环境执行 `npx playwright install` 后可直接跑官方链路。
11. 第五轮改动（含 RSS 累积功能与本报告）见本轮提交；第四轮见 `95316cd`，前三轮见 `b189936`。
