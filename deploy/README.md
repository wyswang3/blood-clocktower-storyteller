# 部署到公网服务器（VPS）

目标：平板和手机不在同一个网络也能玩。整套 app 跑在 VPS 上，大家用 HTTPS 域名打开。

## 1. 准备

- 一台 Linux VPS（1 核 1G 就够），Ubuntu 22.04 为例。
- 一个域名，A 记录指向 VPS 的公网 IP。
- 安装 Node 18+、Caddy。

```bash
# Node（若系统自带版本太老）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs caddy

# 项目
sudo mkdir -p /opt/blood-clocktower
sudo cp -r ./* /opt/blood-clocktower/
```

## 2. 配置

- 编辑 `deploy/blood-clocktower.service`：把 `PUBLIC_URL` 和 `HOST_PIN` 换成你的。
- 编辑 `deploy/Caddyfile`：把 `game.example.com` 换成你的域名。

```bash
sudo cp deploy/blood-clocktower.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blood-clocktower
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 3. 防火墙

```bash
sudo ufw allow 80,443/tcp
# 不要对公网开 3000；Caddy 在机器内部转发
```

云厂商的安全组同样只放 80/443。

## 4. 验证

浏览器打开：

- `https://你的域名/connect` → WebSocket 应该显示「已连接」
- `https://你的域名/host?pin=你的PIN` → 平板
- `https://你的域名/player` → 手机

## 5. 运维

```bash
sudo systemctl status blood-clocktower
sudo journalctl -u blood-clocktower -f
# 更新代码后
sudo systemctl restart blood-clocktower
```

房间状态在 `/opt/blood-clocktower/room.json`，里面有身份，别外传；重启服务会接着上一局。

## 注意

- 这个 app 没有账号体系，公网地址谁拿到都能打开、都能选座。PIN 只保护房主操作。开一桌就够用，别公开转发。
- 想换端口/文件：改 systemd 里的 `PORT`、`ROOM_FILE`。
- 如果前面还有一层 nginx/CDN，确认 WebSocket 升级头有转（见 `远程连接.md`）。
