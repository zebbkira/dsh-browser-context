# 插件目录收录准备

## 摘要

本仓库包含一份 [收录条目草稿](../marketplace/zebbkira__dsh-browser-context.yml)，不代表已向 awesome-dsh-plugin 投稿或已被收录。代码、预发布 Release 与目录收录分别维护；发布安装包不会自动创建上游 PR。

本页依据 [awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 整理；真正投稿前须复核当时的规则。

## 目录

- [本仓库的提交条件](#本仓库的提交条件)
- [安装包与链接](#安装包与链接)
- [图标与预览](#图标与预览)
- [投稿前检查](#投稿前检查)

## 本仓库的提交条件

公开仓库为 [zebbkira/dsh-browser-context](https://github.com/zebbkira/dsh-browser-context)。仓库创建于 2026-11-15 14:08:12 UTC，至 2026-11-16 14:08:12 UTC（Asia/Shanghai 22:08:12）才满 1 天；年龄条件满足前不能投稿。这个时间只说明年龄条件，不是自动投稿预约。

投稿前逐项确认：

- 仓库添加 `dsh-plugin` topic，保持公开、可访问且活跃维护。上游无提交次数门槛，但会检查创建满 1 天。
- [包清单](../package.json) 保留 `dsh.bundle.patch`，且 [配置补丁](../cordis.patch.yml) 与实际入口包含在安装包中；单独声明 `dsh.client` 不满足要求。
- 条目使用准确的仓库 URL、名称和 `browser` 分类。英文描述必填、单行并以句号结束；中文描述可选。含冒号加空格的 YAML 描述必须加引号。
- 描述与代码、实际验证范围相符，不使用营销词，不承诺企微编辑、所有视频字幕、自动 ASR 或 Canvas 整份正文提取。具体支持和限制见 [README](../README.md) 与 [发行说明](../RELEASE_NOTES.md)。
- 插件应有真实可用的独立行为，不是占位、纯 README 或仅依赖清单的聚合包。若依赖他人插件，指向原作者仓库或原作者发布的 npm 包，不静默重传他人副本。

当前 `private: true` 不违反这份目录指南；npm 发布不是收录前提。收录仍需人工阅读代码，既不是安全审计，也不是永久席位。

## 安装包与链接

源码仓库携带构建后的 `lib`，不依赖 `prepare` 安装脚本；Git 安装使用这些产物，不能将本插件描述成“无法从源码仓库安装”。开发时重新编译需要 DSH 源码树及其 SDK 目录布局，与安装后运行的要求不同。

预构建 tarball 内联运行时依赖，无运行时 npm 依赖和安装脚本，用户不需要编译。目录指南推荐 npm 或预构建 tarball 以改善安装体验；只有仓库根本无法源码安装时，`tarball` 才是必填。声明 tarball 后，市场优先展示预构建安装地址而非源码构建命令。

本条目预备使用固定地址：

`https://github.com/zebbkira/dsh-browser-context/releases/download/v0.2.0/dsh-browser-context-0.2.0.tgz`

维护者须先完成 v0.2.0 预发布、上传安装包和校验文件，并确认公开下载与校验结果，再将该地址用于任何收录提交。草稿中的地址不是附件已经存在的证明。预发布不使用 `latest/download`；固定 tag 也避免不同版本共用一个漂移地址。

上游要求 tarball 为 GitHub Release 托管的 HTTPS `.tgz`。若日后使用 `latest/download`，资产名必须固定且不带版本；带版本的文件名应配固定 tag。若另行发布 npm 包，其 `repository` 必须回指本仓库；目录自动发现 npm 映射，不能在条目中手写 `npm:`。

官方 `@deepseek-ai/*` 包若作为外部依赖，应放在 `peerDependencies`，并为实际支持的宿主预发布版本声明能匹配其版本元组的显式范围；宽泛范围不等于覆盖所有 prerelease。当前宿主兼容与干净 profile 验证范围见 [验证记录](validation-2026-11-14-standalone.md)，不以依赖声明代替验真。

## 图标与预览

草稿不声明 `icon`，市场回退到仓库所有者头像。日后添加时，只能使用 GitHub 托管的 `png`、`jpg`、`jpeg` 或 `webp` 位图；目录卡片拒绝 SVG 和第三方图床，约 96px 显示，适合方图。

[screenshots.json](../screenshots.json) 在本仓库包清单旁声明一张相对路径预览。上游允许 1–8 张，接受路径数组或带 `screenshots` 字段的对象；相对路径不能以 `/` 开头、不能含 `..` 或跳出插件目录。绝对链接必须是 GitHub 托管的 HTTPS 图片，不使用第三方图床。图片须检查敏感信息；不声明时市场可从 README 抽图。

后续预览更新提交到自家仓库即可，由目录后续构建收集；不要向上游旧的 `data/screenshots.json` 添加新键。

## 投稿前检查

确认发布资产和准入条件后，将草稿作为上游 `data/plugins/zebbkira__dsh-browser-context.yml` 提交。一个 PR 最多新增 3 条，不修改其他插件条目。上游两个 README 由数据生成，通常只提交自己的 YAML；无需手工修改 README 或为投稿运行构建命令。

上游 CI 依次检查条目数、从根包或受支持子包读取 `dsh.bundle`、仓库年龄，以及 lint 和站点构建中的格式、语言、日期与截图等。绿 CI 只是前提；维护者还会检查功能声明、重复条目、实际代码、分类与可疑安装行为。分类偏差可由维护者调整；fork 需有实际增量或更好的维护，不能以先来者身份代替质量判断。

若 PR 标记 `held: author`，在同一分支修复后留一条说明评论，等待人工重评审；标签不会自动摘除，不反复催促或推空提交。每日 06:19 UTC 更新的 “Held pull requests that may have healed” 跟踪 issue 可用于自查。生成 README 冲突或陈旧快照由维护者按指南处理；作者仍须修复自己的 lint、陈旧 fork 等问题。仓库年龄等过期检查会自动重跑，不需要空提交。

目录的 npm 近 30 天下载量和 GitHub Release 全部附件累计下载量是不同统计，不代表安装次数或用户数，不应相加。固定 Release 的版本与宿主声明从对应 tag 的包清单核实；目录不会将安装 URL 自动换成仓库 latest。详细统计规则以 [贡献指南末节](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md#github-release-statistics--github-发行统计) 为准。
