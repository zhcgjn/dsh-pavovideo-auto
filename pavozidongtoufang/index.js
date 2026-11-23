/**
 * pavo-auto: drives app.pavo-ai.cn/chat with a persistent, manually logged-in
 * Chromium profile, sends prompts from a local queue, and reports every round.
 *
 * The plugin imports nothing by bare specifier: DSH modules are loaded from the
 * installed runtime (app.asar) and playwright-core from the profile's
 * node_modules, because a linked workspace package resolves from its own path.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function firstExisting(paths) {
  for (const path of paths) {
    if (path === '') continue
    try {
      if (existsSync(path)) return path
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

const dshModules = firstExisting([
  process.resourcesPath ? join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules') : '',
  join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'),
])
if (dshModules === undefined) throw new Error('pavo-auto: cannot locate the DSH runtime node_modules')

const profileCandidates = []
if (process.env.DSH_PROFILE_DIR) profileCandidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules'))
try {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const profiles = join(home, '.dsh', 'profiles')
  for (const name of readdirSync(profiles)) profileCandidates.push(join(profiles, name, 'node_modules'))
} catch {
  /* ignore */
}
const profileModules = firstExisting(profileCandidates.filter(path => existsSync(join(path, 'playwright-core'))))

const load = specifier => import(pathToFileURL(join(dshModules, '@deepseek-ai', specifier)).href)
const { defineTool } = await load('dsh-tools/lib/index.js')
const { createUserMessage } = await load('dsh-llm/lib/index.js')
const Schema = (await load('schemastery/lib/index.mjs')).default

