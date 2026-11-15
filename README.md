<h1 align="center">dsh-browser-context</h1>
<p align="center">把网页选区、文章、视频信息与可访问字幕或视口截图显式加入当前 DSH 草稿；保留原草稿，不自动发送</p>

![引用菜单与入稿成功提示](docs/preview/reference-menu.png)

![展开后的文章引用内容示例](docs/preview/reference-content.png)

## 使用

在桌面版 DSH 右侧栏的新增页面菜单选择「引用浏览器」，输入网址后在地址栏旁打开「引用」。这是本插件自己的浏览器页面，原版「浏览器」保持不变。文字以宿主原生紧凑 quote 图标插入当前会话输入框；点击图标检查完整内容，再自行决定是否发送。截图使用原生图片附件和同样的来源 quote。插件只在显式操作时从自己拥有的原生网页读取选区、正文或截图；不读取剪贴板、cookie、凭据存储或登录对象，不自动发送，不修改文档内容。普通 Web 版没有所需桌面桥接，页面会明确提示不可用。

若选区返回 empty-selection，同一菜单会打开普通 textarea；也可直接选择「粘贴选区」。请在企微等网页中自行复制，再亲自粘贴到此处，点击「添加到草稿」才会入稿。插件不调用 navigator.clipboard.read/readText，不监听全局 paste，不发送 Ctrl+C，也不读取其他剪贴板格式。输入内容保留至成功添加或显式丢弃；关闭菜单不丢失文字。页面上下文变化会禁用旧输入的添加按钮，须先自行保存文字，再丢弃并重新打开；会话切换不会把文字添加到其他会话。

| 能力 | 行为 |
| --- | --- |
| 网页选区 | 追加 UTF-8 文字、标题、已脱敏 URL、ISO 时间与外部不可信资料标记 |
| 粘贴选区 | 用户输入以 pasted-selection 入稿；contextUrl/contextTitle 仅说明打开输入时的页面上下文，sourceVerified:false 不证明文字来自该页 |
| 文章正文 | 内置 Defuddle（Obsidian Web Clipper 使用的正文提取库）提取普通网页 Markdown；不保证自绘云文档全文 |
| 企微选区（实验） | 针对已核实的 Melo 接口读取现有选区；先检查复制权限，不自动选中、复制或编辑；用户已确认当前实页读取可用 |
| 企微正文（实验） | 标准编辑器仅返回已加载快照；Canvas 整份正文自动读取尚未完成，失败时提供受限诊断 |
| B站视频信息与字幕 | 引用标题、UP 主、简介及已有标准字幕或站点可访问字幕；缺字幕分别提示原因，不分析音画、不自动转写、不保证字幕完整 |
| 网页截图 | 原生 PNG 图片附件进入当前会话草稿，同时追加来源；不是 URL 占位符 |
| 失败恢复 | 保留可选择复制的文字或图片预览，必须点击「添加保留内容」才会再次入稿，不重新捕获 |
| 安全并发 | 使用会话代际、组件取消与 draftRev CAS，后来的修改不被旧回调覆盖 |
| Skills / MCP / Tools | 无；本插件不向模型增加工具或后台采集 |

正文完整保存在宿主原生 quote 节点和语义草稿中，不是仅存在本插件内存的短标题映射，也不是 CSS 隐藏的全文。发送时宿主使用自己的 `formatQuoteText` 展开完整 Markdown 引用，再通过普通 `user/message` 写入会话日志；模型获得完整正文和不可信来源标记，记录可重建模型输入。视觉折叠不会减少正文 token。插入发生在操作开始时保留的选区末端，不替换用户选中的原草稿；等待期间编辑草稿或移动插入位置会拒绝旧操作并保留捕获结果。

紧凑引用要求宿主公开 `InputActions.insertQuote`、`captureInsertion` 以及共享 `formatQuoteText`；这些接口已从安装的 Desktop 0.2.2-rc.1 实现核实。插件逐项检测实际能力，缺少接口时明确提示更新桌面版，不回退为长正文，不自行实现 quote 节点，也不修改 Conversation 或 Session schema。

## 安装（预构建包）

这是一个包含浏览器、读取器和引用 UI 的独立 npm bundle，不需要修改核心 Browser、Conversation、侧栏插件或安装第二个企微插件。需要 DSH Desktop 的 Browser bridge protocol 1、原生 quote 与附件接口；当前实测宿主为 Desktop 0.2.2-rc.1，不保证所有旧版或未来预稳定版本兼容。其他桌面版本仍需单独验真；企微网站的接口版本也独立于 DSH 版本，发生变化时会明确拒绝不匹配的读取入口。

