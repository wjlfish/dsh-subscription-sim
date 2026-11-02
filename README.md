# 订阅额度模拟器（dsh-subscription-sim）

![tests](https://github.com/wjlfish/dsh-subscription-sim/actions/workflows/ci.yml/badge.svg)

给 DeepSeek 假装一个「订阅制」，并且**把 OpenAI ChatGPT 和 Anthropic Claude 两家的档位分开模拟**：
每家一套独立订阅档位，额度用完之后模型请求会真的报错；你可以给自己派发「重置卡」立刻恢复。

> 所有额度与价格都是本机模拟的娱乐设定，**不改变 DeepSeek 的真实计费，也不会真的扣费**。

## 两套订阅（额度为模拟值）

**Anthropic Claude**（5 小时会话额度 + 每周额度）

| 档位 | 价格 | 5 小时窗口 | 7 天窗口 |
| --- | --- | --- | --- |
| Free | $0 | 150,000 | 1,000,000 |
| Pro | $20/月 | 2,000,000 | 20,000,000 |
| Max 5× | $100/月 | 8,000,000 | 80,000,000 |
| Max 20×（默认） | $200/月 | 30,000,000 | 300,000,000 |

**OpenAI ChatGPT**（滚动窗口消息额度，按 tokens 模拟）

| 档位 | 价格 | 5 小时窗口 | 7 天窗口 |
| --- | --- | --- | --- |
| Free | $0 | 100,000 | 800,000 |
| Go | $8/月 | 500,000 | 4,000,000 |
| Plus | $20/月 | 2,500,000 | 20,000,000 |
| Pro | $200/月 | 30,000,000 | 250,000,000 |
| Pro Max | $500/月 | 60,000,000 | 500,000,000 |

> 2026 年 OpenAI 的 Pro 已拆成两档：Pro（$200/月）与 Pro Max（$500/月，含 Astra Ultrafast 极速档），
> ChatGPT 个人订阅现有 Free / Go / Plus / Pro / Pro Max 五档。

两个窗口都是滚动窗口，可在设置页里**只开 7 天**、或**同时开 5 小时 + 7 天**（至少保留一个）。

## 界面：状态与设置分离

- **主页面只显示状态**：侧边栏底部「订阅」入口、输入框下方的额度条、右侧订阅面板
  （档位/用量/自动释放倒计时、领取与使用重置卡、最近事件），以及额度耗尽时的全屏横幅。
  主面板里**不再有任何设置项**。
- **所有配置在独立设置页**：`设置 → 订阅额度`，包括
  - 订阅方案：Claude / ChatGPT 两组档位，点击即切换（价格与模拟额度一目了然）；
  - 额度窗口：5 小时 / 7 天开关；
  - 拦截设置：额度耗尽时是否真的拦截请求、压缩/会话标题等后台调用是否也计数；
  - 自定义额度：分别设置 5 小时 / 7 天 tokens 上限；
  - 危险区域：重置全部模拟数据；
  - 存储：状态文件路径与最近一次保存状态。

## 额度耗尽时会发生什么

1. 下一次模型请求被插件短路，产生真实的请求失败（`SUBSCRIPTION_QUOTA`，HTTP 429 语义）——
   会话里出现报错行，而不是伪造的 UI 文案。
2. 弹出一条全屏横幅：哪个窗口耗尽、已用/上限、多久后自动释放、还剩几张重置卡。
3. 处理方式任选：点横幅「使用重置卡」立即清空被卡住的窗口；或等窗口滚动释放；
   或去设置页换成更宽的档位。

重置卡是**用户自助派发**的：主面板「领取重置卡」按钮，默认 10 秒冷却、最多持有 9 张、初始 2 张，
都可以在配置里改。模型只有一个只读工具 `subscription_status`，不能替你领卡或用卡。

## 安装（分享给他人）

要求：对方的 DSH 是 **Web profile**（本插件只提供 Web 界面），已在 `0.2.1-rc.2` 上完整测试过。
插件包就是本仓库根目录，Host 端零依赖、纯 JS，不需要构建。

**方式 A：直接从 GitHub 安装（推荐）**

让对方的 DSH 会话执行（`plugin_manager` 工具，需 Full access）：

```text
plugin_manager action=install_bundle target="github:wjlfish/dsh-subscription-sim"
```

或者用命令行（等价于 pnpm 安装，然后需要在插件页把 bundle 选中启用）：

```sh
dsh plugin --profile web add github:wjlfish/dsh-subscription-sim
```

安装后刷新一次 Web 页面；设置页出现「订阅额度」、侧边栏底部出现「订阅」即成功。

**方式 B：克隆后按本地目录安装**

```sh
git clone https://github.com/wjlfish/dsh-subscription-sim.git
# 然后让 DSH 安装这个绝对路径：
#   plugin_manager action=install_bundle target=/abs/path/to/dsh-subscription-sim
```

**方式 C：发布到 npm（可选，适合长期分发）**

`package.json` 当前的包名是 `@local/dsh-subscription-sim` 且 `private: true`（防止误发布）。
如果要发布到 npm：改成本人 scope（如 `@wjlfish/dsh-subscription-sim`）、删除 `private`、
按需加 `publishConfig.access`，然后 `npm publish`；使用者用
`plugin_manager action=install_bundle target="<包名>@<版本>"` 安装。

安装/更新后：
- **刷新一次 Web 页面**（浏览器半边只在页面重新加载时装载）；
- 如果设置页提示「版本不匹配」，说明 Host 半边还停在旧版本，重启一次 `dsh` 即可；
- 额度状态保存在**每个人自己的** `$DSH_HOME/plugin-data/dsh-subscription-sim/state.json`，
  不会随仓库分发，也不会上传任何数据（插件不联网，只统计本机模型调用的 usage）。

## 开发与测试

```sh
node --test 'test/*.test.mjs'     # 110 项单元/静态/mock-render 测试，Node >= 22
```

仓库结构：`index.js` + `lib/`（Host：额度引擎、`llm/stream` 拦截、HTTP API、模型工具）、
`client.js`（Web UI：三块状态界面 + 独立设置页）、`locale/`（插件列表元数据）、
`cordis.patch.yml`（bundle 默认配置）、`test/`（测试）、`CONTRACT.md`（实现契约）、
`VERIFICATION.md`（独立验收报告）。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中覆盖插件行配置（行 id 为 `subscription-sim`）：

```yaml
- id: subscription-sim
  name: '@local/dsh-subscription-sim'
  config:
    vendor: claude            # 默认订阅方：claude | openai（仅首次安装/无状态时生效）
    plan: max20x              # 默认档位（同上）
    windows:
      h5: true                # 是否启用 5 小时窗口（可只开 7 天）
      d7: true                # 是否启用 7 天窗口
    enforce: true             # false = 只统计不拦截
    countAuxiliary: true      # 压缩 / 会话标题等后台调用是否也计数并拦截
    cards:
      initialHeld: 2          # 首次安装时赠送的重置卡
      maxHeld: 9              # 重置卡持有上限
      claimCooldownSeconds: 10 # 领卡冷却（秒）
      claimBatch: 1           # 每次领几张
    stateFile: ''             # 留空使用默认路径（见下）
```

数据文件：`$DSH_HOME/plugin-data/dsh-subscription-sim/state.json`（损坏时自动备份为
`state.json.corrupt-<时间戳>` 并以全新状态启动；v1 旧状态会自动迁移为「Claude / Max 20×」）。

## 实现方式（给好奇的人）

- Host 半边监听 `llm/stream` waterfall（`{ global: true, prepend: true }`），在每次模型调用
  前检查两个窗口的滚动用量；额度用尽时短路返回一个终态 `finish` chunk
  （`reason.kind = 'error'`，`failure.code = 'SUBSCRIPTION_QUOTA'`），从而产生一条真实的
  请求失败，而不是伪造 UI 文案。
- 每次流里的 `usage` chunk（input/output/cache tokens）累计进按分钟分桶的账本；
  5 小时 / 7 天窗口都是对账本做滚动求和，所以额度会随时间自然释放。
- 重置卡只会清空对应窗口的账本桶，`lifetime` 累计值不会被清掉。
- 客户端是纯 JS 的 Web 插件：主页面三块状态 UI（侧边栏入口 / composer 额度条 / 全屏面板 + 耗尽横幅）
  + 一个 `settings.section` 设置页；数据全部来自本地 `POST /subscription-sim/api`，每 4 秒轮询。

## 自检

两个内部诊断动作（不是普通用户操作入口）：

- `probe`：真的发起一次最小模型调用，验证「额度拦截 → 恢复」整条链路，返回
  `probe.blocked` / `probe.failure.code`（正常时应为 `blocked: false` 并返回 chunk 序列）。
- `arm-simulate-block`：装填一次「模拟拦截」，让下一次模型请求以额度耗尽错误失败一次。

两者都走 `POST /subscription-sim/api`。该路由和其它 `/api` 路由一样受本机连接鉴权保护
（需要浏览器会话 cookie），curl 直接请求会得到 403（这是鉴权，不是插件故障）。
完整验收命令与结论见 [`VERIFICATION.md`](./VERIFICATION.md)。

## 已知限制

- 额度是模拟值，不映射真实 DeepSeek / OpenAI / Anthropic 价格；两家的真实限额机制
  （Claude 的 5 小时会话 + 每周额度、ChatGPT 的按模型消息条数）被统一近似为「tokens 滚动窗口」。
- Tokens 计数来自当前进程内所有模型调用（含子 Agent、工作流、压缩、会话标题，可按配置排除后台调用），
  共用同一份「账户额度」。
- 只在 DSH Web profile 的 Web GUI 中提供界面；无浏览器自动化能力，视觉验收以实际页面为准。
