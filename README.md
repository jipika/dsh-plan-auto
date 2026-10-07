<p align="center"><img src="./assets/icon.svg" width="72" alt="dsh-plan-auto"></p>

# dsh-plan-auto

给 DSH 的 plan mode 补两件官方没有的东西：

1. **`enter_plan_mode` 工具** —— 把官方 `/plan` 命令包成模型可调用的 host 工具，复杂任务时 agent 自主进入 session plan mode。
2. **plan review 无人应答自动同意** —— `exit_plan_mode` 弹出的 Plan review 卡片（同意执行 / 讨论）如果 **3 分钟**没人点，自动按下「同意执行」，plan mode 随即退出、agent 开始干活。

## 架构：两个半边，各管一段

```
exit_plan_mode ─► ctx.userQuestions.ask ─► 官方 waterfall ─► api-remotes 桥 ─► Client 弹出 Plan review 卡片
                        ▲                                                          │
                   host 半边包装（兜底）                                  client 半边：到点自动点「同意执行」
```

- **client 半边（主路径，`lib/client.js`）**：每 1 秒扫一次 `[data-plan-review-key]`（官方卡片框架上的稳定属性），首次发现开始计时；窗口到点就**模拟点击卡片里的「同意执行 / Approve」按钮** —— 等价用户亲手点：官方 waterfall 正常结算、**卡片从界面消失**、host 拿到正常答案。
- **host 半边（兜底，`lib/index.js`）**：包装 `ctx.userQuestions.ask`，窗口 = client 窗口 + `fallbackMarginSeconds`（默认 +30s）。只在 client 没点成（页面没开、DOM 变了、脚本没加载）时兜底返回 `Approve`。

**为什么要 client 来点**：那张卡片是 client 自己持有的 pending 请求。host 侧提前返回答案**不会**结束 client 的等待，卡片会一直挂在界面上（v0.2.0 实测：计划已经批准、agent 都在继续干活了，卡片还在）—— 所以真正的「自动同意」只能由点按钮完成。

## 行为细节

| 情况 | 结果 |
| --- | --- |
| 用户 3 分钟内点了 同意执行 / 讨论 / 写反馈 | 完全按用户的选择走（官方行为不变） |
| 3 分钟无人应答 | client 自动点「同意执行」→ 卡片消失、plan mode 退出、agent 执行计划 |
| client 没点成 | host 在 3 分钟 + 30 秒兜底返回 Approve（功能仍生效，但卡片会残留，点掉即可） |
| `ask_user_question`（普通提问） | 完全不掺和，原样透传 |
| 关掉开关 | 完全退回官方行为：一直等用户点卡片 |

## 配置

优先级：环境变量 > 配置文件 > 默认。host 每次请求现读；client 每 30 秒从 `GET /dsh-plan-auto/config` 拉一次。

```bash
DSH_PLAN_AUTO_APPROVE_SECONDS=30            # client 自动点击窗口（0 = 关闭自动同意）
DSH_PLAN_AUTO_FALLBACK_MARGIN_SECONDS=30    # host 兜底相对 client 的余量
```

```jsonc
// ~/.dsh/plugin-config/dsh-plan-auto.json —— 改完即时生效（client 最迟 30s 跟上）
{ "approveAfterSeconds": 180, "fallbackMarginSeconds": 30, "enabled": true }
```

诊断：让 agent 调 `plan_auto_status`（返回版本 / 开关 / client 窗口 / host 兜底窗口 / 取值来源），或 `curl http://127.0.0.1:19387/dsh-plan-auto/config`。

## 安装（desktop profile 手工路线）

```bash
# 1) 本地 link
#    package.json dependencies 加 "dsh-plan-auto": "link:../../local-plugins/dsh-plan-auto"
#    并 ln -s ../../../local-plugins/dsh-plan-auto node_modules/dsh-plan-auto

# 2) cordis.patch.yml 顶层加：
# - insert:
#     - id: dsh-plan-auto
#       name: dsh-plan-auto

# 3) 重启宿主生效（host / client 半边的新增与改动都必须重启；disable→enable 不会重读模块）
```

装好后模型工具面多出 `enter_plan_mode` 与 `plan_auto_status`。

## 契约

- **拥有**：工具 `enter_plan_mode`、`plan_auto_status`；只读路由 `GET /dsh-plan-auto/config`；运行时包装 `ctx.userQuestions.ask`（卸载时还原）；client 侧对 `[data-plan-review-key]` 卡片的轮询与点击。
- **冲突时**：与本机其他插件无已知交集；工具名冲突会被 scoped layers 覆盖告警。
- **回滚**：删掉上面三件套后重启即完全移除。

## License

MIT
