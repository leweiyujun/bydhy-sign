# 比亚迪海洋(mina)小程序 · 每日签到

基于青龙面板的比亚迪海洋小程序自动签到脚本：通过自部署的 YYB 取码网关获取微信 `wx.login` code，完成静默登录并每日签到。

- **作者**：乐维(lewei)
- **脚本**：[`index.js`](index.js)（单文件自包含，无需任何仓库依赖）
- **定时**：`10 0 * * *`（每天 00:10，可自行调整）

## 工作原理

```
┌──────────────┐   POST /wxapp/getCode {app_id, ref}   ┌──────────────────┐   wx.login   ┌────────┐
│ 青龙: index.js │ ───────────────────────────────────▶ │ YYB Go 取码网关    │ ──────────▶ │  微信  │
│  (签到脚本)    │ ◀───────────── code ───────────────── │ (保持微信登录态)   │             └────────┘
└──────┬───────┘                                        └──────────────────┘
       │  AES-128-CBC 加密请求（code → session_id → 签到）
       ▼
  mina.bydoceanauto.com（比亚迪海洋小程序后端）
```

脚本本身不接触微信，取码完全交给网关；网关用原生协议保持微信登录态，脚本每次需要时向它取一个新鲜 code。

> ⚠️ **账号安全提示**：协议登录属于非官方客户端行为，存在被微信风控的可能性（低概率但不为零）。**强烈建议用微信小号挂签到，不要用主力号**。手机端正常使用不受影响。

---

## 前置准备：部署青龙面板（Docker）

已有青龙可跳过。推荐 Docker 部署，一条命令：

```bash
docker run -dit \
  --name qinglong \
  --hostname qinglong \
  --restart unless-stopped \
  -p 5600:5700 \
  -v $PWD/ql/data:/ql/data \
  -e TZ=Asia/Shanghai \
  whyour/qinglong:latest
```

参数说明：

| 参数 | 说明 |
|---|---|
| `-p 5600:5700` | 面板端口映射到宿主机 5600（可改成你想要的端口） |
| `-v $PWD/ql/data:/ql/data` | 数据目录挂载，**重建容器不丢任务/配置/日志**，勿删 |
| `--restart unless-stopped` | 开机自启 |

初始化：

1. 浏览器打开 `http://<服务器IP>:5600`，按引导创建管理员账号密码；
2. 进入面板 → **依赖管理** → NodeJs → 新建依赖 `axios`（脚本唯一的第三方依赖，装一次即可）；
3. （可选）**配置文件** 里设置通知渠道（Server酱/Telegram/企业微信等），签到结果就能推送到手机。

> 公网服务器请在安全组/防火墙放行 5600 端口（仅自己 IP 可访问更安全）；`ql repo`、`task` 等命令的使用与下文一致。

---

## 第一步：部署 YYB 取码网关（Docker）

