# 血染钟楼 · AI 说书人

几个朋友线下玩《血染钟楼》的辅助程序：**安卓平板运行服务器和公共屏，每人用自己的手机看身份、收情报和投票**。目前支持《暗流涌动》22 个角色、5–15 名玩家、一个房间。

当前版本 **0.3.0**。这是朋友之间使用、持续维护的个人项目，仓库为私密状态。

## 下载与阅读

平板主人优先下载 [最新发布版本](https://github.com/wyswang3/blood-clocktower-storyteller/releases/latest) 中的 `blood-clocktower-android-ai.zip`，解压后打开 **先读我.html**。私密仓库及附件需要登录有访问权限的 GitHub 账号。

| 读者 | 文档 |
|---|---|
| 平板主人 | [从安装到全员测试](docs/01_平板主人安装与测试.md) |
| 所有玩家 | [加入房间、夜间行动与提名投票](docs/02_玩家使用说明.md) |
| Agent / 技术人员 | [当前功能、架构、验证证据和维护进度](docs/03_技术手册与进度.md) |
| 规则维护者 | [22 角色、夜序与胜负的规则核对](docs/04_暗流涌动规则核对.md) |
| AI 配置者 | [DeepSeek 配置](DeepSeek配置.md) |

## 安卓平板快速开始

先按 [Termux 官方安装说明](https://github.com/termux/termux-app#installation) 安装 Termux，然后执行：

```sh
pkg update
pkg install nodejs-lts unzip
termux-setup-storage
unzip ~/storage/downloads/blood-clocktower-android-ai.zip -d ~/
cd ~/blood-clocktower
sh start-android.sh
```

保持 Termux 运行，用平板浏览器打开终端显示的“本机（平板）”地址。房主 PIN 以这次启动显示的为准。程序没有第三方 npm 依赖，不需要安装额外的游戏 APK。

各手机可以共用局域网，也可以各用流量或不同 Wi-Fi。后一种方式需平板持续联网，并额外安装隧道：

```sh
pkg install cloudflared
sh start-android.sh --tunnel
```

把大厅生成的 `/player` 公网加入链接发给朋友；平板仍用本机地址。隧道重启后链接会改变。安装、后台设置和七手机验收，见平板指南。

## 当前功能与边界

- 随机或指定板子发牌；酒鬼只拿未在场镇民牌。
- 私密夜间行动与情报；投毒、保护、死亡、传位、红唇接管、镇长转移按引擎结算。
- 每人每天最多提名一次、被提名一次；本桌额外禁止自提名。死者可被提名，不能发起提名。
- 手机投票、幽灵票、处决门槛、并列不处决、圣徒与镇长结算。
- 标准三人残局继续；全桌同意后，平板可手动提前宣布胜方。
- 断线重连、私密笔记和身份板、存档及结束后复盘。
- 可选 DeepSeek：选择引擎生成的合法夜间信息候选，超时或断线自动回退。

夜序采用 2026-10-22 核对的 TPI 官方公开通用流程表，筛选暗流涌动角色；与旧实体表的间谍、掘墓人位置不同，详见核对文档。公共屏不会在黎明前显示当夜死亡。

**AI 默认关闭。** 不配置密钥也能玩自动情报模式。完整 AI 主持、规则问答、语音及聊天室仍在规划；镇长转移、传位等实际效果目前由引擎自动裁量，模型不能直接改身份、死亡或票数。

## 电脑开发与验证

运行服务需要 Node.js 18+；整套测试建议 Node.js 22+，本轮使用 24.20.0。

```sh
node server.js
npm test
```

测试包含引擎、专项规则、AI 模拟接口、页面渲染、入口、隧道替身、走查、多人模拟和真实本地 HTTP/WebSocket 联机。不会访问真实 DeepSeek。安卓设备与运营商公网链路仍需现场验收。

维护文档后执行 `node tools/build-docs.js`。Windows PowerShell 7.2+ 中运行 `./tools/package-android.ps1` 生成运行包并逐文件核验；加 `-IncludeTests -OutputName blood-clocktower-source-v0.3.0.zip` 生成源码包。

## 更新与私密文件

升级应在一局结束、停止服务后进行。备份旧目录、`ai.local.json` 和 `room.json`，保留自己的配置与存档。0.3.0 存档格式为 v2，可读旧存档，但不能撤回旧版本已经发出的错误信息，正式游戏请另开新局。

真实密钥、房间存档、登录凭据、日志和历史备份不提交、不打包。示例配置密钥为空，不要填入后提交。官方规则与角色归原作者及 The Pandemonium Institute 所有，规则来源见核对文档。
