# 详细安装说明

这份说明供手动安装的用户和代为安装的 Agent 使用。只想开始使用，请看 [README](../README.md)。插件带有现成安装包，正常安装无需编译源码或填写额外配置。

## 安装前

- 当前支持 DSH 桌面版，已验证宿主版本为 0.2.2-rc.1；普通 Web 版不具备所需桌面浏览器能力。
- 确认实际使用的 DSH profile。下面命令以常见的 `desktop` 为例；不要为了安装而另建一个用户并未使用的 profile。
- 若已有同名源码开发挂载，先确认如何停用或移除旧挂载，再切换到发行包，避免重复加载。不要直接覆盖用户的整个配置文件。

## 安装方式

### 直接从发布地址安装

在能使用 `dsh` 命令的终端执行：

```sh
dsh plugin --profile desktop add https://github.com/zebbkira/dsh-browser-context/releases/download/v0.3.0/dsh-browser-context-0.3.0.tgz
```

如果实际 profile 不是 `desktop`，替换该名称。

### 下载后安装

打开 [v0.3.0 发布页](https://github.com/zebbkira/dsh-browser-context/releases/tag/v0.3.0)，下载 `dsh-browser-context-0.3.0.tgz`。`Source code (zip)` 和 `Source code (tar.gz)` 是 GitHub 自动生成的源码归档，不是这里推荐的插件包。

可同时下载 `SHA256SUMS` 核对安装包的 SHA-256。然后在终端进入下载目录，执行：

```sh
dsh plugin --profile desktop add ./dsh-browser-context-0.3.0.tgz
```

如果所用插件管理器支持导入本地包，也可选择这个 `.tgz` 文件安装。

找不到 `dsh` 命令时，应定位当前 DSH 安装提供的 CLI 入口；不同系统和安装位置可能不同。不要为此再安装一套 DSH，也不需要克隆本仓库或为本插件安装源码开发依赖。

## 安装完成后

1. 确认安装命令成功，包版本为 0.3.0，且已登记为目标 profile 的 bundle。下载成功不等于当前运行中的桌面已加载插件。
2. 保存正在编辑的内容，从系统托盘彻底退出 DSH，再重新打开。只关闭窗口可能留在后台，只刷新页面不能代替宿主重启。
3. 在 DSH 右侧栏的新建页面菜单中选择「引用浏览器」，打开资料网址，再点击地址栏旁的「引用」。原有的「浏览器」不是本插件入口。
4. 确认内容出现在当前对话输入框，检查后自行发送。需要网页登录时，由用户在引用浏览器里按站点正常登录。

## 给安装 Agent 的提醒

使用用户实际运行的 DSH 与 profile，通过标准插件安装流程安装上述预构建包。不要修改 DSH 核心、从源码编译、启动替代服务，或把安装到隔离测试 profile 说成已安装到用户当前环境。

如发现已有开发挂载，先解释替换计划并请求用户确认。不要自动关闭 DSH、强杀进程、清空原配置、修改登录状态，或索取密码、Token、Cookie 值。安装完成后报告实际结果，并指导用户自行保存与重启。

当前发布在 GitHub Release，未发布到 npm；不要凭仓库名猜测 npm 包或使用不存在的 `@latest` 安装地址。

## 更新与问题反馈

以后更新时使用对应 Release 的安装包，按同样流程安装并重新启动 DSH。v0.3.0 是正式稳定版；本说明使用固定版本下载链接，便于确认实际安装内容。

此前的 v0.2.0 预发布附件和校验值保持不变。安装异常请到 [Issues](https://github.com/zebbkira/dsh-browser-context/issues) 提供 DSH 版本、安装步骤和不含凭据的错误提示。
