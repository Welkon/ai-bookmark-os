# AI Bookmark OS 全量审查与修复报告

- 报告日期：2026-08-22
- 审查范围：全仓库（`src/core`、`src/sidepanel`、`src/bookmark-nav`、`src/timeline`、`scripts`、构建与清单配置）
- 审查方法：三路并行静态审计（核心逻辑 / React UI / 原生时间线模块）→ 对每条发现逐条对照当前源码实证核验（剔除审计代理误报的过期项）→ 分组修复 → 每组修复配回归测试 → 全量门禁验证
- 验证门禁：`npm test`（56 个测试文件）、`npm run typecheck`、`npm run build`、`npm run preview:check`、`node scripts/audit-project.mjs`、Playwright 真实浏览器 E2E（`scripts/e2e-extension.mjs`，经本机 chromium 构建加载重建后的 `dist/`）

> 三轮修复合计：**第一轮 24 项**（功能闭环 / P1 交互 / 存储安全），**第二轮 14 项**（遗留项全部处置：12 项修复 + 2 项评估后判定不改），**第三轮 4 项**（用户反馈的主动学习链路：手工移动不自动学习 + “采用首选”报错滞留 + 批量程序性移动学习隔离）。所有修改均在工作区未提交，可按组拆分提交。

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

## 三、配置 / 接口 / 依赖变更

- manifest（含打包脚本）：`+unlimitedStorage`；无其他权限/依赖变更，无 npm 依赖增删，无 storage schema 变更（新增 UI 全部复用既有键与后台单写者消息）。
- popup 导入消息补传 `folderPaths`/`duplicateStrategy`（后端既有字段，两入口对齐）。

## 四、测试与验证证据（最终状态）

| 命令 | 结果 |
|---|---|
| `npm test` | **All 56 test files passed**（基线 51 → 56：+6 节新回归、+主动学习自动学习链路；含第三轮更新的推荐审核过期契约） |
| `npm run typecheck` | 通过（`typeof zh` 约束下 9 语言字典全量一致） |
| `npm run build` + `npm run preview:check` | 构建成功，`VERIFY PASS` |
| `node scripts/audit-project.mjs` | `PROJECT AUDIT PASS` |
| E2E（`scripts/e2e-extension.mjs`，加载重建后的 `dist/`） | **Extension E2E passed**（真实浏览器：SW 启动、合成书签、时间线、设置 AI 连接 mock、RSS、推荐审核、键盘焦点、溢出检查） |

说明：Playwright 官方 chromium-1228 下载在本网络停滞，E2E 经 `executablePath` 使用本机已有的 chromium-1208 构建运行（等效，Chrome 140+，高于 manifest 要求的 114）。

## 五、残余风险与后续建议

1. **跨上下文写竞争（收敛但未根除）**：smart-tagger/ai-logger 现在同上下文内严格串行；popup/SW/独立窗口多上下文同时写同一 key 仍有最后写者覆盖窗口。根治需迁移到后台 `mutateStorageResource` 单写者（建议后续单独一轮做，配合消息协议改造）。
2. **词法感知修复的边界**：模型输出含未闭合双引号时，字符串状态跟踪可能错位，导致修复不生效——此时行为退回“解析失败→JSON 修复请求/重连”，与修复前一致，无数据风险。
3. **公共后缀表为人工维护**：未覆盖的二级后缀（如小众国别后缀）仍按后两段分组，仅影响并发度不影响正确性。
4. **E2E 浏览器版本**：本机 chromium-1208 运行；标准 CI 环境执行 `npx playwright install` 后可直接跑官方链路。
5. 全部修改未提交；建议按“存储安全 / 功能闭环 / UI 与 i18n / 解析与并发 / 性能 / 测试”分组提交，每组均已有对应回归测试护航。
