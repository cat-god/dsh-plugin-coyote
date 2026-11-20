# Changelog

本项目的版本号跟 `package.json` 走。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] — 2026-11-20

首个公开版本。从 QQ 桥接的内嵌模块抽成独立 DSH 插件。

### 新增

- **13 个工具**：`coyote_status` / `coyote_qr` / `coyote_connect` / `coyote_disconnect` /
  `coyote_waves` / `coyote_pulse` / `coyote_build` / `coyote_play` / `coyote_set` /
  `coyote_step` / `coyote_boost` / `coyote_clear` / `coyote_stop`。
- **16 条官方预设波形**（呼吸 / 潮汐 / 连击 / 快速按捏 / 按捏渐强 / 心跳节奏 / 压缩 /
  节奏步伐 / 颗粒摩擦 / 渐变弹跳 / 波浪涟漪 / 雨水冲刷 / 变速敲击 / 信号灯 / 挑逗1 / 挑逗2）。
- **波形生成器**：形状 `平 / ramp / rampDown / wave / pulse / random / breathe`，
  可指定频率（10~120）、强度、下限、BPM、抖动幅度、随机种子（同 seed 可复现）。
- **长波形投放**：`coyote_play` 自动把长段切成 ≤8.6 秒的块续投，
  绕开「单条消息 1950 字符 / 队列 500 条」两条协议限制。
- **安全信封**：
  · 增加侧令牌桶（默认 40/秒），**降低与归零永远瞬时放行、不受任何限流**；
  · 会期上限（默认 1 小时）+ 断开后冷却（默认 3 秒）；
  · 看门狗（默认 15 秒收不到 APP 回帧就自动全停 + 断开）；
  · `coyote_boost` 到点自动降回，降回失败则全停兜底。
- **玩法尾注** `coyotePromptLine()`：按状态注入，插件关着是空串、
  未配对只给一句提示、配对后才给玩法与红线。可单独 `import 'dsh-plugin-coyote/prompt'`。
- **HTTP 接口**：`/api/coyote-3/{state,qr,connect,stop,disconnect,action}`，
  带同源校验（`sameOriginOk`），供控制台或本地脚本调用。
- **二维码 PNG**：零依赖生成（内置 vendor 版 QRCode.js + 自写 PNG 编码器），
  落在插件家目录的 `outbox/` 下。

### 已知限制

- 只走官方 **SOCKET 协议**（WebSocket 中继），没有实现 BLE 直连。
- `coyote_play` 的补投循环是内存态，插件重载 / 进程重启即中断。
- 波形一帧 16 hex = 4 组 (频率, 强度)，本项目的生成器把 4 组频率写成同值 ——
  25ms 级的变化人体分辨不出来，写同值不影响手感，但表达力不如官方 `.pulse` 文本格式。
- 不支持导入 / 导出 `.pulse` 文件。