项目地址：[SJZYKJ/wxcode-yyb-fusion-docker](https://github.com/SJZYKJ/wxcode-yyb-fusion-docker)（镜像 `chungg/wxcode-yyb-fusion`，amd64/arm64 均有）。

需要一台能长期开机的机器：VPS、NAS、软路由、闲置电脑均可（和青龙同机最省事）。

### 方式一：官方一键脚本（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/SJZYKJ/wxcode-yyb-fusion-docker/main/deploy.sh | bash
```

脚本会自动生成随机访问令牌并打印，**记下来**（也可以自己指定：`... | bash -s -- --token "$(openssl rand -hex 24)"`）。

### 方式二：手动 docker compose

```bash
mkdir -p ~/wxcode-yyb && cd ~/wxcode-yyb
```

新建 `compose.yaml`：

```yaml
name: wxcode-yyb-fusion-docker
services:
  yyb-go:
    image: chungg/wxcode-yyb-fusion:latest
    container_name: wxcode-yyb-gateway
    restart: unless-stopped
    command: ["-host", "0.0.0.0", "-port", "8088", "-resource-root", "/app/resource"]
    environment:
      YYB_API_TOKEN: ${YYB_API_TOKEN}        # 取码接口令牌，脚本要用
      YYB_ADMIN_PASSWORD: ${YYB_ADMIN_PASSWORD:-}   # ≥10位则自动创建管理员
      GIN_MODE: release
    volumes:
      - ./data/db:/app/resource/db           # 微信登录态/SQLite，勿删
      - ./data/avatars:/app/resource/avatars
      - ./data/qr:/app/resource/qr
    ports:
      - "${YYB_BIND_ADDRESS:-127.0.0.1}:8088:8088"
```

新建 `.env`：

```ini
YYB_API_TOKEN=换成你自己的随机长字符串
YYB_ADMIN_PASSWORD=换成10位以上的管理密码
# 仅本机/同机容器访问用 127.0.0.1；要让局域网其他机器访问改 0.0.0.0
YYB_BIND_ADDRESS=127.0.0.1
```

启动：

```bash
docker compose up -d
docker compose logs -f    # 确认启动正常后 Ctrl+C 退出
```

### 方式三：docker run（不用 compose）

```bash
# 准备数据目录（登录态存在这里，勿删）
mkdir -p ~/wxcode-yyb/data/{db,avatars,qr}

docker run -d \
  --name wxcode-yyb-gateway \
  --restart unless-stopped \
  -p 127.0.0.1:8088:8088 \
  -v ~/wxcode-yyb/data/db:/app/resource/db \
  -v ~/wxcode-yyb/data/avatars:/app/resource/avatars \
  -v ~/wxcode-yyb/data/qr:/app/resource/qr \
  -e YYB_API_TOKEN=换成你自己的随机长字符串 \
  -e GIN_MODE=release \
  chungg/wxcode-yyb-fusion:latest \
  -host 0.0.0.0 -port 8088 -resource-root /app/resource

docker logs -f wxcode-yyb-gateway    # 确认启动正常后 Ctrl+C 退出
```

参数说明：`-p 127.0.0.1:8088:8088` 只绑本机回环（公网暴露就改 `0.0.0.0`，但**不建议**）；`YYB_API_TOKEN` 就是脚本侧要配的 `yyb_token`；升级时 `docker pull` 后删掉容器按原命令重建即可，数据在 `~/wxcode-yyb/data` 不受影响。

### 扫码挂入微信号

浏览器打开 `http://<网关地址>:8088/scan`，用手机微信扫码 → 确认登录。登录态保存在 `./data` 目录，重启容器不丢；掉了重新扫一次即可。

> 公网部署时**不要把 8088 直接暴露到 0.0.0.0**（虽然接口有令牌鉴权）。青龙在同机就用 `127.0.0.1` 或 `172.17.0.1`（docker0）绑定；需要远程访问面板时用 SSH 隧道：`ssh -N -L 8088:127.0.0.1:8088 user@服务器`，然后访问 `http://127.0.0.1:8088`。

---

## 第二步：青龙面板启用脚本

### 2.1 放入脚本

青龙面板 → **脚本管理** → 右上角 **+** → 新建空文件（如 `byd_hy.js`）→ 把本仓库 [`index.js`](index.js) 的全部内容粘贴进去保存：

![青龙操作步骤](readme_img/qinglong-steps.png)

（也可以直接把 `index.js` 文件上传到 `/ql/data/scripts/` 目录。脚本是单文件自包含的，放任何位置都能跑。）

### 2.2 配置环境变量

面板 → **环境变量** → 新建：

| 变量名 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `user_account` | ✅ | 网关里的 openid（即取码用的 ref），多账号 `&` 分隔，支持 `#备注` | `oXXXX6vJevL3FFk6cueq1WtYXXXX#我的号` |
| `yyb_url` | ✅ | 网关地址（见下方"网络连通"） | `http://172.17.0.1:8088` |
| `yyb_token` | ✅ | 网关的 `YYB_API_TOKEN` | 部署时生成的令牌 |

> openid 从哪来：网关面板里添加微信账号后可见；或直接调一次接口看返回里的 `data.openid`：
> ```bash
> curl -X POST http://<网关>:8088/wxapp/getCode \
>   -H "Authorization: Bearer <令牌>" \
>   -H "Content-Type: application/json" \
>   -d '{"app_id":"wxf62054ec313d6f53","ref":"<面板里的账号标识>"}'
> ```

### 2.3 网络连通（青龙和网关的相对位置）

| 部署形态 | `yyb_url` 怎么填 |
|---|---|
| 同机，网关绑 `172.17.0.1`（docker0） | `http://172.17.0.1:8088`（**最简单，推荐**） |
| 同机，自建同一 docker 网络 | `http://wxcode-yyb-gateway:8088`（容器名，需两个容器在同一自定义网络内） |
| 网关绑 `127.0.0.1` | 容器内 `127.0.0.1` 指向容器自己，**不通**，改用上面两种方式之一 |
| 网关/青龙不同机 | `http://<网关机器IP>:8088`（网关需绑 `0.0.0.0` 或对应网卡地址） |

验证连通性（在宿主机执行）：

```bash
docker exec qinglong wget -qO- http://172.17.0.1:8088/health
# 返回 {"code":0,"msg":"success",...} 即通
```

### 2.4 建定时任务

面板 → **定时任务** → 新建：

- 命令：`task byd_hy.js`（脚本文件名）
- 定时：`10 0 * * *`

保存后手动点一次"运行"验证，日志出现 `✅ 签到成功`（或当日已签过的 `✅ 今日已签到`）即完成。

![签到成功日志](readme_img/sign-success.png)

---

## 第三步（可选）：从零自建全套 Docker

如果青龙也还没装，一个 compose 全搞定：

```yaml
name: sign-stack
services:
  qinglong:
    image: whyour/qinglong:latest
    container_name: qinglong
    restart: unless-stopped
    ports:
      - "5600:5700"
    volumes:
      - ./ql/data:/ql/data
    environment:
      TZ: Asia/Shanghai

  yyb-go:
    image: chungg/wxcode-yyb-fusion:latest
    container_name: wxcode-yyb-gateway
    restart: unless-stopped
    command: ["-host", "0.0.0.0", "-port", "8088", "-resource-root", "/app/resource"]
    environment:
      YYB_API_TOKEN: ${YYB_API_TOKEN}
      GIN_MODE: release
    volumes:
      - ./yyb/data/db:/app/resource/db
      - ./yyb/data/avatars:/app/resource/avatars
      - ./yyb/data/qr:/app/resource/qr
    # 不映射端口：与青龙同网络，容器名直达，外部摸不到
```

```bash
echo 'YYB_API_TOKEN=换成随机长字符串' > .env
docker compose up -d
```

此时 `yyb_url=http://wxcode-yyb-gateway:8088`（同一 compose 网络内容器名互通）。青龙面板在 `http://<机器IP>:5600`。

如果已经有网关、只缺青龙，单起青龙用官方命令：

```bash
docker run -dit \
  --name qinglong \
  --hostname qinglong \
  --restart unless-stopped \
  -p 5600:5700 \
  -v $PWD/ql/data:/ql/data \
  -e TZ=Asia/Shanghai \
  whyour/qinglong:latest
```

（`-p 5600:5700` 把面板映射到 5600 端口；`-v` 挂载数据目录，重建容器不丢任务和配置。）

---

## 常见问题

**Q：日志报 `Cannot find module 'axios'`**
A：青龙依赖没装。面板 → 依赖管理 → NodeJs → 新建 `axios`，装完重跑。

**Q：`签到失败(ret=50010): 请下载最新"比亚迪"APP完成账号升级`**
A：两种可能：① 缓存 session 是账号升级前建的——脚本已内置处理，遇到 50010 会自动清缓存重新登录重试一次；② 重试后仍报，说明该微信号确实没完成比亚迪 App 账号升级：用该微信登录比亚迪 App / 海洋小程序，完成手机号绑定后再跑。

**Q：日志显示 `✅ 今日已签到，积分 1，已连续 N 天` 但没跑签到？**
A：今天已经签过了（服务端返回 `ret=200 + duplicate=true`），脚本会识别为成功，不是错误。

**Q：`getaddrinfo ENOTFOUND wxcode-yyb-gateway` / 连接超时**
A：网络没通，回 2.3 节对照部署形态选地址；用 `docker exec qinglong wget -qO- <yyb_url>/health` 验证。注意：如果青龙容器配了自定义 DNS（resolv.conf 里没有 `127.0.0.11`），容器名解析不可用，改用 IP 方式。

**Q：扫码后过几天签到开始失败？**
A：网关的微信登录态掉了（被顶号、风控或保活失败都可能）。打开网关面板 `/scan` 重新扫码，并删掉青龙里的 `bydhy_token_cache.json` 让脚本重新登录。

**Q：`bydhy_token_cache.json` 是什么？**
A：脚本在自身目录缓存的 session_id，避免每次都消耗 code 登录。session 失效会自动重登，文件可放心删除。

## 免责声明

本项目仅供学习交流使用，请勿用于商业或非法用途。使用第三方协议网关登录微信存在账号风控风险，请自行评估并建议使用小号。因使用本项目产生的任何后果由使用者自行承担。