function loadPlaywright() {
  const candidates = [profileModules, join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules')]
    .filter(path => path !== undefined)
  for (const root of candidates) {
    try {
      const requireFrom = createRequire(join(root, '_pavo_auto_.js'))
      return requireFrom('playwright-core')
    } catch {
      /* next */
    }
  }
  throw new Error('pavo-auto: playwright-core is not installed in this profile')
}

export const name = 'pavo-auto'
export const inject = ['tools']

export const Config = Schema.object({
  url: Schema.string().default('https://app.pavo-ai.cn/chat'),
  /** Root for state, logs and browser profile; defaults to ~/.pavo-auto */
  dataDir: Schema.string().default(''),
  /** Optional absolute path to the prompt list; defaults to <dataDir>/prompts.txt */
  promptFile: Schema.string().default(''),
  /** Optional absolute path to segments.json; defaults to <dataDir>/segments.json */
  segmentsFile: Schema.string().default(''),
  /** Optional absolute output directory for clips; defaults to <dataDir>/clips */
  clipsDir: Schema.string().default(''),
  /** Optional absolute directory for extracted last frames; defaults to <dataDir>/frames */
  framesDir: Schema.string().default(''),
  /** ffmpeg executable: a PATH command or an absolute path. Defaults to "ffmpeg". */
  ffmpegPath: Schema.string().default('ffmpeg'),
  intervalMs: Schema.number().default(120000),
  minGapMs: Schema.number().default(90000),
  dailyLimit: Schema.number().default(30),
  template: Schema.string().default('{{prompt}}'),
  headless: Schema.boolean().default(false),
  notify: Schema.boolean().default(true),
})

const CARD_ACTION = 'pavo_loop'
const SKILL_NAME = 'pavo-control'
const SEND_BUTTON = /发送|send|generate|生成/i
const COMPOSER_SELECTORS = [
  '[contenteditable="true"]',
  'textarea',
  'div[role="textbox"]',
  '[role="textbox"]',
  'input[type="text"]:not(.ant-select-selection-search-input)',
]

const today = () => new Date().toLocaleDateString('sv-SE')

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function apply(ctx, config) {
  let actionCards
  let skills
  const dataDir = config.dataDir || join(homedir(), '.pavo-auto')
  mkdirSync(dataDir, { recursive: true })
  const promptFile = config.promptFile || join(dataDir, 'prompts.txt')
  const logFile = join(dataDir, 'log.jsonl')
  const stateFile = join(dataDir, 'state.json')
  const profileDir = join(dataDir, 'browser-profile')

  const state = readJson(stateFile, { day: today(), sent: 0, index: 0, seen: [], lastSentAt: 0 })
  if (state.day !== today()) {
    state.day = today()
    state.sent = 0
  }
  if (!Array.isArray(state.seen)) state.seen = []

  const saveState = () => {
    try {
      writeFileSync(stateFile, JSON.stringify(state, null, 2))
    } catch (error) {
      ctx.logger.warn('pavo-auto: cannot save state: %s', String(error))
    }
  }

  const record = (entry) => {
    try {
      appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n')
    } catch (error) {
      ctx.logger.warn('pavo-auto: cannot write log: %s', String(error))
    }
  }

  const queue = () => {
    try {
      if (!existsSync(promptFile)) return []
      return readFileSync(promptFile, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
    } catch {
      return []
    }
  }

  let context
  let page
  const loop = { running: false, timer: null, failures: 0, lastError: '', stopAfter: 0 }
  let cardAgent
  let cardCallId

  const launch = async () => {
    if (context !== undefined) return page
    mkdirSync(profileDir, { recursive: true })
    const { chromium } = loadPlaywright()
    const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, { channel: 'chromium' }, {}]
    let lastError
    for (const attempt of attempts) {
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          headless: config.headless,
          viewport: { width: 1440, height: 900 },
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
          ...attempt,
        })
        page = context.pages()[0] ?? await context.newPage()
        break
      } catch (error) {
        lastError = error
        context = undefined
      }
    }
    if (context === undefined) {
      throw new Error('无法启动浏览器：' + (lastError instanceof Error ? lastError.message : String(lastError)))
    }
    ctx.effect(() => () => {
      void context?.close().catch(() => {})
      context = undefined
      page = undefined
    }, 'pavo-auto: browser lifecycle')
    return page
  }

  const open = async () => {
    await launch()
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(1500)
    return page
  }

  const composer = async () => {
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector).last()
      const count = await locator.count().catch(() => 0)
      if (count > 0 && await locator.isVisible().catch(() => false)) return { locator, selector }
    }
    return undefined
  }

  const sendButton = async () => {
    const byId = page.locator('#dle_send_button')
    if (await byId.count().catch(() => 0) > 0) return byId.first()
    for (const locator of [
      page.getByRole('button', { name: SEND_BUTTON }).last(),
      page.locator('button, [role="button"]').filter({ hasText: SEND_BUTTON }).last(),
    ]) {
      const count = await locator.count().catch(() => 0)
      if (count > 0 && await locator.isVisible().catch(() => false)) return locator
    }
    return undefined
  }

  const videos = async () => page.evaluate(() => [...document.querySelectorAll('video')]
    .map(video => video.currentSrc || video.src || '')
    .filter(src => src.length > 0))

  const loggedIn = async () => {
    const login = page.getByText('登录', { exact: true })
    if ((await login.count().catch(() => 0)) > 0) return false
    return (await composer()) !== undefined
  }

  /** Dismiss the settings popover so it cannot swallow the next click. */
  const closeSettings = async () => {
    const hidden = async () => !(await page.locator('input[aria-label="时长"]').first().isVisible().catch(() => false))
    if (await hidden()) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    if (await hidden()) return
    await page.locator('[contenteditable="true"]').first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(300)
  }

  /** Open the settings popover and force 10s + 16:9, then confirm the pill text. */
  const ensureSettings = async () => {
    const pill = page.locator('#dle_setting').first()
    if (await pill.count().catch(() => 0) === 0) return { ok: false, reason: '没有找到设置按钮 #dle_setting' }
    const current = (await pill.innerText().catch(() => '')).replace(/\s+/g, ' ')
    if (/10\s*s/i.test(current) && current.includes('16:9')) return { ok: true, pill: current, skipped: true }

    const duration = page.locator('input[aria-label="时长"]').first()
    const panelOpen = async () => await duration.isVisible().catch(() => false)
    await pill.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    for (let attempt = 0; attempt < 2 && !await panelOpen(); attempt += 1) {
      await pill.click({ force: true }).catch(() => {})
      await duration.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    }
    if (!await panelOpen()) return { ok: false, reason: '设置面板没有弹出' }

    const ratio = page.getByRole('button', { name: '16:9', exact: true }).first()
    if (await ratio.count().catch(() => 0) === 0) return { ok: false, reason: '设置面板里没找到 16:9 比例' }
    await ratio.click()
    await page.waitForTimeout(300)
    if (await duration.count().catch(() => 0) === 0) return { ok: false, reason: '设置面板里没找到时长输入框' }
    await duration.fill('10')
    await duration.press('Tab')
    await page.waitForTimeout(400)
    await closeSettings()
    const after = (await pill.innerText().catch(() => '')).replace(/\s+/g, ' ')
    const ok = /10\s*s/i.test(after) && after.includes('16:9')
    return { ok, pill: after, reason: ok ? undefined : '设置没有生效：' + after }
  }

  /** The send button doubles as a stop button while a generation runs; never click that. */
  const sendButtonState = async () => {
    const button = page.locator('#dle_send_button').first()
    if (await button.count().catch(() => 0) === 0) return { found: false }
    const label = (await button.getAttribute('aria-label').catch(() => '')) ?? ''
    const disabled = (await button.getAttribute('aria-disabled').catch(() => null)) === 'true'
      || !(await button.isEnabled().catch(() => false))
    const stop = /stop|停止/i.test(label)
    return { found: true, button, label, disabled, stop, busy: stop || disabled }
  }

  /** Switch the reference mode pill (全能模式 / 首尾帧) with retries and verification. */
  const setMode = async (label) => {
    const pill = page.locator('.ant-select-selection-item').filter({ hasText: /全能模式|首尾帧/ }).first()
    if (await pill.count().catch(() => 0) === 0) return { ok: false, reason: '没有找到参考模式选择器' }
    await pill.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = (await pill.innerText().catch(() => '')).trim()
      if (current.includes(label)) return { ok: true, mode: current, skipped: true }
      await pill.click({ force: true }).catch(() => {})
      await page.waitForTimeout(600)
      const option = page.locator('.ant-select-item').filter({ hasText: label }).first()
      await option.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
      if (await option.count().catch(() => 0) > 0) await option.click({ force: true }).catch(() => {})
      await page.waitForTimeout(900)
    }
    const after = (await pill.innerText().catch(() => '')).trim()
    return { ok: after.includes(label), mode: after, reason: after.includes(label) ? undefined : '切换失败：' + after }
  }

  const send = async (text, dryRun) => {
    await launch()
    const target = await composer()
    if (target === undefined) return { ok: false, reason: '没有找到输入框（可能未登录或页面未加载）' }
    const settings = await ensureSettings()
    if (!settings.ok) return { ok: false, reason: settings.reason }
    await closeSettings()

    // The button is a "Stop" control while a generation runs, and stays disabled
    // while the composer is empty, so only the Stop label means "busy". A long
    // video can take many minutes, so wait up to 15 minutes.
    const deadline = Date.now() + (dryRun ? 5000 : 900000)
    for (;;) {
      const state = await sendButtonState()
      if (!state.found) return { ok: false, reason: '没有找到发送按钮' }
      if (!state.stop) break
      if (Date.now() > deadline) return { ok: false, reason: '页面仍在生成中（发送键是「停止」），暂时不能发下一条' }
      await page.waitForTimeout(4000)
    }
    if (dryRun) return { ok: true, dryRun: true, input: target.selector, hasButton: true, pill: settings.pill }

    await target.locator.click()
    await target.locator.fill(text).catch(async () => {
      await target.locator.pressSequentially(text, { delay: 15 })
    })
    await page.waitForTimeout(400)
    const ready = await sendButtonState()
    if (!ready.found) return { ok: false, reason: '输入后没有找到发送按钮' }
    if (ready.stop) return { ok: false, reason: '页面已开始生成新任务，本次未发送' }
    try {
      await ready.button.click({ timeout: 15000 })
    } catch (error) {
      return { ok: false, reason: '点击发送失败：' + String(error) }
    }
    await page.waitForTimeout(2000)
    return { ok: true, input: target.selector, viaButton: true }
  }

  const formatPrompt = (prompt, index, total) => config.template
    .replaceAll('{{prompt}}', prompt)
    .replaceAll('{{index}}', String(index + 1))
    .replaceAll('{{total}}', String(total))
    .replaceAll('{{date}}', today())

  const notify = (agent, text) => {
    if (!config.notify || agent === undefined) return
    try {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    } catch (error) {
      ctx.logger.warn('pavo-auto: notify failed: %s', String(error))
    }
  }

  const refreshCard = (phase, data) => {
    if (actionCards === undefined || cardAgent === undefined || cardCallId === undefined) return
    try {
      actionCards.record(cardAgent, { callId: cardCallId, action: CARD_ACTION, phase, data })
    } catch (error) {
      ctx.logger.warn('pavo-auto: card update failed: %s', String(error))
    }
  }

  const findLatestCard = (agent) => {
    if (actionCards === undefined) return
    try {
      const view = actionCards.view(agent.session)
      const latest = Object.values(view.proposals).filter(item => item.action === CARD_ACTION).pop()
      if (latest !== undefined) {
        cardAgent = agent
        cardCallId = latest.callId
      }
    } catch {
      /* ignore */
    }
  }

  const stopLoop = (reason) => {
    loop.running = false
    if (loop.timer !== null) {
      clearTimeout(loop.timer)
      loop.timer = null
    }
    if (reason !== undefined) record({ event: 'loop-stop', reason })
    refreshCard('stopped', { reason: reason ?? '', sentToday: state.sent })
    return reason
  }

  /** Read the next queue item without consuming it; the index advances only after a send succeeds. */
  const peekPrompt = () => {
    const items = queue()
    if (items.length === 0 || state.index >= items.length) return undefined
    return { prompt: items[state.index], index: state.index, total: items.length }
  }

  const commitPrompt = () => {
    state.index += 1
    saveState()
  }

  const round = async (agent) => {
    if (loop.stopAfter > 0 && state.index >= loop.stopAfter) {
      stopLoop('已发到第 ' + loop.stopAfter + ' 段（测试上限）')
      notify(agent, `【Pavo 自动投放】测试完成：已连续发到第 ${loop.stopAfter} 段，循环已自动停止。`)
      return
    }
    if (state.sent >= config.dailyLimit) {
      stopLoop('达到每日上限 ' + config.dailyLimit)
      notify(agent, `【Pavo 自动投放】已达每日上限 ${config.dailyLimit} 条，循环已停止。`)
      return
    }
    const wait = state.lastSentAt + config.minGapMs - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    const item = peekPrompt()
    if (item === undefined) {
      stopLoop('提示词清单已用完')
      notify(agent, '【Pavo 自动投放】提示词清单已发完，循环已停止。补充 prompts.txt 后点卡片「继续」。')
      return
    }
    const text = formatPrompt(item.prompt, item.index, item.total)
    const result = await send(text, false)
    if (!result.ok) {
      loop.failures += 1
      loop.lastError = result.reason
      record({ event: 'send-failed', prompt: text, reason: result.reason })
      refreshCard('error', { reason: result.reason, sentToday: state.sent })
      if (loop.failures >= 2) stopLoop('连续发送失败：' + result.reason)
      return
    }
    loop.failures = 0
    state.sent += 1
    state.lastSentAt = Date.now()
    commitPrompt()
    saveState()
    record({ event: 'sent', index: item.index + 1, prompt: text, input: result.input })
    refreshCard('running', {
      sentToday: state.sent,
      lastPrompt: text,
      remaining: Math.max(0, queue().length - state.index),
    })
    notify(agent, `【Pavo 自动投放】第 ${String(item.index + 1).padStart(2, '0')} 段已发送（今日第 ${state.sent} 条）：${text.slice(0, 80)}`)
  }

  const tick = async (agent) => {
    if (!loop.running) return
    try {
      await launch()
      if (page.url() === 'about:blank') await open()
      const fresh = (await videos()).filter(src => !state.seen.includes(src))
      if (fresh.length > 0) {
        for (const src of fresh) state.seen.push(src)
        if (state.seen.length > 500) state.seen = state.seen.slice(-500)
        saveState()
        record({ event: 'video-detected', src: fresh[fresh.length - 1] })
        await round(agent)
      }
    } catch (error) {
      loop.lastError = String(error)
      record({ event: 'loop-error', reason: String(error) })
    }
    if (loop.running) {
      loop.timer = setTimeout(() => void tick(agent), config.intervalMs)
      if (typeof loop.timer.unref === 'function') loop.timer.unref()
    }
  }

  const startLoop = (agent, stopAfter = 0) => {
    if (loop.running) return '循环已在运行'
    const items = queue()
    if (items.length === 0 || state.index >= items.length) return '提示词清单为空或已用完：' + promptFile
    loop.running = true
    loop.failures = 0
    loop.lastError = ''
    loop.stopAfter = stopAfter
    const capture = async () => {
      try {
        await launch()
        if (page.url() === 'about:blank') await open()
        for (const src of await videos()) if (!state.seen.includes(src)) state.seen.push(src)
        saveState()
      } catch (error) {
        ctx.logger.warn('pavo-auto: baseline failed: %s', String(error))
      }
    }
    void capture().then(() => {
      record({ event: 'loop-start' })
      refreshCard('running', { sentToday: state.sent, remaining: queue().length - state.index })
      void (async () => {
        // First prompt goes out immediately; later ones follow each new video.
        await round(agent)
        if (loop.running) {
          loop.timer = setTimeout(() => void tick(agent), config.intervalMs)
          if (typeof loop.timer.unref === 'function') loop.timer.unref()
        }
      })()
    })
    return '循环已启动'
  }

  // ---- action card: 紧急终止 / 继续 -------------------------------------
  const detailsSchema = {
    safeParse(value) {
      return { success: true, data: { dryRun: value?.dryRun === true } }
    },
  }

  ctx.inject(['actionCards', 'skills'], (inner) => {
  actionCards = inner.actionCards
  skills = inner.skills
  actionCards.register({    action: CARD_ACTION,
    skill: SKILL_NAME,
    invitation: '告诉用户：卡片上的「紧急终止」会立刻停下循环，「继续」会从清单断点处接着跑。',
    details: detailsSchema,
    verbs: { stop: { global: true }, resume: { global: true } },
    openPhases: ['stopped', 'error'],
    statusGuidance: 'stopped 表示循环已停止，可点继续恢复；error 表示上一轮发送失败，可点继续重试。',
    statusFields: ['reason', 'sentToday', 'lastPrompt', 'remaining'],
    act: async (agent, proposal, verb) => {
      cardAgent = agent
      cardCallId = proposal.callId
      if (verb === 'stop') {
        const reason = stopLoop('用户点了紧急终止')
        return { status: 'settled', decision: { callId: proposal.callId, action: CARD_ACTION, phase: 'stopped', data: { reason, sentToday: state.sent } } }
      }
      if (verb === 'resume') {
        startLoop(agent)
        return { status: 'settled', decision: { callId: proposal.callId, action: CARD_ACTION, phase: 'running', data: { sentToday: state.sent, remaining: queue().length - state.index } } }
      }
      return { status: 'refused', reason: '未知动作：' + verb }
    },
  })

  skills.register({
    name: SKILL_NAME,
    description: 'Pavo 视频站自动投放循环的启停卡片。',
    whenToUse: '当用户要开始、停止或恢复 Pavo 自动投放循环时使用。',
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
    content: [
      '这是 pavo-auto 插件提供的循环控制技能。',
      '要在聊天里给用户「紧急终止 / 继续」两个按钮时，调用 propose_action：',
      '  action: "pavo_loop"，title: "Pavo 自动投放"，brief: 当前状态一句话，details: { "dryRun": false }。',
      '卡片出现后，插件每完成一轮会自动更新卡片状态；用户点按钮时由插件处理，你不需要再调用工具。',
    ].join('\n'),
  })
  })

  // ---- tools -----------------------------------------------------------
  const textOutput = {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }

  const tool = definition => ctx.tools.register(defineTool(definition))

  tool({
    name: 'pavo_open',
    description: '启动 Pavo 自动化浏览器（持久登录目录）并打开聊天页。首次使用后需在该窗口里手动登录一次。',
    parameters: {},
    output: textOutput,
    async execute() {
      const target = await open()
      const title = await target.title().catch(() => '')
      return { text: `已打开：${title}\nURL: ${target.url()}\n浏览数据目录：${profileDir}` }
    },
  })

  tool({
    name: 'pavo_probe',
    description: '检查当前页面结构：输入框候选、发送按钮文本、video 数量、是否已登录。用于校准自动发送选择器。',
    parameters: {},
    output: textOutput,
    async execute() {
      await launch()
      if (page.url() === 'about:blank') await open()
      const info = await page.evaluate(() => {
        const visible = element => element instanceof HTMLElement
          && element.offsetParent !== null
          && element.getBoundingClientRect().width > 0
        const describe = element => ({
          tag: element.tagName.toLowerCase(),
          id: element.id ?? '',
          cls: String(element.className ?? '').slice(0, 90),
          editable: element.getAttribute('contenteditable') ?? '',
          placeholder: element.getAttribute('placeholder') ?? '',
          role: element.getAttribute('role') ?? '',
          rect: (() => { const r = element.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(),
        })
        return {
          title: document.title,
          url: location.href,
          editables: [...document.querySelectorAll('[contenteditable], textarea, [role="textbox"], input')]
            .filter(visible)
            .map(describe),
          buttons: [...document.querySelectorAll('button, [role="button"]')]
            .filter(visible)
            .map(describe)
            .filter(item => item.rect[1] > window.innerHeight * 0.55),
          videos: [...document.querySelectorAll('video')].map(video => ({
            src: (video.currentSrc || video.src || '').slice(0, 160),
            rect: (() => { const r = video.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(),
          })),
          bodyText: (document.body.innerText ?? '').slice(0, 200),
        }
      })
      info.loggedIn = await loggedIn()
      return { text: JSON.stringify(info, null, 2) }
    },
  })

  tool({
    name: 'pavo_status',
    description: '查看状态：浏览器是否打开、登录态、清单剩余条数、今日已发、循环是否运行。',
    parameters: {},
    output: textOutput,
    async execute() {
      let pageUrl = '未打开'
      let login = '未知'
      try {
        if (page !== undefined) {
          pageUrl = page.url()
          login = (await loggedIn()) ? '已登录（检测到输入框）' : '未登录或页面未就绪'
        }
      } catch {
        login = '页面读取失败'
      }
      const items = queue()
      return {
        text: [
          `页面：${pageUrl}`,
          `登录态：${login}`,
          `清单：${items.length} 条，下一条序号 ${Math.min(state.index + 1, items.length + 1)}`,
          `今日已发：${state.sent} / ${config.dailyLimit}`,
          `循环：${loop.running ? '运行中' : '已停止'}${loop.lastError ? '（最近错误：' + loop.lastError + '）' : ''}`,
          `清单文件：${promptFile}`,
          `日志文件：${logFile}`,
        ].join('\n'),
      }
    },
  })

  tool({
    name: 'pavo_send',
    description: '发送一条提示词：不给 text 时从清单取下一条。dryRun=true 时只检查输入框与按钮，不真正发送。',
    parameters: {
      text: { type: 'string', description: '要发送的文本；省略则取清单下一条' },
      dryRun: { type: 'boolean', description: 'true 时只演练不发送' },
    },
    output: textOutput,
    async execute(args, exec) {
      let text = args.text
      let item
      if (text === undefined || text === '') {
        item = peekPrompt()
        if (item === undefined) return { text: '清单为空或已用完：' + promptFile }
        text = formatPrompt(item.prompt, item.index, item.total)
      }
      const result = await send(text, args.dryRun === true)
      if (!result.ok) return { text: '发送失败：' + result.reason }
      if (args.dryRun === true) {
        return { text: `演练完成：输入框=${result.input}，${result.hasButton ? '有发送按钮' : '没有找到发送按钮（会改用回车）'}` }
      }
      if (item !== undefined) commitPrompt()
      state.sent += 1
      state.lastSentAt = Date.now()
      saveState()
      record({ event: 'sent', prompt: text, manual: true })
      refreshCard(loop.running ? 'running' : 'stopped', { sentToday: state.sent, lastPrompt: text })
      if (exec.agent !== undefined) notify(exec.agent, `【Pavo 自动投放】已发送：${text.slice(0, 80)}`)
      return { text: '已发送：' + text }
    },
  })

  tool({
    name: 'pavo_watch',
    description: '启动/停止自动循环。action=start 时，页面出现新视频就按清单发下一条；action=stop 等同紧急终止。',
    parameters: {
      action: { type: 'string', required: true, description: 'start 或 stop' },
      dryRun: { type: 'boolean', description: '演练模式：只记录不真正发送' },
      stopAfter: { type: 'number', description: '测试用：清单序号发到第 N 段就自动停（0 或不给表示不限）' },
    },
    output: textOutput,
    async execute(args, exec) {
      if (args.action === 'stop') {
        stopLoop('用户停止')
        return { text: '循环已停止' }
      }
      if (args.action !== 'start') return { text: '未知 action：' + args.action }
      const message = startLoop(exec.agent, args.stopAfter ?? 0)
      if (exec.agent !== undefined) findLatestCard(exec.agent)
      return { text: message + '\n清单文件：' + promptFile + (args.stopAfter ? `\n测试上限：发到第 ${args.stopAfter} 段自动停` : '') }
    },
  })

  tool({
    name: 'pavo_type',
    description: '只往输入框里输入文本，不发送。用于校准。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      const target = await composer()
      if (target === undefined) return { text: '没有找到输入框' }
      await target.locator.click()
      await target.locator.fill(args.text).catch(async () => {
        await target.locator.pressSequentially(args.text, { delay: 15 })
      })
      await page.waitForTimeout(500)
      return { text: `已输入到 ${target.selector}` }
    },
  })

  tool({
    name: 'pavo_keys',
    description: '在页面输入框里按一个键（如 Enter / Control+Enter），用于校准发送方式。',
    parameters: {
      key: { type: 'string', required: true, description: '键名，如 Enter' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      const target = await composer()
      if (target === undefined) return { text: '没有找到输入框' }
      await target.locator.press(args.key)
      await page.waitForTimeout(2000)
      return { text: `已按键 ${args.key}` }
    },
  })

  tool({
    name: 'pavo_shot',
    description: '对当前页面截一张图，保存到数据目录并返回路径，便于检查界面。',
    parameters: {
      name: { type: 'string', description: '文件名，默认 shot.png' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      const file = join(dataDir, args.name || 'shot.png')
      await page.screenshot({ path: file, fullPage: false })
      return { text: file }
    },
  })

  tool({
    name: 'pavo_at',
    description: '查看页面某个坐标上的元素结构（调试用）。',
    parameters: {
      x: { type: 'number', required: true, description: 'X 坐标' },
      y: { type: 'number', required: true, description: 'Y 坐标' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      const info = await page.evaluate(({ x, y }) => {
        let element = document.elementFromPoint(x, y)
        const chain = []
        for (let depth = 0; element !== null && depth < 5; depth += 1) {
          chain.push({
            tag: element.tagName.toLowerCase(),
            id: element.id ?? '',
            cls: String(element.className ?? '').slice(0, 90),
            role: element.getAttribute('role') ?? '',
            label: element.getAttribute('aria-label') ?? '',
            text: (element.textContent ?? '').trim().slice(0, 30),
            html: element.outerHTML.slice(0, 160),
          })
          element = element.parentElement
        }
        return chain
      }, { x: args.x, y: args.y })
      return { text: JSON.stringify(info, null, 2) }
    },
  })

  tool({
    name: 'pavo_diag',
    description: '插件自检：actionCards / skills 服务是否已注入，运行时技能是否已注册。',
    parameters: {},
    output: textOutput,
    async execute() {
      const out = {
        actionCardsInjected: actionCards !== undefined,
        skillsInjected: skills !== undefined,
        ctxGetActionCards: ctx.get('actionCards') !== undefined,
        ctxGetSkills: ctx.get('skills') !== undefined,
        skillNames: [],
      }
      try {
        const list = await (skills ?? ctx.get('skills'))?.list({})
        out.skillNames = (list ?? []).map(item => item.name)
      } catch (error) {
        out.skillListError = String(error)
      }
      return { text: JSON.stringify(out, null, 2) }
    },
  })

  tool({
    name: 'pavo_click',
    description: '按 CSS 选择器点击页面元素（调试/校准用）。',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS 选择器' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      const locator = page.locator(args.selector).last()
      if (await locator.count().catch(() => 0) === 0) return { text: '没找到元素：' + args.selector }
      await locator.click()
      await page.waitForTimeout(1200)
      return { text: '已点击 ' + args.selector }
    },
  })

  tool({
    name: 'pavo_settings',
    description: '把生成设置强制为 10 秒 + 16:9 横板，并返回设置按钮上的实际文案。',
    parameters: {},
    output: textOutput,
    async execute() {
      await launch()
      if (page.url() === 'about:blank') await open()
      const result = await ensureSettings()
      return { text: JSON.stringify(result, null, 2) }
    },
  })

  tool({
    name: 'pavo_goto',
    description: '在自动化浏览器里打开任意站内地址（例如回到某个 conversationId）。',
    parameters: {
      url: { type: 'string', required: true, description: '完整 URL' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(1500)
      return { text: page.url() }
    },
  })

  tool({
    name: 'pavo_download',
    description: '用当前浏览器的登录态下载一个视频/图片 URL 到本地路径。',
    parameters: {
      url: { type: 'string', required: true, description: '要下载的完整 URL' },
      out: { type: 'string', required: true, description: '本地保存路径（含文件名）' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      const cookies = await context.cookies('https://app.pavo-ai.cn/').catch(() => [])
      const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ')
      const response = await fetch(args.url, {
        headers: { cookie, referer: 'https://app.pavo-ai.cn/', 'user-agent': await page.evaluate(() => navigator.userAgent) },
      })
      if (!response.ok) return { text: `下载失败：HTTP ${response.status}` }
      const buffer = Buffer.from(await response.arrayBuffer())
      mkdirSync(dirname(args.out), { recursive: true })
      writeFileSync(args.out, buffer)
      return { text: `已保存 ${args.out}（${buffer.length} 字节）` }
    },
  })

  tool({
    name: 'pavo_eval',
    description: '在页面里执行一段 JS 并返回结果（调试/探测用）。',
    parameters: {
      expression: { type: 'string', required: true, description: '要执行的表达式或函数体' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      const value = await page.evaluate(source => {
        try {
          // eslint-disable-next-line no-new-func
          return JSON.parse(JSON.stringify(new Function('return (' + source + ')')()))
        } catch (error) {
          return { error: String(error) }
        }
      }, args.expression)
      return { text: JSON.stringify(value, null, 2) }
    },
  })

  tool({
    name: 'pavo_mode',
    description: '切换参考模式：全能模式 或 首尾帧。',
    parameters: {
      mode: { type: 'string', required: true, description: '全能模式 或 首尾帧' },
    },
    output: textOutput,
    async execute(args) {
      await launch()
      if (page.url() === 'about:blank') await open()
      const result = await setMode(args.mode)
      return { text: JSON.stringify(result, null, 2) }
    },
  })

  tool({
    name: 'pavo_send_frame',
    description: '首尾帧模式发一条：上传本地图片作为首帧（第一个上传框），可选尾帧，再发送提示词。dryRun 只上传不发送。',
    parameters: {
      image: { type: 'string', required: true, description: '首帧图片的本地路径' },
      tail: { type: 'string', description: '尾帧图片路径（可选）' },
      prompt: { type: 'string', description: '提示词；省略则取清单下一条' },
      dryRun: { type: 'boolean', description: 'true 时只上传不发送' },
    },
    output: textOutput,
    async execute(args, exec) {
      await launch()
      if (page.url() === 'about:blank') await open()
      const mode = await setMode('首尾帧')
      if (!mode.ok) return { text: '切换首尾帧失败：' + mode.reason }
      const settings = await ensureSettings()
      if (!settings.ok) return { text: '设置失败：' + settings.reason }
      await closeSettings()
      const inputs = page.locator('input[type="file"]')
      const count = await inputs.count().catch(() => 0)
      if (count === 0) return { text: '没有找到首帧上传框' }
      await inputs.nth(0).setInputFiles(args.image)
      await page.waitForTimeout(2500)
      if (args.tail !== undefined && args.tail !== '' && count > 1) {
        await inputs.nth(1).setInputFiles(args.tail)
        await page.waitForTimeout(2500)
      }
      const previews = await page.evaluate(() => document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length)
      if (args.dryRun === true) {
        return { text: JSON.stringify({ uploaded: args.image, tail: args.tail ?? null, previews, mode: mode.mode, pill: settings.pill }, null, 2) }
      }
      let text = args.prompt
      let item
      if (text === undefined || text === '') {
        item = peekPrompt()
        if (item === undefined) return { text: '清单为空或已用完：' + promptFile }
        text = formatPrompt(item.prompt, item.index, item.total)
      }
      const target = await composer()
      if (target === undefined) return { text: '没有找到输入框' }
      const deadline = Date.now() + 900000
      for (;;) {
        const state = await sendButtonState()
        if (!state.found) return { text: '没有找到发送按钮' }
        if (!state.stop) break
        if (Date.now() > deadline) return { text: '页面仍在生成中，未发送' }
        await page.waitForTimeout(4000)
      }
      await target.locator.click()
      await target.locator.fill(text).catch(async () => {
        await target.locator.pressSequentially(text, { delay: 15 })
      })
      await page.waitForTimeout(500)
      const ready = await sendButtonState()
      if (!ready.found || ready.stop) return { text: '发送按钮不可用' }
      try {
        await ready.button.click({ timeout: 15000 })
      } catch (error) {
        return { text: '点击发送失败：' + String(error) }
      }
      await page.waitForTimeout(2000)
      if (item !== undefined) commitPrompt()
      state.sent += 1
      state.lastSentAt = Date.now()
      saveState()
      record({ event: 'sent', prompt: text, firstFrame: args.image, tailFrame: args.tail ?? null, manual: true })
      refreshCard(loop.running ? 'running' : 'stopped', { sentToday: state.sent, lastPrompt: text })
      if (exec.agent !== undefined) notify(exec.agent, `【Pavo 自动投放】首帧模式已发送（今日第 ${state.sent} 条）：${text.slice(0, 60)}`)
      return { text: '已发送（首帧 ' + args.image + '）' }
    },
  })

  tool({
    name: 'pavo_log',
    description: '查看最近的发送记录（默认 10 条）。',
    parameters: {
      limit: { type: 'number', description: '条数，默认 10' },
    },
    output: textOutput,
    async execute(args) {
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
      try {
        if (!existsSync(logFile)) return { text: '还没有记录：' + logFile }
        const lines = readFileSync(logFile, 'utf8').trim().split('\n').slice(-limit)
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: '读取日志失败：' + String(error) }
      }
    },
  })

  // ---- 全量流水线：按 segments.json 顺序生成、下载、抽末帧 -----------------
  const segmentsFile = () => config.segmentsFile || join(dataDir, 'segments.json')
  const clipsDir = () => config.clipsDir || join(dataDir, 'clips')
  const framesDir = () => config.framesDir || join(dataDir, 'frames')
  const ffmpegBin = () => config.ffmpegPath || 'ffmpeg'
  /** 成片按 1、2、3… 命名（不带前导零）。 */
  const clipName = id => String(Number(id)) + '.mp4'

  const pipeline = { running: false, timer: null, current: 0, failures: 0, limit: 0 }
  const pipelineFile = join(dataDir, 'pipeline.json')
  const loadPipeline = () => {
    const saved = readJson(pipelineFile, { current: 0 })
    pipeline.current = Math.min(Math.max(saved.current ?? 0, 0), 59)
  }
  const savePipeline = () => {
    try {
      writeFileSync(pipelineFile, JSON.stringify({ current: pipeline.current }, null, 2))
    } catch {
      /* ignore */
    }
  }
  loadPipeline()

  const loadSegments = () => {
    try {
      return JSON.parse(readFileSync(segmentsFile(), 'utf8'))
    } catch (error) {
      ctx.logger.warn('pavo-auto: cannot read segments: %s', String(error))
      return []
    }
  }

  const extractLastFrame = (video, out) => {
    mkdirSync(dirname(out), { recursive: true })
    for (const offset of ['0.3', '0.15', '0.5']) {
      spawnSync(ffmpegBin(), ['-v', 'error', '-y', '-sseof', '-' + offset, '-i', video, '-frames:v', '1', out], { timeout: 120000 })
      if (existsSync(out)) return true
    }
    return false
  }

  const downloadClip = async (src, out) => {
    const cookies = await context.cookies('https://app.pavo-ai.cn/').catch(() => [])
    const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ')
    const response = await fetch(src, {
      headers: { cookie, referer: 'https://app.pavo-ai.cn/', 'user-agent': await page.evaluate(() => navigator.userAgent) },
    })
    if (!response.ok) throw new Error('下载失败 HTTP ' + response.status)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, Buffer.from(await response.arrayBuffer()))
  }

  /** Ensure the composer is in 视频生成 mode (not 图片生成/剧情短片). */
  const ensureCreateMode = async () => {
    const pill = page.locator('.ant-select-selection-item').filter({ hasText: /视频生成|图片生成|剧情短片/ }).first()
    if (await pill.count().catch(() => 0) === 0) return false
    await pill.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await pill.innerText().catch(() => '')).includes('视频生成')) return true
      await pill.click({ force: true }).catch(() => {})
      await page.waitForTimeout(600)
      const option = page.locator('.ant-select-item').filter({ hasText: '视频生成' }).first()
      await option.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
      if (await option.count().catch(() => 0) > 0) await option.click({ force: true }).catch(() => {})
      await page.waitForTimeout(900)
    }
    return (await pill.innerText().catch(() => '')).includes('视频生成')
  }

  /** Start a genuinely empty conversation: verify the URL loses its conversationId and no video remains. */
  const newConversation = async () => {
    await launch()
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(1500)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = page.url()
      const button = page.getByText('新作品', { exact: true }).first()
      if (await button.count().catch(() => 0) === 0) break
      await button.click().catch(() => {})
      await page.waitForTimeout(2500)
      const after = page.url()
      const empty = (await videos()).length === 0
      if (empty && (after !== before || !after.includes('conversationId'))) return true
    }
    return (await videos()).length === 0
  }

  const waitNewVideo = async (seen, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const text = await page.evaluate(() => document.body.innerText ?? '').catch(() => '')
      if (text.includes('生成失败')) return { failed: true }
      const list = await videos()
      const fresh = list.find(src => !seen.has(src))
      if (fresh !== undefined && text.includes('再次生成')) return { src: fresh }
      await page.waitForTimeout(10000)
    }
    return { timedOut: true }
  }

  const sendWithFrame = async (image, text) => {
    let mode = await setMode('首尾帧')
    if (!mode.ok) return { ok: false, reason: mode.reason }
    let inputs = page.locator('input[type="file"]')
    await inputs.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})
    if (await inputs.count().catch(() => 0) < 2) {
      // 模式切换后上传框可能还没渲染，重新切一次再等
      await setMode('全能模式')
      mode = await setMode('首尾帧')
      if (!mode.ok) return { ok: false, reason: mode.reason }
      inputs = page.locator('input[type="file"]')
      await inputs.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})
    }
    if (await inputs.count().catch(() => 0) < 2) return { ok: false, reason: '首帧上传框未出现（' + (await inputs.count().catch(() => 0)) + ' 个）' }
    const settings = await ensureSettings()
    if (!settings.ok) return { ok: false, reason: settings.reason }
    await closeSettings()
    await inputs.first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {})
    if (await inputs.count().catch(() => 0) === 0) return { ok: false, reason: '没有首帧上传框（模式可能未切换）' }
    await inputs.nth(0).setInputFiles(image)
    await page.waitForTimeout(2500)
    const target = await composer()
    if (target === undefined) return { ok: false, reason: '没有输入框' }
    const deadline = Date.now() + 900000
    for (;;) {
      const state = await sendButtonState()
      if (!state.found) return { ok: false, reason: '没有发送按钮' }
      if (!state.stop) break
      if (Date.now() > deadline) return { ok: false, reason: '生成中，无法发送' }
      await page.waitForTimeout(4000)
    }
    await target.locator.click()
    await target.locator.fill(text).catch(async () => {
      await target.locator.pressSequentially(text, { delay: 15 })
    })
    await page.waitForTimeout(500)
    const ready = await sendButtonState()
    if (!ready.found || ready.stop) return { ok: false, reason: '发送按钮不可用' }
    try {
      await ready.button.click({ timeout: 15000 })
    } catch (error) {
      return { ok: false, reason: '点击失败：' + String(error) }
    }
    await page.waitForTimeout(2500)
    return { ok: true }
  }

  const pipelineStop = (reason) => {
    pipeline.running = false
    if (pipeline.timer !== null) {
      clearTimeout(pipeline.timer)
      pipeline.timer = null
    }
    record({ event: 'pipeline-stop', reason, at: pipeline.current })
    refreshCard('stopped', { reason, sentToday: state.sent })
  }

  const pipelineStep = async (agent) => {
    if (!pipeline.running) return
    const list = loadSegments()
    if (list.length === 0) return pipelineStop('读不到 segments.json')
    if (pipeline.current >= list.length) return pipelineStop('60 段全部完成')
    const segment = list[pipeline.current]
    const clip = join(clipsDir(), clipName(segment.id))
    const frame = join(framesDir(), segment.id + '.png')
    try {
      await launch()
      // 每段都开一个真正空的新会话：/chat 会恢复上次对话，必须先点「新作品」
      const fresh = await newConversation()
      if (!fresh) throw new Error('新会话未就绪（页面仍有旧视频），已中止以免抓错片')
      if (!await ensureCreateMode()) throw new Error('无法切到视频生成模式')
      if (!existsSync(clip)) {
        const seen = new Set(await videos())
        let sent
        if (segment.firstFrame === true) {
          const previous = list[pipeline.current - 1]
          const previousFrame = join(framesDir(), previous.id + '.png')
          if (!existsSync(previousFrame)) throw new Error('缺少上一段末帧：' + previousFrame)
          sent = await sendWithFrame(previousFrame, segment.prompt)
        } else {
          await setMode('全能模式')
          sent = await send(segment.prompt, false)
        }
        if (!sent.ok) throw new Error(sent.reason)
        state.sent += 1
        state.lastSentAt = Date.now()
        saveState()
        record({ event: 'pipeline-sent', segment: segment.id, firstFrame: segment.firstFrame === true })
        const result = await waitNewVideo(seen, 1200000)
        if (result.failed === true) throw new Error('站点报生成失败（第 ' + segment.id + ' 段）')
        if (result.src === undefined) throw new Error('等待视频超时（第 ' + segment.id + ' 段）')
        await downloadClip(result.src, clip)
        if (!extractLastFrame(clip, frame)) throw new Error('抽末帧失败（第 ' + segment.id + ' 段）')
        pipeline.failures = 0
        refreshCard('running', { sentToday: state.sent, lastPrompt: '已完成第 ' + segment.id + ' 段' })
        notify(agent, `【Pavo 流水线】第 ${segment.id} 段完成并已下载（今日第 ${state.sent} 条）`)
      } else if (!existsSync(frame)) {
        extractLastFrame(clip, frame)
      }
      pipeline.current += 1
      savePipeline()
      if (pipeline.limit > 0 && pipeline.current >= pipeline.limit) {
        return pipelineStop('达到本次上限（已到第 ' + pipeline.current + ' 段）')
      }
    } catch (error) {
      pipeline.failures += 1
      record({ event: 'pipeline-error', segment: segment.id, reason: String(error) })
      notify(agent, `【Pavo 流水线】第 ${segment.id} 段出错：${String(error).slice(0, 120)}`)
      if (pipeline.failures >= 2) return pipelineStop('连续失败：' + String(error).slice(0, 80))
    }
    if (pipeline.running) {
      pipeline.timer = setTimeout(() => void pipelineStep(agent), 5000)
      if (typeof pipeline.timer.unref === 'function') pipeline.timer.unref()
    }
  }

  tool({
    name: 'pavo_pipeline',
    description: '全量流水线：按 segments.json 顺序生成 60 段；首帧段自动上传上一段末帧；出片自动下载到 clips/ 并抽末帧到 frames/。',
    parameters: {
      action: { type: 'string', required: true, description: 'start 或 stop' },
      stopAfter: { type: 'number', description: '生成到第 N 段就自动停（0 表示全部）' },
      reset: { type: 'boolean', description: 'true 时从第 1 段重新开始' },
    },
    output: textOutput,
    async execute(args, exec) {
      if (args.action === 'stop') {
        pipelineStop('用户停止')
        return { text: '流水线已停止（当前到第 ' + (pipeline.current + 1) + ' 段）' }
      }
      if (args.action !== 'start') return { text: '未知 action' }
      if (args.reset === true) {
        pipeline.current = 0
        savePipeline()
      }
      if (pipeline.running) return { text: '流水线已在运行' }
      const list = loadSegments()
      if (list.length === 0) return { text: '读不到 ' + segmentsFile() }
      pipeline.running = true
      pipeline.failures = 0
      if (args.stopAfter && args.stopAfter > 0) pipeline.limit = args.stopAfter
      else pipeline.limit = 0
      const agent = exec.agent
      record({ event: 'pipeline-start', from: pipeline.current + 1 })
      refreshCard('running', { sentToday: state.sent, lastPrompt: '流水线启动，从第 ' + list[pipeline.current].id + ' 段开始' })
      pipeline.timer = setTimeout(() => void pipelineStep(agent), 2000)
      if (typeof pipeline.timer.unref === 'function') pipeline.timer.unref()
      return { text: `流水线已启动：从第 ${list[pipeline.current].id} 段开始，共 ${list.length} 段\n片段目录：${clipsDir()}\n末帧目录：${framesDir()}` }
    },
  })

  ctx.effect(() => () => {
    stopLoop('插件卸载')
  }, 'pavo-auto: stop loop on unload')
}
