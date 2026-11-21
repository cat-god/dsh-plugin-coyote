# dsh-plugin-coyote

让 AI 伙伴操控 **DG-LAB / 郊狼 3.0** 脉冲主机的 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness）插件。

- 走**官方 SOCKET 协议**（WebSocket 中继）—— 不需要蓝牙、不需要 root、不需要逆向 APP
- 配对只要手机 APP 扫**一次**二维码（插件把二维码画成 PNG 落在自己家目录里）
- 13 个 DSH 工具：查状态 / 出码 / 连中继 / 列波形 / 调强度 / 微调 / 放波形 / 现造波形 / 长段投放 / 临时顶一下 / 清队列 / 全停 / 断开
- 内置 **16 条官方波形** + 6 种形状的**波形生成器**（平 / 渐强 / 渐弱 / 起伏 / 脉冲 / 呼吸，带 BPM、抖动、seed）
- **安全信封默认全开**：双上限取 min、加侧令牌桶、1 小时会期、90 秒看门狗（大于官方中继 60 秒心跳间隔）、长波形自动切片
- 零原生依赖（只用 Node 22 自带的全局 `WebSocket`），零 npm 运行时依赖

> ⚠️ 这是给**成年人自己身上**用的情趣/理疗外设做的控制层。请先读[安全](#安全)那一节。

---

## 它长什么样

装上之后，模型多出这些工具（命名空间 `coyote`）：

| 工具 | 干什么 |
| --- | --- |
| `coyote_status` | 查：插件开关 / 中继连接 / APP 配对 / A·B 强度与软上限 / 护栏读数 |
| `coyote_qr` | 连中继 + 出配对二维码（PNG 落 `outbox/`，返回绝对路径） |
| `coyote_connect` | 只连中继（一般用 `coyote_qr` 就够） |
| `coyote_waves` | 列 16 条内置波形（名字 / 帧数 / 秒数） |
| `coyote_set` | 把某通道强度设成绝对值（会被双上限夹） |
| `coyote_step` | 按档微调（正数加、负数减） |
| `coyote_pulse` | 放一段波形（内置名或自定义帧，单条 ≤10 秒） |
| `coyote_build` | 按参数**现场造**一段波形（只造不播，返回帧数与预览） |
| `coyote_play` | 放**长**波形（可到 `maxPlaySec`，自动切片续投） |
| `coyote_boost` | 临时顶一下，到点自动降回去（回落失败会整体全停） |
| `coyote_clear` | 清掉某通道排队中的波形（不动强度） |
| `coyote_stop` | **全停**：清队列 + 两通道归零 + 掐掉补投。幂等、不受限速 |
| `coyote_disconnect` | 断开中继（会先全停） |

另外导出 `coyotePromptLine({ coyoteCfg, state })`，供宿主在提示词**末尾**拼一段
「他这会儿戴着，你可以调」的玩法尾注（插件关着 / 没配对时返回空串或一句提醒）。

---

## 安装

### 1. 放进 DSH 的插件目录

```powershell
# 从源码（本仓库）
git clone <this repo> "$env:USERPROFILE\.dsh\plugins\dsh-plugin-coyote"

# 或从 npm（发布后）
# npm i -g dsh-plugin-coyote   # 然后把它 link 进 profile，见下
```

### 2. 让 profile 认识它

编辑 `$env:USERPROFILE\.dsh\profiles\<你的 profile>\package.json`，加一条依赖（`link:` 指向上面的目录）：

```json
{
  "dependencies": {
    "dsh-plugin-coyote": "link:C:/Users/<you>/.dsh/plugins/dsh-plugin-coyote"
  }
}
```

然后 `pnpm install`（或让 DSH 自己重装），重启 DSH。

`cordis.patch.yml` 会把它插进 loader —— 注意里面 **`id: coyote` 必须等于插件导出的
命名空间名**，否则设置页写任何一项都会抛 `No configurable plugin entry "coyote"`。

### 3. 打开它

插件**默认关闭**（`enabled: false`）。在 DSH 设置页找到 `coyote` 这一组，把 `enabled` 打开。

---

## 配对（一次就好）

1. 第一次点 `coyote_qr`（或 `POST /api/coyote-3/qr`）→ 插件连上中继、申请一个 `clientId`、
   把二维码画成 PNG 落到 `<DSH_HOME>/coyote-3/outbox/coyote-qr-<ts>.png`，并把文本一起返回。
2. 手机打开 **DG-LAB** APP → 首页点 **「Socket 控制」**（**不是**「远程控制」，那是另一个功能）→ 扫码。
3. 扫上之后 `coyote_status` 的 `paired` 会变成 `true`，工具就能用了。

注意事项：

- 每次 `coyote_qr` 都会申请**新的** `clientId`，旧码立刻作废 —— 二维码是一次性的。
- 二维码里的 ws 地址必须是**手机能访问到**的。用官方公共中继 `wss://ws.dungeon-lab.cn/` 最省事；
  自建中继时别填 `127.0.0.1` / `198.18.x.x` 这类手机连不上的地址。
- 手机息屏可能断连 → 看门狗会全停并断开，重新扫码即可。
- 默认 `idleTimeoutMs` 是 5 分钟：出了码但 5 分钟没人扫，自动断开省得挂着空连接。

---

## 配置项

全部在 DSH 设置页（命名空间 `coyote`）。**每一项都带 `volatile` 标记**，改完立即生效。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总闸。关着时所有工具回「没开」，也不会连中继 |
| `url` | `wss://ws.dungeon-lab.cn/` | 中继地址（官方公共中继是他人的服务器，仅供测试） |
| `maxStrength` | `100` | 我们自己的强度上限（与 APP 报的通道软上限**取 min**） |
| `heartbeatMs` | `55000` | 心跳间隔；官方建议 60s 内 |
| `watchdogMs` | `90000` | 多久接不到**任何帧**（含中继 60 秒心跳）就**自动全停 + 断开**；必须大于 60 秒心跳间隔，否则「没人在玩」会被错杀 |
| `increasePerSec` | `40` | 抬高强度的令牌桶速率（点/秒）；**降与归零永不受限** |
| `maxSessionSec` | `3600` | 一次配对的最长会期 |
| `maxPlaySec` | `600` | 单次投放的最长时长 |
| `qrScale` | `6` | 二维码每模块像素数 |
| `promptOnlyForOwner` | `true` | 只给「主人会话」注入玩法尾注（多用户宿主务必开着） |
| `ownerKey` | `''` | 主人会话 key，例如 `private:123456789`；留空 = 不限制 |

> 范围不在 schema 里用 `.max()/.min()` 表达 —— schema 校验不过会让 cordis 直接拒收这条 entry，
> **整条插件不激活**。范围一律在读取时钳（见 `index.js` 的 `clampConfig`）。

---

## 家目录

```
<DSH_HOME>/coyote-3/
├── state.json     上次连到哪 / 强度多少（重启可见，不自动重连）
├── coyote.log     插件日志
└── outbox/
    └── coyote-qr-<ts>.png   配对二维码
```

状态落**插件自己的家目录**，不往 `node_modules` 里写 —— 那里在插件升级时会被覆盖。

---

## HTTP 接口（本机同源才有）

插件在宿主里挂了一个前缀路由 `/api/coyote-3`，只接受**本机同源**请求：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 配置 + 状态 + 波形数 + 家目录 |
| POST | `/qr` | 出配对二维码 |
| POST | `/connect` | 只连中继 |
| POST | `/action` | `{op:'status'\|'set'\|'step'\|'clear'\|'stop', ...}` |
| POST | `/stop` | 全停 |
| POST | `/disconnect` | 全停 + 断开 |

---

## 安全

这个插件会驱动**真的会有电流通过身体**的硬件。写这份代码时遵守的规则，也请你遵守：

1. **双上限取 min**：插件自己的 `maxStrength` 与 APP 报的通道软上限，哪个小用哪个。
2. **降与归零永远瞬时放行**：升强度才受令牌桶限制（默认 40 点/秒，且不排队 —— 超了直接报错）。
3. **会期上限 1 小时**：一次配对最多开这么久，到点必须重新扫。
4. **看门狗 90 秒**：任何帧（含中继 60 秒心跳）都没来才全停 + 断开。APP 平时不说话是正常的（只在改强度时回帧），别把默认值改回 60 以下。
5. **长波形切片**：单条 JSON >1950 字符 APP 会直接丢（错误码 405），所以长段按 ≤8.6 秒切片续投。
6. **卸载即断电**：插件被停用 / 宿主退出时先 `stop` 再 `disconnect`（`ctx.effect` 的清理函数）。
7. **禁用部位**：胸部、心脏投影区、头面部/眼/口腔/颈及颈动脉窦附近、破损皮肤。
8. **不要**多台设备同时用、不要开车时用、不要在无人看管时长时间开着。

出问题第一件事永远是 `coyote_stop`。

---

## 开发与自检

```bash
node test/run.mjs
```

自检不需要硬件、不需要连中继、不需要 DSH —— 覆盖波形库/生成器、二维码文本格式、
默认关闭时的安全性、状态目录解析（含 `dshHomePath` 是函数那个真机坑）、玩法尾注四态、
插件入口接线、打包元数据、安全信封的源码级断言。

---

## 协议出处

- SOCKET 协议 V2/V3：<https://github.com/dungeonlab-open/dglab-websocket-simple>
- 蓝牙协议 V3（本插件不用，但波形编码规则同源）：<https://github.com/dungeonlab-open/dglab-bluetooth-protocol>
- 官方波形库：`dglab-websocket-simple/socket/DG_WAVES_V2_V3_simple.js`（本仓库把 `expectedV3` 那一段原样搬进 `lib/coyote-waves.js`）

波形帧格式（自己写帧时别记错）：**一帧 16 hex = 8 字节 = 4 组 (频率, 强度)**，每组 25ms，
合计 100ms。频率有效 10~240（输入 10~1000ms 会按官方规则压缩），强度 0~100。
某通道任一值非法 → **该通道整 4 组被丢弃**（这是最容易静默踩的坑）。

---

## License

MIT。`lib/vendor/qrcode/` 是 [qrcode-terminal](https://github.com/gtanner/qrcode-terminal)（0.12.0）
里那份 Kazuhiko Arase 的 QRCode.js，同样 MIT，见 `lib/vendor/qrcode/SOURCE.txt`。
