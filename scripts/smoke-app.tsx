/**
 * 冒烟测试：在 Node 中以 SSR 方式渲染 App 与边界追溯面板，验证渲染链路不抛异常、
 * 关键文案（时间基准 / 观测面板 / 精确观测零步证明 / 推导步骤 / 反向标记 /
 * 不可追溯原因 / 分层排程各层结果）存在。
 * 运行：npm run smoke（见 package.json scripts）
 */
import { renderToString } from 'react-dom/server'
import { createElement as h } from 'react'
import App from '../src/App'
import WindowsTable from '../src/components/WindowsTable'
import CyclePanel from '../src/components/CyclePanel'
import ObservationEditor from '../src/components/ObservationEditor'
import AuditPanel from '../src/components/AuditPanel'
import SnapshotPanel from '../src/components/SnapshotPanel'
import { analyze, traceBound } from '../src/lib/graph'
import { auditRedundancy } from '../src/lib/audit'
import { buildConsistentSample } from '../src/lib/samples'

let failed = 0
/** React SSR 会在插值文本之间插入 <!-- -->，先去除再做片段匹配 */
function check(rawHtml: string, fragment: string, label: string) {
  const html = rawHtml.replace(/<!-- -->/g, '')
  if (!html.includes(fragment)) {
    failed++
    console.error('SMOKE FAIL:', label, '缺少片段:', fragment)
  }
}

// 1) 整个 App 初始渲染
const appHtml = renderToString(h(App))
check(appHtml, '各事件的绝对时间窗', 'App')
check(appHtml, '差分约束图', 'App')
check(appHtml, '点击最早/最晚时间可追溯边界推导链', 'App')
check(appHtml, '时间基准', 'App')
check(appHtml, '时间原点', 'App')
check(appHtml, '绝对时间观测', 'App')
check(appHtml, '批量证词导入', 'App')
check(appHtml, 'EVENT / REL / OBS', 'App')
check(appHtml, '案卷快照', 'App')
check(appHtml, '下载快照 JSON', 'App')
check(appHtml, '精确时刻（零宽区间）', 'App')
check(appHtml, '直接观测', 'App')

// 1b) 分层最小偏差排程（默认示例：恢复=高优先级 期望 +25 → 高层 D=5；复盘=低优先级 → 低层 D=0）
check(appHtml, '分层最小偏差排程', '分层最小偏差排程')
check(appHtml, '期望时刻', '分层最小偏差排程')
check(appHtml, '高优先级', '分层最小偏差排程')
check(appHtml, '中优先级', '分层最小偏差排程')
check(appHtml, '低优先级', '分层最小偏差排程')
check(appHtml, 'D = 5', '分层最小偏差排程')
check(appHtml, 'D = 0', '分层最小偏差排程')
check(appHtml, '无参与事件', '分层最小偏差排程')
check(appHtml, '最大偏差', '分层最小偏差排程')
check(appHtml, '达到 ±D', '分层最小偏差排程')
check(appHtml, '层级', '分层最小偏差排程')
check(appHtml, '已定时', '分层最小偏差排程')
check(appHtml, '未定时', '分层最小偏差排程')

// 1c) 冗余证词审计（默认示例全部证词均为必要；面板展示推导区间、结论徽标与筛选）
check(appHtml, '冗余证词审计', '冗余证词审计')
check(appHtml, '排除后推导时差', '冗余证词审计')
check(appHtml, '共 7 条启用约束参与审计', '冗余证词审计')
check(appHtml, '必要 7 条', '冗余证词审计')
check(appHtml, '仅冗余', '冗余证词审计筛选')
check(appHtml, '仅必要', '冗余证词审计筛选')
check(appHtml, '不改写约束与本地存档', '冗余证词审计')
check(appHtml, '+10 ~ +25 分钟', '冗余证词审计：整体约束推导区间')
check(appHtml, '−12 ~ +12 分钟', '冗余证词审计：首条约束推导区间')

// 1d) 观测编辑器可独立渲染
const s0 = buildConsistentSample()
const obsHtml = renderToString(
  h(ObservationEditor, {
    events: s0.events,
    observations: s0.observations,
    cycleObservationIds: new Set<string>(),
    onAdd: () => {},
    onRemove: () => {},
    onUpdate: () => {},
  }),
)
check(obsHtml, '添加观测', '观测编辑器')
check(obsHtml, '发生于', '观测编辑器')

// 1e) 案卷快照面板可独立渲染（导出计数 / 导入入口 / 格式说明）
const snapHtml = renderToString(h(SnapshotPanel, { state: s0, onApply: () => {} }))
check(snapHtml, '案卷快照（导出 / 导入）', '快照面板')
check(snapHtml, '下载快照 JSON', '快照面板')
check(snapHtml, '从快照文件导入', '快照面板')
check(snapHtml, '事件 7', '快照面板：导出记录数')
check(snapHtml, '观测 1', '快照面板：导出记录数')
check(snapHtml, '快照 JSON 格式说明与示例', '快照面板：格式说明')
check(snapHtml, 'formatVersion', '快照面板：格式说明')

// 2) 主时间窗表 + 三种追溯形态
const s = buildConsistentSample()
const r = analyze(s.events, s.constraints, s.observations)
const byName = new Map(s.events.map((e, i) => [e.name, i]))
const anchorIdx = byName.get('值班告警触发')!
const recovered = byName.get('服务恢复')!

