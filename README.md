<p align="center"><img src="./assets/icon.svg" width="72" alt="dsh-plan-auto"></p>

# dsh-plan-auto

把官方 `/plan` 命令包成模型可调用的 host 工具 **`enter_plan_mode`**：复杂任务时 agent 自主进入 session plan mode，再经官方 `exit_plan_mode` 提交计划等用户批准——GUI 出正式的 Plan review 卡片（Approve / Keep planning），批准即退出 plan mode 并从下一步开始执行。

## 原理

- **主路径**：execute 内走 `commands.execute(agent, '/plan', [], signal)` 正规命令生命周期——与用户在输入框手敲 `/plan` 完全一致（写 `command/run` 日志 → plan-mode handler → `planMode.set(agent, true)` → plan projection fold）。
- **降级**：`commands` 服务不存在或 `/plan` 未注册时，直调 `planMode.set(agent, true)`；两个服务都不在则工具返回提示，模型回落「回复里贴计划」。
- 顶层只 `inject: ['tools']`，`commands` / `planMode` 用 `ctx.get` 按需探测——避免缺服务的组装树上 entry 卡在 pending。

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

# 3) 重启宿主生效
```

装好后模型工具面多出 `enter_plan_mode`（无参数）。配合 `~/.dsh/AGENTS.md` 规划纪律（复杂任务第一个动作调它）即可全自动进 plan mode。

## 契约

- **拥有**：工具 `enter_plan_mode`（无参数）；不改任何宿主行为、不 patch 其他插件。
- **冲突时**：与本机其他插件无已知交集；工具名冲突会被 scoped layers 覆盖告警。
- **回滚**：删掉上面三件套（package.json dependency / cordis.patch.yml insert / node_modules 链接）后重启即完全移除。

## License

MIT
