// dsh-plan-auto — host 半边
//
// 做什么：注册一个无参数工具 `enter_plan_mode`，内部走官方命令生命周期
// `ctx.commands.execute(agent, '/plan', [], signal)`，等价于用户在输入框敲
// `/plan`：写 command/run 日志 → plan-mode handler → planMode.set(agent, true)
// → plan projection fold → GUI PlanModeControl 亮起。
//
// 为什么 execute 而不是直接 planMode.set()：
//   · execute 走正规命令生命周期（command/run + command/done 落盘），
//     与用户手敲完全一致，plan projection 靠 command/run(name=plan) fold；
//   · 降级路径：commands 服务不存在或 execute 返回 undefined（命令未注册，
//     例如精简 preset 组装树没带 plan-mode）时，若 planMode 服务在，
//     直接 set(agent, true) 兜底。
//
// 服务注入：tools（注册工具）、commands（execute 通道）、planMode（降级开关）。
// 缺哪个都不让 entry 死掉 —— 顶层 inject 缺服务会停在 pending，
// 所以三项都做成可选消费（ctx.get 按需取），顶层只 inject ['tools']。

export const name = "dsh-plan-auto";

export const inject = ["tools"];

export function apply(ctx) {
	// planMode 是否存在，等 apply 时再探（commands/planMode 都不在 inject 名单里）
	const hasPlanMode = () => {
		try { ctx.get("planMode"); return true; } catch { return false; }
	};
	const hasCommands = () => {
		try { ctx.get("commands"); return true; } catch { return false; }
	};

	ctx.effect(
		() =>
			ctx.tools.register({
				name: "enter_plan_mode",
				description:
					"Enter session plan mode before planning a complex task. Once active, plan guidance is injected into each request and you must present the plan via exit_plan_mode for user review before implementing. Use it as the FIRST action when a task is complex (multi-file or architecture-level change, new feature with multiple viable approaches, refactoring, or anything where a wrong path wastes substantial work). Skip it for research, Q&A, writing, documentation, and single-file small changes.",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							text: { type: "string" },
							active: { type: "boolean" },
						},
						required: ["text", "active"],
					},
					render: (_args, value) => [{ type: "text", text: value.text }],
				},
				async execute(args, exec) {
					const agent = exec.agent;
					if (agent === undefined) {
						return { text: "enter_plan_mode requires a calling agent (no session to switch).", active: false };
					}

					// 主路径：正规命令生命周期（与用户手敲 /plan 完全一致）
					if (hasCommands()) {
						try {
							const controller = new AbortController();
							const execution = await ctx.get("commands").execute(
								agent, "/plan", [], controller.signal,
							);
							if (execution !== undefined) {
								const outcome = execution.result;
								const text = outcome.kind === "success"
									? `Plan mode is on${outcome.text ? ` (${outcome.text})` : ""}. Present your plan via exit_plan_mode for user review before implementing.`
									: `enter_plan_mode failed: ${outcome.text ?? outcome.kind}`;
								return { text, active: outcome.kind === "success" };
							}
							// execution === undefined：/plan 命令未注册 → 落降级
						} catch (error) {
							// execute 抛错（如日志 append 失败）→ 尝试降级，否则如实报错
							if (!hasPlanMode()) {
								return { text: `enter_plan_mode: /plan command failed: ${error?.message ?? error}`, active: false };
							}
						}
					}

					// 降级路径：直调 planMode.set（不走命令日志，只写 plan/mode 事件）
					if (hasPlanMode()) {
						try {
							const outcome = ctx.get("planMode").set(agent, true);
							const text = outcome === "noop" || outcome === "committed" || outcome === "queued"
								? `Plan mode is on (${outcome}). Present your plan via exit_plan_mode for user review before implementing.`
								: `enter_plan_mode cancelled: an opposite pending selection was cleared; re-run if needed.`;
							return { text, active: outcome !== "cancelled" };
						} catch (error) {
							return { text: `enter_plan_mode: planMode.set failed: ${error?.message ?? error}`, active: false };
						}
					}

					return { text: "enter_plan_mode: neither commands nor planMode service is composed in this session — plan mode is unavailable. Fall back to presenting the plan in your reply.", active: false };
				},
			}),
		"dsh-plan-auto: enter_plan_mode tool",
	);

	console.log("[dsh-plan-auto] enter_plan_mode tool registered");
}
