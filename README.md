# HyperNight

HyperNight 是从 `HyperArbitrary` 休市偏离策略独立拆出的 Node.js 项目。它不引用原项目代码或数据库，自己完成 HIP-3 股票代币行情采集、截面多因子评分、时间切分参数优化、组合回测和可恢复的模拟交易。

核心运行环境：Node.js 23.4+（使用内置 `node:sqlite`）与 `nodejs-polars`。

## Web 工作台

默认入口是独立的 React 19 + Vite 前端工程，生产启动会先构建前端，再由本地 Node API 同源托管：

```bash
cd HyperNight
npm install
npm start
```

然后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。首次没有行情时，到“行情数据”页从 Hyperliquid 与腾讯美股行情接口回补真实数据。

前端包含六个实际连接本地 API 的页面：策略总览、因子评分、因子研究、组合回测、模拟交易和行情数据。应用每次打开默认进入组合回测页，并从 SQLite 自动恢复最新一次成功的参数优化与正式回测；权益曲线、Rank IC、评分榜和成交账本都来自持久化运行结果。

生产源码不提供演示或合成行情注入入口。数据库只要仍存在已知合成 source，研究、参数优化和回测就会拒绝执行，避免测试填充被误当成真实结论。

前端源码位于 `frontend/src/`，生产产物位于 `frontend/dist/`。开发时可同时启动 Vite 和 API：

```bash
npm run dev
# Web: http://127.0.0.1:5177
# API: http://127.0.0.1:4317
```

## 数据流

```text
Hyperliquid Info API ── 5m / 1d K、funding、市场快照 ─┐
                                                      ├─ HyperNight SQLite
腾讯美股日 K ───────── 正股收盘参照与实际交易日历 ────┘
                                                               │
                              Polars 滚动特征 + 截面标准化/排名 ─┤
                                                               ├─ 因子研究
                                                               ├─ 组合回测 + 无对冲影子组合
                                                               └─ 持久化模拟交易
```

SQLite 同时保存 5m K、1d K、正股日 K、funding、市场上下文、研究/回测 run、因子分数，以及模拟账户、仓位、成交和权益曲线。

## 策略口径

- 默认窗口为 16:00 ET 到下一交易日 09:30 ET。
- 历史交易日完全由正股日 K 中实际出现的日期确定，周末和节假日自然合并。
- 参照价默认为正股收盘价；收盘前最后一根完整 HL 5m K 与正股收盘偏差超过 2% 时，整个标的休市段被排除。
- 方向沿用原策略的价格发现动量语义：正偏离做多，负偏离做空。
- 每根 5m K 对全部候选做截面评分，退出后释放的组合槽位可由尚未入场的高分标的补入；同一标的每个休市段最多入场一次。
- 所有开放仓位共享 `initialCapital × grossNotionalPct` 毛名义预算，并按单仓 `maxNotional` 预留动态对冲容量。
- funding 只在 UTC 整点、且该小时样本真实存在时结算。
- 同一批入场信号会再运行一个完全不对冲的影子组合，用于衡量动态对冲的保护或磨损。

动态对冲保持原策略修正后的规则：不利移动增加反向对冲，有利移动减少对冲；加仓受剩余容量限制，减仓只受当前对冲仓限制。

## 多因子模型

每个标的在每个休市段内独立计算纵向特征：

```text
deviation      = abs(偏离) - 退出阈值 - 预计往返成本
momentum       = 持仓方向 × log(close_t / close_t-momentumBars)
liquidity      = log(滚动平均 5m 名义成交额)
lowVolatility  = -滚动 5m 对数收益标准差
fundingCarry   = -持仓方向 × fundingRate
```

随后在同一 5m 时间戳做 5%/95% winsorize、z-score、加权求和和降序排名。滚动运算不居中，按标的和休市段隔离；funding 只使用当前整点样本，因此特征不会读取未来 bar。研究模块中的下一根 5m 收益只作为事后标签计算 Rank IC，不进入信号。

默认权重为 40% 偏离、20% 动量、15% 流动性、15% 低波动、10% funding carry。

## CLI 与快速验证

```bash
cd HyperNight
npm install
npm test
```

## 行情回补

