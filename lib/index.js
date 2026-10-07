// dsh-plan-auto — host 半边
//
// 两件事：
// ① 注册无参数工具 `enter_plan_mode`，内部走官方命令生命周期
//    `ctx.commands.execute(agent, '/plan', [], signal)`，等价于用户敲 `/plan`：
//    写 command/run 日志 → plan-mode handler → planMode.set(agent, true)
//    → plan projection fold → GUI PlanModeControl 亮起。
// ② **plan review 无人应答自动同意**：在 `user-questions/request` waterfall 上
//    prepend 一个最外层 handler，只对 `intent.kind === 'plan-review'` 的请求生效：
//    先把请求交给下游（也就是正常弹 GUI Plan review 卡片），同时起一个定时器；
//    谁先到用谁 —— 用户在窗口内点了 Approve / Keep planning 就照用户的走，
//    超时无人应答就返回 { id:'plan-review', selected:['Approve'] } 自动同意执行。
//
// 为什么能插到最外层：cordis 的 waterfall = `_hooks[event]` 单列表顺序调用
// （events.ts: `cb = cbs.shift() ?? inner`），`on(..., { prepend: true })`
// 即成为第一个 handler；scopeTarget 的 filter 对「无 scope tag 的 ctx」
// 一律放行（packages/core/scope/src/index.ts），所以插件 ctx 注册的全局
// 监听器在 agent-scoped waterfall 里照样在最外层被执行。
//
// 服务注入：tools（注册工具）。commands / planMode 全走 ctx.get 按需探测
// —— 顶层 inject 列了宿主组装树里没有的服务会让整条 entry 卡 pending。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-plan-auto'

export const inject = ['tools']

/** 官方 plan-mode 的常量（packages/plan/plan-mode/src/index.ts）。 */
const PLAN_REVIEW_ID = 'plan-review'
const PLAN_REVIEW_APPROVE = 'Approve'
const PLAN_REVIEW_KIND = 'plan-review'

/** 默认：3 分钟无人应答即自动同意。 */
const DEFAULT_APPROVE_AFTER_SECONDS = 180

/**
 * host 兜底相对 client 自动点击的余量（秒）。
 *
 * 正常路径 = **client 半边**在 approveAfterSeconds 到点后模拟点击官方卡片上的
 * 「同意执行 / Approve」按钮 —— 那才是一次真正的用户级提交：官方 waterfall 结算、
 * 卡片随之从界面消失、host 侧拿到的是正常答案。
 * 本文件的 ask 包装只在 client 没点成（页面没开、DOM 变了、脚本没加载）时兜底，
 * 所以窗口比 client 晚这么多；两者都生效也不冲突（同一个 approve）。
 */
const FALLBACK_MARGIN_SECONDS = 30

/** 配置文件：每次请求现读，改完即时生效（无需重启）。 */
const CONFIG_PATH = join(homedir(), '.dsh', 'plugin-config', 'dsh-plan-auto.json')

/** client 半边读取倒计时窗口的只读路由前缀。 */
const ROUTE = '/dsh-plan-auto'

/** 超时哨兵。 */
const TIMEOUT = Symbol('plan-auto-timeout')

function positiveNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readConfigFile() {
	if (!existsSync(CONFIG_PATH)) return {}
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
		return parsed !== null && typeof parsed === 'object' ? parsed : {}
	} catch {
		return {}
	}
}

/**
 * 解析当前生效的自动同意策略。
 * 优先级：环境变量 DSH_PLAN_AUTO_APPROVE_SECONDS > 配置文件 > 默认 180s。
 * approveAfterSeconds <= 0 / enabled === false 视为关闭（保持官方行为：
 * 一直等用户点卡片）。fallbackMarginSeconds = host 兜底相对 client 点击的余量，
 * 可用 env `DSH_PLAN_AUTO_FALLBACK_MARGIN_SECONDS` 或 config `fallbackMarginSeconds`
 * 覆盖（默认 30s；0 表示与 client 同刻兜底）。
 * @returns {{ enabled: boolean, approveAfterSeconds: number, fallbackMarginSeconds: number, source: string }}
 */
function resolvePolicy() {
	const file = readConfigFile()
	const envMargin = Number(process.env.DSH_PLAN_AUTO_FALLBACK_MARGIN_SECONDS)
	const fileMargin = file.fallbackMarginSeconds
	const margin = Number.isFinite(envMargin) && envMargin >= 0
		? envMargin
		: (typeof fileMargin === 'number' && Number.isFinite(fileMargin) && fileMargin >= 0 ? fileMargin : FALLBACK_MARGIN_SECONDS)
	const env = process.env.DSH_PLAN_AUTO_APPROVE_SECONDS
	if (env !== undefined && env !== '') {
		const seconds = Number(env)
		if (Number.isFinite(seconds)) {
			return {
				enabled: seconds > 0,
				approveAfterSeconds: seconds > 0 ? seconds : 0,
				fallbackMarginSeconds: margin,
				source: 'env:DSH_PLAN_AUTO_APPROVE_SECONDS',
			}
		}
	}
	if (file.enabled === false) {
		return { enabled: false, approveAfterSeconds: 0, fallbackMarginSeconds: margin, source: 'config:enabled=false' }
	}
	const configured = positiveNumber(file.approveAfterSeconds)
	if (configured !== undefined) {
		return { enabled: true, approveAfterSeconds: configured, fallbackMarginSeconds: margin, source: 'config' }
	}
	return {
		enabled: true,
		approveAfterSeconds: DEFAULT_APPROVE_AFTER_SECONDS,
		fallbackMarginSeconds: margin,
		source: 'default',
	}
}

