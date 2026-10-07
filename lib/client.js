// dsh-plan-auto — browser half
//
// 做什么：给官方的 Plan review 卡片（同意执行 / 讨论）做「3 分钟无人应答自动同意」
// —— 到点后**模拟点击卡片上的「同意执行 / Approve」按钮**，等价用户亲手点：
// 官方 waterfall 正常结算、卡片随之从界面消失、host 侧收到的是正常答案。
//
// 为什么这件事必须由 client 干：那张卡片是 client 自己持有的 pending 请求。
// host 侧无论怎么提前返回答案（v0.2.0 的旧实现），client 的等待都不会结束，
// 卡片就一直挂在界面上（实测：计划已经批准、agent 都在继续干活了，卡片还在）。
// 所以真正的「自动同意」= 点按钮；host 半边只做兜底（窗口 +30s）。
//
// DOM 锚点（官方 0.2.0-rc.2 起）：`[data-plan-review-key]` 是卡片框架上的稳定
// 属性（不随 CSS Modules 改名 —— 实测该字符串在客户端产物里存在）；批准按钮 =
// 卡片里文本匹配 `plan.approve` 文案（中文「同意执行」/ 英文「Approve」）的
// <button>；取不到就退化为卡片内最后一个 button（官方结构：讨论在前、批准在后）。
//
// 窗口：读 host 的只读路由 GET /dsh-plan-auto/config（与配置文件同一来源），
// 每 30s 刷新；读不到就退回默认 180s。
window.__ModuleLoader__.load({
	id: "dsh-plan-auto",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const CONFIG_URL = "/dsh-plan-auto/config";
		const DEFAULT_SECONDS = 180;
		const REFRESH_MS = 30_000;
		const TICK_MS = 1000;

		/** 官方 locales 里 plan.approve 的两种文案（zh / en）。 */
		const APPROVE_TEXTS = ["同意执行", "Approve"];

		let policy = { enabled: true, approveAfterSeconds: DEFAULT_SECONDS };
		/** data-plan-review-key -> 首次出现时刻。 */
		const seen = new Map();

		const refreshPolicy = async () => {
			try {
				const res = await fetch(CONFIG_URL, { headers: { accept: "application/json" }, cache: "no-store" });
				if (!res.ok) return;
				const data = await res.json();
				const seconds = Number(data && data.approveAfterSeconds);
				policy = {
					enabled: !(data && data.enabled === false),
					approveAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SECONDS,
				};
			} catch {
				/* host 路由不可用（旧版本 / 别的 profile）→ 保持当前策略 */
			}
		};

		const approveButtonOf = (frame) => {
			const buttons = Array.from(frame.querySelectorAll("button"));
			const named = buttons.find((button) => {
				const text = (button.textContent || "").trim();
				return APPROVE_TEXTS.some(needle => text === needle || text.includes(needle));
			});
			return named || buttons[buttons.length - 1];
		};

		const tick = () => {
			const frames = Array.from(document.querySelectorAll("[data-plan-review-key]"));
			if (frames.length === 0) {
				seen.clear();
				return;
			}
			const now = Date.now();
			for (const frame of frames) {
				const key = frame.getAttribute("data-plan-review-key") || "";
				if (!seen.has(key)) {
					seen.set(key, now);
					console.log(`[dsh-plan-auto] plan review 已出现（key=${key}）：${policy.approveAfterSeconds}s 无人应答将自动点「同意执行」`);
				}
				if (!policy.enabled) continue;
				if (now - (seen.get(key) || now) < policy.approveAfterSeconds * 1000) continue;
				const button = approveButtonOf(frame);
				if (!button || button.disabled) continue;
				seen.delete(key);
				console.log("[dsh-plan-auto] 窗口内无人应答 → 自动点「同意执行」");
				button.click();
			}
		};

		let tickTimer;
		let refreshTimer;
		let started = false;

		exports.name = "dsh-plan-auto";
		exports.apply = (ctx) => {
			// 客户端模块 id 撞车会抛错并中断同批注册 —— 自己先挡一道。
			if (window.__dshPlanAutoRegistered === true || started) return;
			started = true;
			window.__dshPlanAutoRegistered = true;
			void refreshPolicy();
			refreshTimer = setInterval(() => { void refreshPolicy(); }, REFRESH_MS);
			tickTimer = setInterval(tick, TICK_MS);
			const stop = () => {
				clearInterval(tickTimer);
				clearInterval(refreshTimer);
			};
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(() => stop, "dsh-plan-auto: plan review auto click");
			}
			console.log(`[dsh-plan-auto] client half ready：每 ${TICK_MS / 1000}s 扫一次 Plan review 卡片`);
		};

		/** 离线测试与页面调试句柄。 */
		exports.__internal = {
			approveButtonOf,
			tick,
			refreshPolicy,
			getPolicy: () => policy,
			setPolicy: (next) => { policy = next },
		};

		return module.exports;
	}
});
