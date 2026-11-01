# Fast Note Sync 同步测试版

这是基于 [HaierKeys / Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync) `2.4.0` 的独立测试分支。原作者为 HaierKeys。本仓库由 OPENSB 维护测试修改，不是原项目的正式版本，也未上架 Obsidian 社区插件目录。

## 安卓通过 BRAT 安装

1. 在 Obsidian 中切换到独立的「同步测试」库。
2. 从社区插件市场安装并启用 **BRAT**。
3. 在 BRAT 中添加 `OPENSB/obsidian-fast-note-sync-safety`。
4. 选择 **2.4.0-safety.2**，安装并启用 **Fast Note Sync 测试版**。
5. 在自己的 Fast Note Sync 服务端为测试库单独授权，再在测试版插件中连接。

插件会写入当前库的 `.obsidian/plugins/fast-note-sync/`。无需在安卓文件管理器中操作隐藏文件夹。

**仅用于独立测试库。** 本分支保留原插件 ID `fast-note-sync`，所以会替换同一库中已安装的原版。不要在日记库安装，不要把测试库连接到日记的远端库。本仓库不包含服务器地址、令牌、日记或个人配置。插件自身的 `data.json` 不参与配置同步，手机需要单独授权。

后续测试版通过 BRAT 更新。本分支关闭内置的插件更新提示、覆盖安装和服务端升级入口，避免覆盖同步修复或修改共享服务器。BRAT 需要能访问 GitHub；请先固定测试版本。

## 本分支修改

基于上游提交 `f2b15c09d34e621d2d97ad526fdee03460bac151`：

- 将 Obsidian 配置文件从普通附件同步通道中隔离。
- 为配置删除增加持久化确认基线和冲突处理；保留未确认的本地修改。
- 等待鉴权和配置连接准备完成后再开始同步。
- 修复配置增量比较、未完成轮次计数与成功时间记录。
- 固定排除自身的连接凭据与本地索引文件。
- 删除插件内的「赞助与支持」界面、支付图片、支持名单、相关请求和无用样式。
- 关闭测试版内置的插件更新和服务端升级入口，程序更新交给 BRAT。

## 验证范围

此前 `2.4.0-safety.1` 已在两个隔离的桌面 Obsidian 库中验证笔记、附件和配置同步。`2.4.0-safety.2` 在此基础上移除赞助模块并增加 BRAT 更新保护。

安卓真机的安装和双向同步仍待测试。不将桌面测试结果等同于安卓验证结果。

上游 `test:auth` 存在缺失文件引用，`test:mirror` 存在断言失败。这两项已在未修改的上游 `2.4.0` 复现。本分支不把它们标记为通过。

## 构建与检查

使用 Node.js 24：

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm run lint
corepack pnpm run test:config-safety
corepack pnpm run test:vault-name
corepack pnpm run build
corepack pnpm exec sass --no-source-map src/styles.scss styles.css
```

Release 附件中的 `main.js`、`manifest.json`、`styles.css` 可供 BRAT 安装。

## 网络与数据

同步功能需要用户自行部署或选择 Fast Note Sync Service，并在插件内配置连接与授权。笔记、附件与选定的配置会发送到用户配置的服务器。授权令牌保存在当前库的插件本地配置中，不随本仓库或 Release 分发。BRAT 从 GitHub 下载程序。

## 许可证与来源

保留原项目根目录的 **Apache License 2.0**。本分支的修改也按 Apache-2.0 分发。原作者的代码与版权归属继续保留，删除赞助入口不改变原作者署名。

上游项目：https://github.com/haierkeys/obsidian-fast-note-sync

服务端：https://github.com/haierkeys/fast-note-sync-service