/** 请求是否是 plan-mode 的 Plan review（只有它带 intent.kind === 'plan-review'）。 */
function isPlanReviewRequest(request) {
	const questions = request?.questions
	if (!Array.isArray(questions)) return false
	return questions.some(question => question?.intent?.kind === PLAN_REVIEW_KIND)
}

export function apply(ctx) {
	const log = (message) => {
		console.log(`[dsh-plan-auto] ${message}`)
	}

	// —— ① enter_plan_mode 工具（原有能力） ——
	const hasPlanMode = () => {
		try { ctx.get('planMode'); return true } catch { return false }
	}
	const hasCommands = () => {
		try { ctx.get('commands'); return true } catch { return false }
	}

	ctx.effect(
		() =>
			ctx.tools.register({
				name: 'enter_plan_mode',
				description:
					'Enter session plan mode before planning a complex task. Once active, plan guidance is injected into each request and you must present the plan via exit_plan_mode for user review before implementing. Use it as the FIRST action when a task is complex (multi-file or architecture-level change, new feature with multiple viable approaches, refactoring, or anything where a wrong path wastes substantial work). Skip it for research, Q&A, writing, documentation, and single-file small changes.',
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				output: {
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							text: { type: 'string' },
							active: { type: 'boolean' },
						},
						required: ['text', 'active'],
					},
					render: (_args, value) => [{ type: 'text', text: value.text }],
				},
				async execute(args, exec) {
					const agent = exec.agent
					if (agent === undefined) {
						return { text: 'enter_plan_mode requires a calling agent (no session to switch).', active: false }
					}

					// 主路径：正规命令生命周期（与用户手敲 /plan 完全一致）
					if (hasCommands()) {
						try {
							const controller = new AbortController()
							const execution = await ctx.get('commands').execute(
								agent, '/plan', [], controller.signal,
							)
							if (execution !== undefined) {
								const outcome = execution.result
								const text = outcome.kind === 'success'
									? `Plan mode is on${outcome.text ? ` (${outcome.text})` : ''}. Present your plan via exit_plan_mode for user review before implementing.`
									: `enter_plan_mode failed: ${outcome.text ?? outcome.kind}`
								return { text, active: outcome.kind === 'success' }
							}
							// execution === undefined：/plan 命令未注册 → 落降级
						} catch (error) {
							// execute 抛错（如日志 append 失败）→ 尝试降级，否则如实报错
							if (!hasPlanMode()) {
								return { text: `enter_plan_mode: /plan command failed: ${error?.message ?? error}`, active: false }
							}
						}
					}

					// 降级路径：直调 planMode.set（不走命令日志，只写 plan/mode 事件）
					if (hasPlanMode()) {
						try {
							const outcome = ctx.get('planMode').set(agent, true)
							const text = outcome === 'noop' || outcome === 'committed' || outcome === 'queued'
								? `Plan mode is on (${outcome}). Present your plan via exit_plan_mode for user review before implementing.`
								: 'enter_plan_mode cancelled: an opposite pending selection was cleared; re-run if needed.'
							return { text, active: outcome !== 'cancelled' }
						} catch (error) {
							return { text: `enter_plan_mode: planMode.set failed: ${error?.message ?? error}`, active: false }
						}
					}

					return { text: 'enter_plan_mode: neither commands nor planMode service is composed in this session — plan mode is unavailable. Fall back to presenting the plan in your reply.', active: false }
				},
			}),
		'dsh-plan-auto: enter_plan_mode tool',
	)

	// —— ② plan review 超时自动同意：包装 ctx.userQuestions.ask ——
	//
	// 为什么不用 `ctx.on('user-questions/request', …, { prepend: true })`：
	// 探针实测（planprobe profile，0.2.0-rc.2 headless）——插件 apply 期间
	// `ctx.events` 解析到的 EventsService 实例，与 boot 完成后服务/agent 实际
	// 使用的那一个不是同一个：apply 时注册进去的监听器，3 秒后在同一 ctx 里
	// 连自己都查不到（自证链在同一张表上的计数 1 → 0），于是注册等于白做。
	// 包装服务方法没有这个时序问题：`ask` 是 plan review 的唯一入口
	// （exit_plan_mode 走的就是它），而且晚包装者在外层，天然拿到最外层位置。
	ctx.inject(['userQuestions'], (serviceCtx) => {
		let service
		try { service = serviceCtx.get('userQuestions') } catch { service = undefined }
		if (service === undefined || typeof service.ask !== 'function') {
			log('userQuestions 服务不可用，plan review 自动同意未启用')
			return
		}
		const originalAsk = service.ask
		const wrappedAsk = async function (request) {
			const policy = resolvePolicy()
			if (!policy.enabled || !isPlanReviewRequest(request)) return originalAsk.call(this, request)
			const hostWindowSeconds = policy.approveAfterSeconds + policy.fallbackMarginSeconds
			let timer
			const timeout = new Promise(resolve => {
				timer = setTimeout(() => resolve(TIMEOUT), hostWindowSeconds * 1000)
			})
			// 下游 = 官方仲裁链（waterfall → api-remotes 桥 → Client 的 Plan review 卡片）
			const downstream = Promise.resolve().then(() => originalAsk.call(this, request))
			// 超时后下游仍可能 settle（用户后来才点卡片），一律吞掉，避免 unhandled rejection
			downstream.catch(() => {})
			log(`plan review 已发出：client 应在 ${policy.approveAfterSeconds}s 自动点「同意执行」，host 兜底 ${hostWindowSeconds}s（来源：${policy.source}）`)
			try {
				const winner = await Promise.race([downstream, timeout])
				if (winner === TIMEOUT) {
					log(`plan review 超过 ${hostWindowSeconds}s 仍未结算（${policy.source}）→ host 兜底自动同意执行`)
					return { answers: [{ id: PLAN_REVIEW_ID, selected: [PLAN_REVIEW_APPROVE] }] }
				}
				return winner
			} finally {
				clearTimeout(timer)
			}
		}
		service.ask = wrappedAsk
		const policy = resolvePolicy()
		log(`userQuestions.ask 已包装：plan review 自动同意 ${policy.enabled ? `on（${policy.approveAfterSeconds}s，${policy.source}）` : 'off'}`)
		return () => {
			if (service.ask === wrappedAsk) service.ask = originalAsk
		}
	})

	// —— ③ 诊断工具：确认新代码已在运行 + 当前策略 ——
	ctx.effect(
		() =>
			ctx.tools.register({
				name: 'plan_auto_status',
				description:
					'Report the dsh-plan-auto runtime state: plugin version, whether plan-review auto-approval is enabled, the timeout in seconds, and where that value came from. Use it to verify the plugin is loaded and which policy is in force.',
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				output: {
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							text: { type: 'string' },
							version: { type: 'string' },
							enabled: { type: 'boolean' },
							approveAfterSeconds: { type: 'number' },
							source: { type: 'string' },
							configPath: { type: 'string' },
						},
						required: ['text', 'version', 'enabled', 'approveAfterSeconds', 'source', 'configPath'],
					},
					render: (_args, value) => [{ type: 'text', text: value.text }],
				},
				execute() {
					const policy = resolvePolicy()
					const version = '0.2.1'
					const hostWindow = policy.approveAfterSeconds + policy.fallbackMarginSeconds
					const text = policy.enabled
						? `dsh-plan-auto ${version}: 已启用 —— client 侧倒计时 ${policy.approveAfterSeconds}s 到点自动点「同意执行」（卡片随之消失），host 侧 ${hostWindow}s 兜底（来源：${policy.source}；配置：${CONFIG_PATH}）`
						: `dsh-plan-auto ${version}: 自动同意已关闭（来源：${policy.source}），plan review 会一直等用户点卡片`
					return { text, version, enabled: policy.enabled, approveAfterSeconds: policy.approveAfterSeconds, source: policy.source, configPath: CONFIG_PATH }
				},
			}),
		'dsh-plan-auto: plan_auto_status tool',
	)

	// —— ④ 配置路由：client 半边从这里读倒计时窗口 ——
	// 前缀路由不在 host 鉴权网关后面，但只绑定回环地址，且只回一个只读的 JSON。
	ctx.inject(['webServer'], (wctx) => {
		ctx.effect(
			() =>
				wctx.webServer.register({
					kind: 'prefix',
					path: ROUTE,
					handler: (req, res) => {
						const pathname = (req.url ?? '').split('?')[0]
						if (req.method === 'GET' && (pathname === `${ROUTE}/config` || pathname === ROUTE)) {
							const policy = resolvePolicy()
							res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
							res.end(JSON.stringify({
								version: '0.2.1',
								enabled: policy.enabled,
								approveAfterSeconds: policy.approveAfterSeconds,
								fallbackMarginSeconds: policy.fallbackMarginSeconds,
								hostFallbackSeconds: policy.approveAfterSeconds + policy.fallbackMarginSeconds,
								source: policy.source,
							}))
							return
						}
						res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
						res.end('{"error":"not found"}')
					},
				}),
			'dsh-plan-auto: config route',
		)
	})

	log('loaded: enter_plan_mode + plan_auto_status + client-driven auto-approve（client 到点点按钮，host 兜底 +margin）')
}
