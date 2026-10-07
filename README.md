<p align="center"><img src="./assets/icon.svg" width="72" alt="dsh-plan-auto"></p>

# dsh-plan-auto

给 DSH 的 plan mode 补两件官方没有的东西：

1. **`enter_plan_mode` 工具** —— 把官方 `/plan` 命令包成模型可调用的 host 工具，复杂任务时 agent 自主进入 session plan mode。
2. **plan review 无人应答自动同意（v0.2.0）** —— `exit_plan_mode` 弹出的 Plan review 卡片（Approve / Keep planning）如果 **3 分钟**没人点，自动按 `Approve` 执行；期间用户点了就照用户的走（包括 Keep planning 和自定义反馈）。

## 行为细节

| 情况 | 结果 |
| --- | --- |
| 用户 3 分钟内点 Approve / Keep planning / 写反馈 | 完全按用户的选择走（官方行为不变） |
| 3 分钟无人应答 | 返回 `Approve`，退出 plan mode，agent 从下一步开始执行计划 |
| `ask_user_question`（普通提问，非 plan review） | 完全不掺和，原样透传 |
| 无 UI / 桥不存在（headless 等） | 下游的真实错误原样上抛（fail fast，官方行为不变） |
| 关掉开关（见下） | 完全退回官方行为：一直等用户点卡片 |

超时发生时宿主日志里会留两行 `[dsh-plan-auto] …`（发出 / 自动同意），Console 里也能看到。

## 配置

优先级：环境变量 > 配置文件 > 默认 180 秒。

```bash
# 环境变量（进程级，宿主启动时读）
DSH_PLAN_AUTO_APPROVE_SECONDS=30      # 30 秒；0 = 关闭自动同意
```

```jsonc
// ~/.dsh/plugin-config/dsh-plan-auto.json —— 每次 plan review 现读，改完即时生效
{ "approveAfterSeconds": 180, "enabled": true }
```

诊断：让 agent 调 `plan_auto_status` 工具，返回版本、是否启用、超时秒数与取值来源。

## 原理

- **`enter_plan_mode` 主路径**：execute 内走 `commands.execute(agent, '/plan', [], signal)` 正规命令生命周期——与用户手敲 `/plan` 完全一致（写 `command/run` 日志 → plan-mode handler → `planMode.set(agent, true)` → plan projection fold）；`commands` 缺失时降级直调 `planMode.set`。
- **自动同意**：`ctx.inject(['userQuestions'], …)` 等 `ctx.userQuestions` 就位后**包装服务的 `ask` 方法**（plan review 的唯一入口，`exit_plan_mode` 走的就是它）：
  - 非 plan review 请求 → 直接调用原实现；
  - plan review → 原实现（waterfall → `dsh-api-remotes` 桥 → Client 的 Plan review 卡片）与定时器 `Promise.race`，下游先 settle 用下游的答案，定时器先到就返回 `{ answers: [{ id: 'plan-review', selected: ['Approve'] }] }`；超时后下游再 settle 一律吞掉（避免 unhandled rejection，卡片残留在界面上属正常，再点无效）。
- 顶层只 `inject: ['tools']`，`commands` / `planMode` / `userQuestions` 都按需探测——避免缺服务的组装树上 entry 卡在 pending。

### 为什么不用 `ctx.on('user-questions/request', …, { prepend: true })`

这是最初的做法（waterfall 最外层拦截），在探针 profile 上实测**不可靠**：插件 `apply()` 期间 `ctx.events` 解析到的 `EventsService` 实例，与 boot 完成后服务/agent 实际使用的那个不是同一个——apply 时注册进表里的监听器，3 秒后在同一 ctx 里连自己都查不到（同一张表上自证监听器计数 `1 → 0`）。也就是说 profile 插件早期的 `ctx.on` 注册会落在一张会被丢弃的表上。包装服务方法没有这个时序问题，而且「晚包装者在外层」，天然拿到最外层位置。

## 安装（desktop profile 手工路线）

```bash
# 1) npm 包型安装
cd ~/.dsh/profiles/desktop && pnpm add dsh-plan-auto
# 或本地 link（便于改码）
# package.json dependencies 加 "dsh-plan-auto": "link:../../local-plugins/dsh-plan-auto"
#   并 ln -s ../../../local-plugins/dsh-plan-auto node_modules/dsh-plan-auto

# 2) cordis.patch.yml 顶层加：
# - insert:
#     - id: dsh-plan-auto
#       name: dsh-plan-auto

# 3) 重启宿主生效（host 插件改动必须重启，disable→enable 不会重读模块）
```

装好后模型工具面多出 `enter_plan_mode` 与 `plan_auto_status`。配合 `~/.dsh/AGENTS.md` 规划纪律（复杂任务第一个动作调它）即可全自动进 plan mode。

## 契约

- **拥有**：工具 `enter_plan_mode`（无参数）、`plan_auto_status`（无参数）；运行时包装 `ctx.userQuestions.ask`（卸载时还原）。
- **冲突时**：与本机其他插件无已知交集；工具名冲突会被 scoped layers 覆盖告警。
- **回滚**：删掉上面三件套（package.json dependency / cordis.patch.yml insert / node_modules 链接）后重启即完全移除。

## License

MIT
