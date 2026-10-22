# DeepSeek 说书人接口配置

## 最简单的启用方式

1. 使用本次更新的 `blood-clocktower-android-ai.zip`，按《安卓平板使用.md》解压和启动。
2. 把项目里的 `ai.config.example.json` 复制一份，命名为 `ai.local.json`，放在 `server.js` 同一目录。
3. 只把 `apiKey` 的空字符串改成你在 DeepSeek 平台申请的密钥，保存。不要把密钥填在手机网页里，也不需要发到聊天中。
4. 重启游戏服务。平板“说书人操作”里会显示“已配置，未启用”，可以先点“测试连接（1 次调用）”，看到成功后再点“启用 AI”。想恢复纯自动情报时点“暂停 AI”。连接测试会调用一次真实服务，但不发送对局数据、不开始游戏。

模板：

```json
{
  "enabled": false,
  "apiKey": "",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "timeoutMs": 12000
}
```

`enabled` 保持 `false` 时，每次启动后由平板手动启用；改成 `true` 可在启动时自动启用。默认模型按照 2026-10-22 查询的 DeepSeek 官方文档设置，可在模型名称改变时修改 `model`，不必改程序。

安卓 Termux 中复制配置可以执行：

```sh
cd ~/blood-clocktower
cp ai.config.example.json ai.local.json
```

随后使用文本编辑器修改这个文件。没有编辑器时可先执行 `pkg install nano`，再用 `nano ai.local.json`。修改后重启原来的启动脚本；想让各手机用自己的网络时仍然加 `--tunnel`。

也支持环境变量 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`AI_TIMEOUT_MS`、`AI_ENABLED`。环境变量覆盖文件；`AI_ENABLED=1` 启用，`0` 关闭。接口地址须为 HTTPS；本机 HTTP 仅供自动测试。

## 这一版做了什么

开启 AI 后，夜间有裁量空间的信息请求会自动调用 DeepSeek。引擎生成一组候选信息卡，模型结合魔典与先前裁量选择候选编号；最终发给玩家的卡片来自引擎，不能由模型随意拼造。没有裁量空间的固定结果直接发送，不调用模型。

酒鬼的假身份只从本局未在场的镇民中选择，不能是其他外来者、爪牙或恶魔。AI 接口没有更改真实身份、假身份或能力生效状态的权限。

模型默认使用非思考、非流式 JSON 输出。单次调用最长 12 秒，早于引擎的 15 秒回退；断网、限流、认证失败、空响应、无效 JSON、未知候选编号或截断响应都会回退为引擎结果，不重新反复请求。暂停、跳过、重开或引擎先回退后，迟到结果会被丢弃。

这次接通的是**夜间私密情报裁量**。公开气氛主持、语音、规则问答、动态身份后置，以及所有特殊能力的完整 AI 决策尚未接入。候选范围沿用当前引擎已实现的规则和登记策略，不代表已经覆盖所有官方裁量组合。

## 连接与隐私

平板统一访问 DeepSeek，各手机不需要分别配置密钥。DeepSeek 收到的私密裁量上下文包括当前魔典、情报请求和裁量记录，不含座位登录 token 或房主 PIN；公开网页只收到是否配置、是否启用和工作状态。

`ai.local.json` 只保存在平板服务端，已加入忽略清单，不通过网页提供，也不放进交付压缩包。私密裁量理由记录在含完整对局状态的 `room.json` 中，不进入公共日志或其他玩家视图。后续公开主持应使用独立、只含公开事实的上下文。

使用真实密钥启用后，实际请求会按服务商规则计费；本次开发验证全部使用模拟接口，尚未进行真实账户联调。公网房间的可达性和 DeepSeek API 的可达性是两件事，需要在平板网络上分别确认。

## 故障提示

- “请先在平板配置密钥”：检查 `ai.local.json` 的位置、JSON 格式和 `apiKey`，修改后重启。
- “本次调用失败，已自动发情报”：对局可以继续；检查余额、模型名、平板网络与接口地址。程序不会把服务商错误正文或密钥展示在公共屏。
- 想暂时离线玩：点“暂停 AI”，使用共同局域网继续；跨网络隧道本身仍需要互联网。

依据：[DeepSeek 官方首次调用说明](https://api-docs.deepseek.com/zh-cn/)、[Chat Completions 接口](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)。