```bash
cp .env.example .env
npm run data:backfill -- --days 17
npm run data:backfill -- --symbols AAPL,MSFT,NVDA --days 10
```

默认数据库是 `./data/hypernight.db`。Hyperliquid 官方 5m candleSnapshot 仅保留最近约 5000 根，回补会自动遵守该上限；持续运行可在本地积累更长历史。

## 研究与回测

```bash
npm run research
npm run backtest
npm run optimize
npm run research -- --symbols AAPL,MSFT,NVDA --start 2026-07-01 --end 2026-08-15
npm run backtest -- --config ./config.json --full
npm run optimize -- --trials 60 --folds 3 --full
```

`optimize` 默认搜索 10 个交易与风控参数轴，使用 60 组候选和 3 个按时间顺序切分的验证折；最后 20% 完整休市段只作独立测试，不参与参数选择。推荐配置还会执行额外 0/2/5 bps 成本压力和逐轴邻域敏感度，随后自动运行一次全样本正式回测。优化结果与正式回测分别作为 `optimization` / `backtest` run 持久化，浏览器或服务重启后仍可恢复。

配置文件可以只覆盖需要修改的字段：

```json
{
  "maxPositions": 3,
  "maxCoreNotional": 8000,
  "maxNotional": 12000,
  "factorWeights": {
    "deviation": 0.35,
    "momentum": 0.25,
    "liquidity": 0.15,
    "lowVolatility": 0.15,
    "fundingCarry": 0.10
  }
}
```

五个因子权重之和必须等于 1。所有关键参数会随 run 和模拟账户一起持久化，避免结果脱离配置。

## 模拟交易

默认初始化从数据库中最新一根已存 5m K 之后开始，不会误把历史数据当成新成交：

```bash
npm run paper:init
npm run paper:tick -- --refresh --days 3
npm run paper:status
```

要从现有历史数据回放并验证恢复能力：

```bash
npm run paper:init -- --replay
npm run paper:tick
npm run paper:status -- --full
```

每个时间戳的账户、开放仓位、新平仓交易和权益点在同一 SQLite 事务中落盘；进程重启后会从 `lastProcessedTimestamp` 继续，重复 tick 是幂等的。

当前隔夜窗口尚无下一交易日日 K 时，模拟盘用常规 NYSE 周末/节假日规则推断下一交易日，并输出警告；历史研究和回测仍只认真实日 K 日期。特殊临时休市需要人工确认。

模拟盘是本地成交仿真，不签名、不发送真实订单。成交价使用已收盘 5m K 的收盘价，手续费与固定滑点单列审计；市场快照中的 impact bid/ask 会持久化，但不会伪造成历史盘口。

## 环境变量

- `HYPERNIGHT_DB_PATH`：SQLite 路径。
- `HYPERNIGHT_HOST`：Web 监听地址，默认 `127.0.0.1`。
- `HYPERNIGHT_PORT`：Web 监听端口，默认 `4317`。
- `HYPERNIGHT_SYMBOLS`：逗号分隔标的。
- `HYPERLIQUID_INFO_URL`：Hyperliquid Info API 地址。
- `HYPERNIGHT_CONFIG_JSON`：完整或部分 JSON 配置。

项目脚本会自动读取存在的 `.env`。

## 已知限制

- 腾讯美股日 K 是第三方、无 SLA 的前复权数据；拆股错位由参照价护栏排除。
- 半日交易仍按 16:00 ET 收盘处理。
- 官方 5000 根 5m 限制意味着首次回补通常只有约两周，统计结论不能直接外推。
- 当前没有订单簿历史、保证金阶梯、强平和真实撮合延迟模型。
- `node:sqlite` 在当前 Node 版本仍会打印 ExperimentalWarning，但数据库接口和测试均使用 Node 内置实现。

## 验证范围

测试覆盖 DST/节假日窗口、5m/1d/正股日 K 持久化、API 解析、Polars 因子与排名、未来数据不变性、参照价护栏、方向与交易成本、funding 整点结算、动态对冲、组合容量、参数优化持久化、正式回测配对以及服务重启恢复。隔离测试行情只存在于 `test/` 创建的临时或内存数据库中，不会被生产代码导入。