在 [v0.2.0 预发布 Release](https://github.com/zebbkira/dsh-browser-context/releases/tag/v0.2.0) 下载 dsh-browser-context-0.2.0.tgz，可在宿主插件管理器安装本地包。已配置 dsh CLI 时，也可直接执行：

```sh
dsh plugin --profile desktop add https://github.com/zebbkira/dsh-browser-context/releases/download/v0.2.0/dsh-browser-context-0.2.0.tgz
```

若下载到了本地，可改用 `dsh plugin --profile desktop add ./dsh-browser-context-0.2.0.tgz`。安装 bundle 后保存草稿，从系统托盘彻底退出并重新启动 DSH；只刷新网页不会重新载入宿主模块。不要另起替代服务器。包入口和客户端使用随包构建产物，无安装脚本；运行时 Host 依赖和网页提取库已内联，运行不需要源码 checkout、源码编译或另装 Defuddle。开发目录挂载与独立包的载荷验证、实页确认属于不同证据，范围见[验证记录](docs/validation-2026-11-14-standalone.md)。

## 配置

`cordis.patch.yml` 提供显式部署值；可在用户层覆盖，Host Config 使用正数 natural schema 和 volatile 字段供宿主插件配置 UI 编辑。Client Modules 不向 client apply 传递 Host config；客户端通过注入的 `configForms.get('dsh-browser-context')` 读取宿主提供的配置快照，`hooks.config` 由框架绑定为 `useConfig`，用于响应式可用状态。配置尚未 ready、字段缺失或不是正安全整数时，引用按钮禁用并说明原因，不使用隐含默认值。

每次显式捕获前读取并验证一次 form snapshot，复制该操作的两个预算；配置变化不会重写正在捕获操作的提交预算。失败后点击「添加保留内容」是新操作，明确采用当时的当前配置重新检查既有内容，不重新捕获页面。

| 字段 | 随包部署值 | 校验与含义 |
| --- | --- | --- |
| maxTextBytes | 65536 | 必须为正安全整数；完整入稿文字含来源、引用标记、缩进与换行的 UTF-8 字节上限 |
| maxImageBytes | 10485760 | 必须为正安全整数；原生 capture 的元数据与 PNG 总预算，同时检查最终图片原始字节 |
| subtitleRequestTimeoutMs | 15000 | 字幕请求总超时毫秒数；宿主 schema 显式默认，可覆盖，范围 1 至 2147483647 |

原生 capture 的 selection/article/document/video 使用 maxTextBytes 作为 maxBytes 预算，还包含其 JSON 元数据；插件对选区、文章、已加载文档快照和手动粘贴均在完整来源序列化后再次检查文字预算，包含宿主 `formatQuoteText` 的完整展开结果及原生插入的尾部分隔空格，超限不截断、不发送。粘贴期间编辑草稿会使最初 draftRev CAS 失败并保留内容，点击「添加保留内容」才会明确采用当前草稿修订重试。

对 HTTPS doc.weixin.qq.com/doc/ 页面，菜单改为「企微正文（已加载部分）」，使用包内独立 document reader，而非通用文章提取器。成功结果固定标记 coverage:loaded，并在模型可见引用中说明未验证完整、未包含图片和附件。不能读取时返回 no-document，不回退为整页工具栏文字；当前实际 Canvas 页面仍处于此失败状态。诊断仅含 DOM 计数、固定应用对象的描述符类型、安全脚本文件名，以及最多四层原型上的过滤后成员名称、类型和方法参数个数（pad.editor 最多 192 项，其 root 与 modelWrapperMgr 各最多 64 项）；不返回运行时字段值，不调用 getter 或未知方法。为确认范围参数格式，诊断额外列出十个固定读取方法或 getter 的静态定义；每项最多 2048 UTF-8 字节，超限仅标记 oversized，不截断、不执行源码。DOM 容器不再列入模型成员清单。受预算限制的诊断不自动发送或持久化。URL/title 仅作来源上下文，不提高可信级别。

企微 Canvas 选区读取需要先点击文档正文，手动选择一段文字（或自行 Ctrl+A），再打开「引用 → 企微选区文字」。该动作调用已核实版本的 isCopyable、selection、getIndexFromRange 和 getRefText；不调用 getCopyContent、writeHtmlToClipboard、任何写操作或系统剪贴板。复制不获准时直接拒绝，不修改权限。接口源码与已核实版本不符时拒绝调用；这是实验性版本限制，不保证所有企微页面兼容。已识别的 Melo 选区包装器通过源码已核实的 gcpRanges 只读 getter 解包，表格单元格范围优先；不调用重置、移动选区或更新缓存的方法。读取器接受现有的单个范围或最多 64 个原始范围组成的数组；全部原范围先由已核实的 SDK 索引接口验证，通过后才读取文字；不以 begin/end 是否为普通数据属性判断资格，从而允许 SDK 的 getter 或 Proxy 范围。多范围文字按原顺序换行拼接，不改动范围对象。其他选区包装格式不猜测转换；错误详情仅保留受限的 selectionInfo 成员类型和静态方法定义，不返回成员值或正文。返回结果按 selection 入稿，不能因使用 Ctrl+A 就推断全文完整。选区为空时只提示重新选择，不自动切换为粘贴输入。

普通文章对 www.yzwb.net/yzwb.net 的 news HTML 页面使用 #con.art_txt，对 mp.weixin.qq.com 的 /s 文章使用 #js_content，均交由 Defuddle 清理和转 Markdown。正文根必须已加载且可见；只向解析器提供该根的副本，移除隐藏后代与脚本，防止库重试时扩大到侧栏或隐藏的备用内容。不会强制显示正文、解析页面脚本中的文章字符串或绕过验证/登录。未知站点仍保守拒绝 html/body 候选，不能据这两个模板的修复推断所有网页都能提取；不匹配时可用选区、手动粘贴或截图。

在 B站视频页，第二项菜单为「视频信息与字幕」。插件先读取当前视频可见信息和已加载的标准字幕轨道；未取得轨道时，先以当前网址向站点查询公开视频信息并核对分 P，再查询字幕元数据并读取首个合法站点轨道的字幕 JSON，最多三次只读请求、不自动重试；每次字幕响应也受 maxTextBytes 字节预算约束，超限整次拒绝，不截取字幕。请求来自当前网页会话，浏览器按站点规则自动携带会话 Cookie；插件不读取 Cookie 值、令牌或凭据存储。字幕 CDN 仅允许 HTTPS 的 hdslb.com 子域及字幕资源路径；除带 .json 的已知路径外，也接受 aisubtitle.hdslb.com 的 /bfs/ai_subtitle/prod/ 十六进制资源标识，响应仍须通过完整 UTF-8 JSON 和字幕条目校验。不跟随重定向，不下载音视频或执行转写。签名字幕地址不进入草稿、模型、错误详情或插件持久化。

视频信息可独立成功。登录要求、风控、未提供字幕、网络失败和超时会在当前菜单明确提示，引用中也标记未取得字幕；不会将简介称为视频口播。请求失败时，现有错误详情仅显示失败阶段、类别、HTTP 状态和数字 API 状态码，不显示地址、响应原文或凭据；这些诊断只用于界面，不进入引用正文或模型输入。成功字幕标注轨道语言、当前已取得条目与未核实完整性，不承诺所有 B站视频或后续接口版本兼容。客户端只使用配置快照中的值，不在本地补 schema 默认值。升级已有开发挂载或覆盖配置时，必须显式添加 subtitleRequestTimeoutMs（例如 15000）；缺失时视频请求会说明具体字段且不发起字幕请求。配置更新后需由宿主重新载入；其他引用操作不因缺少这个字段而拒绝。

## 附件与失败语义

客户端在 apply 世界通过 `ctx.conversation.createDrafts(sessionId, [File])` 创建 `image/png` 原生草稿，再通过该会话 `inputActions.addAttachments(ids)` 加入。图片遵循原生图片发送流程：先有浏览器内 File 与预览，用户发送时才序列化图片字节，不走 generic file 的 Worker upload。来源调用原生 `insertQuote(text)` 插入，保留已有文字、引用芯片和 quote；`captureInsertion()` 提供真实编辑器坐标，不拿展开后的 `InputState.draft.length` 冒充芯片位置。

附件入稿与引用检查在同一个同步调用内完成：紧接 `insertQuote` 前读取 `captureInsertion()`，同步比对冻结的 `draftRev` 与选区末端，中间没有 await；原生 quote 只在选区末端零宽插入。附件拒绝则不插入来源；原生 quote 返回 false、位置或修订不符时，移除本次新增的附件 id 并 `releaseDraftAttachments`。没有 `setDraft`、`submit` 或自动重试。原生操作意外抛错时显示「结果无法确认」，让用户先检查草稿，不能误称回滚成功或盲目重加。引用成功后的草稿持久化遵循原生输入框逻辑。当前显式失败可展开「错误详情」并手动选择复制，只展示 code 与 cause 的 name/message，不包含 stack；URL 认证参数会脱敏，完整详情受该操作 maxTextBytes 预算约束，不自动进入模型、日志或持久化。新操作或成功会清除详情，详情不会放宽引用或恢复预算。

捕获期间切换会话、卸载组件或销毁插件会使旧回调不能入稿；导航与 tab 关闭由 Browser capture owner 拒绝。编辑草稿会令 draftRev CAS 失败并保留捕获结果。恢复数据与手动输入仅保存在每会话内存 store（最后一份失败引用与一份粘贴输入），不写磁盘；丢弃、会话卸载或插件停用后不保证恢复，捕获尚未完成即取消的结果直接丢弃。

URL 会移除用户名/密码以及 access_token、refresh_token、id_token、token、API key、secret、password、authorization、auth、code、scode、state 等认证参数；含认证参数的 fragment 整段移除，普通检索参数和章节 anchor 保留。用户主动选择的文字或截图仍可能包含敏感资料，发送前必须自行检查；插件不会对页面内容做不可核实的脱敏承诺。

## 本地开发与验证

普通安装用户使用仓库内或 Release 中的预构建产物，不需要构建工具。源码开发时，将本仓库检出到已准备好 SDK、声明和开发依赖的 DSH 源码树下的 `dsh-browser-context/` 子目录，并在 DSH 源码树根执行以下命令。构建脚本复用该源码树的官方 `clientBundle` / tsdown、TypeScript、Vitest 与 React；不支持在任意独立目录仅运行 `npm install` 后直接构建，也不把这些开发依赖带入安装包。

```sh
node dsh-browser-context/scripts/build.mjs
node dsh-browser-context/scripts/test.mjs
node dsh-browser-context/scripts/check.mjs
```

`check` 只对本包执行 noEmit，不构建核心依赖；核心包当前的 declaration 产物须由集成负责人准备。测试包含真实 Defuddle、固定读取脚本的 VM/JSDOM 执行和真实 React 组件；原生 guest 生命周期及附件/quote owner 使用测试替身，不访问网络、真实企微或真实用户草稿。菜单定位、Escape/外部点击、浅色/深色和 Windows 桌面截图入稿由主集成流程验证，不把 mock 测试当作桌面端验真。

原版宿主接口、独立包边界、201 项定向测试及用户对企微选区的实页确认，见[验证记录](docs/validation-2026-11-14-standalone.md)。这些证据不代表整个源码 checkout 的聚合检查全部通过。

## 插件管理

已装插件推荐用 plugin-registry 的薄控制台管理 profile 插件安装态、启停与配置；本包不会自动安装该管理器，也不会操作 profile。由用户提供真实管理器包路径后再按其文档安装。

## Model Experience

本插件不自动改变模型输入、系统提示、工具目录、token 或 KV-cache。只有用户最终发送草稿时，外部引用文字与原生图片才进入会话日志和模型输入；文字消耗文本 token，图片成本由当前模型及原生图片流程决定。

## Known Limitations and Deferred Work

不支持 Web 版跨域捕获、全页长截图、自绘编辑器全文提取或截图 OCR。企微 Canvas 编辑器的整篇正文自动提取尚未实现；选区适配仅接受本次核实的 Melo 接口版本，VM 测试不能替代真实文档读取验真。选区不可读时可由用户主动复制并粘贴，或选择截图；插件不接管 OS 剪贴板。失败预览与粘贴输入不是持久备份。手动输入和页面导航产生的最后 URL 只在当前插件生命周期内保留，插件或应用重载后仅能恢复初始导航参数中的 URL；不承诺跨应用重启保留登录状态。原生 guest 生命周期和代际校验由本包维护，不依赖改造版核心 Browser 的 capture 接口。用户已确认当前实页的选区读取可用；这不等于验证所有企微文档、所有表格/修订模式或整份正文。干净 profile 安装和后续版本兼容仍需分别验证。