const renderTable = (eventIdx: number, kind: 'earliest' | 'latest') =>
  renderToString(
    h(WindowsTable, {
      events: s.events,
      windows: r.windows,
      cycleEventIds: new Set<string>(),
      baseISO: r.baseISO,
      observations: s.observations,
      trace: traceBound(s.events, s.constraints, s.observations, eventIdx, kind),
      constraints: s.constraints,
      onTrace: () => {},
      onCloseTrace: () => {},
    }),
  )

// 精确观测事件：零步证明（由精确观测直接给出，而非锚点定义）
const anchorHtml = renderTable(anchorIdx, 'latest')
check(anchorHtml, '零步证明', '精确观测追溯')
check(anchorHtml, '精确时刻观测（零宽区间）', '精确观测追溯')

// 最晚边界：观测边 + 单步上界链
const latestHtml = renderTable(recovered, 'latest')
check(latestHtml, '边界依据追溯', '最晚追溯')
check(latestHtml, '第 2 步', '最晚追溯')
check(latestHtml, '采用上界侧不等式', '最晚追溯')
check(latestHtml, '累计偏移', '最晚追溯')
check(latestHtml, '≤ +20', '最晚追溯')

// 最早边界：观测边 + 反向图 3 步链，步骤带「反向」标记
const earliestHtml = renderTable(recovered, 'earliest')
check(earliestHtml, '反向差分图', '最早追溯')
check(earliestHtml, '第 4 步', '最早追溯')
check(earliestHtml, '反向', '最早追溯')
check(earliestHtml, '采用下界侧不等式', '最早追溯')
check(earliestHtml, '≥ +10', '最早追溯')
check(earliestHtml, '观测', '最早追溯（含观测步）')

// 无法定时事件：单元格不可点击且说明原因
check(earliestHtml, '无法定时，最早边界不存在、不可追溯', '不可追溯原因')
check(earliestHtml, '无法定时，最晚边界不存在、不可追溯', '不可追溯原因')

// 3) 矛盾面板：观测-约束混合矛盾链同时列出观测与约束
// B 比 A 晚 10~20（相对约束），但观测 A=08:00、B=08:05（精确）——唯一的环必含观测边
const mkEvents = [
  { id: 'a', name: 'A：车辆驶入路口' },
  { id: 'b', name: 'B：听到刹车声' },
]
const mkConstraints = [
  { id: 'cc1', aId: 'b', bId: 'a', relation: 'later' as const, min: 10, max: 20, enabled: true },
]
const mkObservations = [
  { id: 'oa', eventId: 'a', start: '2026-01-01T08:00', end: '2026-01-01T08:00' },
  { id: 'ob', eventId: 'b', start: '2026-01-01T08:05', end: '2026-01-01T08:05' },
]
const cr = analyze(mkEvents, mkConstraints, mkObservations)
if (cr.cycle) {
  const cycleHtml = renderToString(
    h(CyclePanel, {
      cycle: cr.cycle,
      events: mkEvents,
      constraints: mkConstraints,
      observations: mkObservations,
    }),
  )
  check(cycleHtml, '矛盾涉及绝对时间观测', '混合矛盾环')
  check(cycleHtml, '涉及的绝对时间观测', '混合矛盾环：观测清单')
  check(cycleHtml, '涉及的原始证词 / 相对约束', '混合矛盾环：约束清单')
} else {
  failed++
  console.error('SMOKE FAIL: 构造的观测-约束混合矛盾未被检出')
}

// 4) 冗余证词审计面板：冗余结论 / 无界推导区间 / 矛盾暂停提示
const auditEvents = [
  { id: 'x', name: 'X' },
  { id: 'y', name: 'Y' },
]
const auditConstraints = [
  { id: 'c1', aId: 'y', bId: 'x', relation: 'later' as const, min: 20, max: 40, enabled: true },
]
const auditObs = [
  { id: 'o1', eventId: 'x', start: '2026-01-01T08:00', end: '2026-01-01T08:00' },
  { id: 'o2', eventId: 'y', start: '2026-01-01T08:30', end: '2026-01-01T08:30' },
]
// 两条精确观测钉死 t_Y − t_X = 30 ∈ [20,40] → 证词冗余
const redundantAudit = auditRedundancy(auditEvents, auditConstraints, auditObs)
const redundantHtml = renderToString(
  h(AuditPanel, { events: auditEvents, constraints: auditConstraints, audit: redundantAudit }),
)
check(redundantHtml, '冗余', '审计面板：冗余结论')
check(redundantHtml, '+30 ~ +30 分钟', '审计面板：推导区间退化为单点')
check(redundantHtml, '冗余 1 条', '审计面板：冗余计数')

// 无观测时排除唯一约束 → 两侧无界，判必要
const unboundedAudit = auditRedundancy(auditEvents, auditConstraints, [])
const unboundedHtml = renderToString(
  h(AuditPanel, { events: auditEvents, constraints: auditConstraints, audit: unboundedAudit }),
)
check(unboundedHtml, '−∞ ~ +∞ 分钟', '审计面板：无界推导区间')
check(unboundedHtml, '（含无界侧）', '审计面板：无界标注')
check(unboundedHtml, '必要', '审计面板：无界判必要')

// 矛盾状态：显示暂停审计提示
const pausedHtml = renderToString(
  h(AuditPanel, { events: auditEvents, constraints: auditConstraints, audit: null }),
)
check(pausedHtml, '冗余证词审计已暂停', '审计面板：矛盾暂停提示')

if (failed > 0) process.exit(1)
console.log('smoke ok')
