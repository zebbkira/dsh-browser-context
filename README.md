<h1 align="center">引用浏览器</h1>
<p align="center">让 DSH 读你正在看的资料，再一起总结、思考和写作。</p>
<p align="center"><a href="https://github.com/zebbkira/dsh-browser-context/releases/tag/v0.2.0">下载插件</a> · <a href="#安装">安装</a> · <a href="#怎么用">怎么用</a></p>

看到一篇文章、一份企微文档，或者一个 B站视频，想让 DSH 帮你分析，却不想来回复制粘贴？

**引用浏览器让你直接在 DSH 里打开这些资料，把需要的内容加入对话，然后接着提问。** 不只是贴一个链接，也不用把长文全堆在输入框里。

我做这个插件，就是希望阅读资料和使用 DSH 能在同一个窗口里完成：少一些窗口切换，多一些围绕材料本身的讨论。如果你经常用 DSH 学习、调研、整理笔记或写工作方案，可以试试它。

## 你可以拿它做什么

| 你在看什么 | 可以怎样交给 DSH |
| --- | --- |
| 网页文章、公众号文章 | 引用可读取的正文，让 DSH 总结观点、比较材料，或者帮你继续追问 |
| 企微文档 | 选中需要的文字，带进对话，让 DSH 按需求整理思路或起草方案 |
| B站视频 | 引用视频信息和已有字幕，让 DSH 帮你整理内容、提炼重点或做学习笔记 |

**开发分支新增圈画和元素批注：**可以在截图上画框、画圈、画箭头并写备注，也可以点选网页元素后再批注。[查看用法](https://github.com/zebbkira/dsh-browser-context/blob/feat/page-annotations/docs/annotations.md)。还可在 DSH 的 HTML 文件上右键，选择「在引用浏览器中打开」，继续圈选和批注。[本地 HTML 用法与限制](https://github.com/zebbkira/dsh-browser-context/blob/feat/page-annotations/docs/local-html.md)。这些功能尚未包含在下面的 v0.2.0 安装包中。

只需要一小段时，可以只引用选中的文字；想保留页面画面时，可以截图。遇到不方便读取的页面，也可以自己复制文字，再通过「粘贴选区」补充。

资料会以一条可展开的引用出现在输入框里，保留来源，方便你检查。**你写好问题并点击发送后，DSH 才会收到；插件不会替你发送。**

## 安装

当前提供 v0.2.0 预发布版，支持 **DSH 桌面版**，已在 **0.2.2-rc.1** 上验证。安装后不需要填写额外配置。

### 让 Agent 帮你装

如果不想处理安装命令，直接把下面这句话发给 DSH 中能使用本机终端的 Agent：

> 请帮我安装「引用浏览器」插件：https://github.com/zebbkira/dsh-browser-context 。先阅读仓库里的安装说明，使用现成的安装包，安装到我正在使用的 DSH 中。装好后告诉我怎么重启、从哪里打开，不要直接替我关闭 DSH。

### 自己安装

在 [下载页](https://github.com/zebbkira/dsh-browser-context/releases/tag/v0.2.0) 选择 **dsh-browser-context-0.2.0.tgz**，这是现成的插件包，不需要下载源码或自己编译。

<details>
<summary>展开手动安装步骤</summary>

在终端进入安装包所在的目录，执行：

```sh
dsh plugin --profile desktop add ./dsh-browser-context-0.2.0.tgz
```

上面使用常见的桌面环境 `desktop`。如果你使用其他 DSH profile，或找不到 `dsh` 命令，请看 [详细安装说明](https://github.com/zebbkira/dsh-browser-context/blob/main/docs/install.md)，也可以让 Agent 按这份说明安装。

</details>

**装好后，先保存当前内容，再从系统托盘退出 DSH，重新打开。只刷新页面不够。**

## 怎么用

1. 在 DSH **右侧栏的新建页面菜单**里，选择 **「引用浏览器」**。
2. 输入资料的网址，等页面打开。需要登录的网站，就在这里正常登录。
3. 点击地址栏旁的 **「引用」**：文章选「文章正文」；企微先选中文字，再选「企微选区文字」；B站选「视频信息与字幕」。
4. 在对话输入框里检查引用，写下你的问题，然后发送。

比如，引用文章后，你可以直接问：

> 这篇文章主要在说什么？帮我梳理它的观点，并指出哪些结论值得进一步核实。

引用菜单是这样的：

![引用菜单与入稿成功提示](docs/preview/reference-menu.png)

<details>
<summary>看看文章引用后的样子</summary>

![展开后的文章引用内容示例](docs/preview/reference-content.png)

</details>

## 使用前知道这几件事

- **企微目前读取的是你选中的文字**，不是自动提取整份文档，也不能编辑文档；没有复制权限时不会绕过限制。
- **B站需要有可访问的字幕**。没有读到字幕时会告诉你，不会拿简介冒充字幕，也不会自动下载音频转写。
- 抓不到正文时，可以试试选区、手动粘贴或截图。引用浏览器和系统浏览器的登录状态不一定相同。
- 发送前请检查资料中的隐私信息。引用只是折叠显示，实际文字仍会发送给模型，并照常计算用量。

遇到问题可以到 [Issues](https://github.com/zebbkira/dsh-browser-context/issues) 留言，说明你在做什么、出现了什么提示；不要上传登录信息或私人文档全文。

## 想了解它是怎么做的

插件在 DSH 内打开网页，再把读取到的内容交给 DSH 已有的引用和图片附件功能。普通使用不需要关心内部实现；开发者可查看 [项目架构与开发说明](https://github.com/zebbkira/dsh-browser-context/blob/main/docs/architecture.md)。

---

社区项目，非 DeepSeek 官方产品。[MIT 许可证](LICENSE) · [第三方组件说明](NOTICE)
