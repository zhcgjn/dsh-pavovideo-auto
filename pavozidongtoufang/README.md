# dsh-pavo-auto

[中文](#中文) · [English](#english)

在 DeepSeek Harness（DSH）里自动操作 [Pavo AI](https://app.pavo-ai.cn) 视频生成站点：持久登录浏览器、按清单连续投递提示词、首尾帧接续、成片自动下载与末帧抽取。

A DeepSeek Harness plugin that drives the Pavo AI video site: a persistent logged-in browser, queue-driven prompt submission, first-frame chaining, automatic clip download and last-frame extraction.

---

## 中文

### 能做什么

- **持久登录**：独立的 Chromium 用户数据目录，首次手动登录一次即可复用（不保存密码）。
- **清单驱动**：按 `prompts.txt`（一行一条）或 `segments.json` 顺序自动发送。
- **参数校准**：每次发送前强制核对画面比例、时长（例如 16:9 / 10s），不通过就不发。
- **首尾帧接续**：把上一段的**末帧**作为下一段的首帧上传，形成连续镜头链（`firstFrame: true` 的段落）。
- **全自动流水线**：发送 → 等出片 → 下载 mp4 → 用 ffmpeg 抽末帧 → 下一段，中途每段发一条进度提示。
- **安全刹车**：每日上限、最小发送间隔、连续失败自动停；聊天卡片提供「紧急终止 / 继续」按钮。

### 依赖

| 依赖 | 说明 |
|---|---|
| DSH `>= 0.2.2` | 插件以 bundle 形式安装 |
| `playwright-core` | 随插件声明为 dependency；需要本机有 Chrome / Edge / Chromium |
| `ffmpeg` | 抽末帧用；Windows 可把 `ffmpeg.exe` 放到 PATH，或在配置里写绝对路径 |

### 安装

1. 把这个目录放到本机任意位置；
2. DSH → **插件** → **添加插件** → 选择本目录（或执行 `plugin_manager install_bundle`）；
3. 启用后，在对话里对我说「打开 pavo」，我会调用 `pavo_open` 拉起浏览器；
4. 在弹出的浏览器窗口里**手动登录一次**，之后登录态会保留。

> 本插件会向 profile 插入 `action-cards` 与 `client-ui-action-cards` 两行，用于聊天里的操作卡片。移除本插件时这两行也会一起消失。

### 配置

在 profile 的 `cordis.patch.yml` 里按 `id: pavo-auto` 覆盖 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `url` | `https://app.pavo-ai.cn/chat` | 站点聊天页 |
| `dataDir` | `~/.pavo-auto` | 状态、日志、浏览器配置目录 |
| `promptFile` | `<dataDir>/prompts.txt` | 提示词清单（一行一条，`#` 注释） |
| `segmentsFile` | `<dataDir>/segments.json` | 结构化分镜清单（启用流水线时需要） |
| `clipsDir` | `<dataDir>/clips` | 成片输出目录 |
| `framesDir` | `<dataDir>/frames` | 末帧输出目录 |
| `ffmpegPath` | `ffmpeg` | ffmpeg 可执行文件（PATH 命令或绝对路径） |
| `intervalMs` | `120000` | 轮询检查间隔 |
| `minGapMs` | `90000` | 两条发送之间的最小间隔 |
| `dailyLimit` | `30` | 每日发送上限 |
| `template` | `{{prompt}}` | 支持 `{{prompt}}` `{{index}}` `{{total}}` `{{date}}` |
| `headless` | `false` | 是否无头运行（首次登录必须为 false） |
| `notify` | `true` | 每段完成后是否在会话里发一条提示 |

### 工具

| 工具 | 作用 |
|---|---|
| `pavo_open` | 启动浏览器并打开站点 |
| `pavo_probe` | 探测输入框、发送按钮、video 数量、登录态 |
| `pavo_status` | 登录态、清单进度、今日已发、循环状态 |
| `pavo_send` | 发送一条（可 `dryRun` 演练） |
| `pavo_send_frame` | 首尾帧模式发送（上传首帧图片） |
| `pavo_mode` | 切换参考模式：全能模式 / 首尾帧 |
| `pavo_settings` | 强制校准画面比例与时长 |
| `pavo_watch` | 简单循环：出现新视频就发下一条 |
| `pavo_pipeline` | 全自动流水线：发送 → 下载 → 抽帧 → 下一段 |
| `pavo_download` | 带登录态下载视频到本地（无水印） |
| `pavo_log` | 查看发送记录 |

### segments.json 格式

```json
[
  {
    "id": "01",
    "subtitle": "伟大远征",
    "narration": "二十世纪三十年代，风雨飘摇的华夏大地，",
    "firstFrame": false,
    "prompt": "…上屏的完整提示词…"
  },
  {
    "id": "02",
    "subtitle": "两万五千里长征",
    "narration": "一场震撼世界的远征，就此拉开序幕。",
    "firstFrame": true,
    "prompt": "承接上一镜头的地球近景，镜头继续缓慢推近…"
  }
]
```

`firstFrame: true` 的段落会读取**上一段**的末帧 `frames/<上一段 id>.png` 作为首帧上传。

### 已知限制

- **站点内容审核**：涉及历史、军民关系等表述可能被拦截；被拦时插件会记录错误并停止，不会自动改词。
- **地图类画面**：AI 不具备地理常识，提示词要求“地图/路线”时结果往往不准，建议改用山脉、光带、篝火等意象。
- **输出尺寸**：启用首帧模式后成片可能是 1260×720 而非 1280×720，拼接前需用 ffmpeg 统一到目标分辨率。
- **水印**：从站点界面手动下载的成片带 `Pavo` 水印；请用 `pavo_download`（CDN 直链）获取干净版本。
- **额度**：每次生成消耗站点额度，插件只做限速与上限保护，不保证不会被站点风控。

### 声明

本项目仅用于自动化**你自己账号**上的操作。使用前请确认目标站点的服务条款允许自动化；因违反条款、超额生成或内容审核导致的账号或额度损失，由使用者自行承担。

---

## English

### What it does

- **Persistent login** — an isolated Chromium profile; log in manually once, then the plugin reuses the session (no password stored).
- **Queue driven** — sends prompts from `prompts.txt` (one per line) or a structured `segments.json`.
- **Settings guard** — verifies aspect ratio and duration (e.g. 16:9 / 10s) before every send and refuses to submit otherwise.
- **First-frame chaining** — uploads the previous clip's last frame as the next clip's first frame for continuous shots (`firstFrame: true`).
- **Full pipeline** — send → wait for the render → download the mp4 → extract the last frame with ffmpeg → next segment, with one short notice per segment.
- **Safety brakes** — daily cap, minimum gap between sends, stop after consecutive failures, plus an emergency-stop / resume action card.

### Requirements

- DSH `>= 0.2.2`
- `playwright-core` (declared dependency) and a local Chrome / Edge / Chromium
- `ffmpeg` on PATH, or an absolute `ffmpegPath`

### Install

1. Put this directory anywhere on the machine;
2. DSH → **Plugins** → **Add plugin** → pick this directory (or run `plugin_manager install_bundle`);
3. Enable it, then ask the agent to "open pavo" (`pavo_open`) to launch the browser;
4. Log in manually once in the opened window; the session is reused afterwards.

> The bundle also inserts the shipped `action-cards` and `client-ui-action-cards` rows, which render the emergency-stop / resume card. Removing the bundle removes them too.

### Configuration

Override `config` for row id `pavo-auto` in your profile `cordis.patch.yml`. See the table in the Chinese section — field names and defaults are identical.

### Tools

See the tool table above; names are language-neutral.

### limitations

Site content moderation, AI map inaccuracy, occasional 1260×720 output, UI downloads carrying a `Pavo` watermark, and per-generation quota usage all apply. Use `pavo_download` for watermark-free clips and normalise resolution before editing.

### Disclaimer

Automates operations on your own account only. Check the target site's terms before use; the user bears any account or quota consequences.

## License

MIT
