import { analyze, buildEdges, buildSystem, constraintToEdges, traceBound } from '../src/lib/graph'
import { auditRedundancy } from '../src/lib/audit'
import { DEFAULT_STATE_LIMIT, findMinimalRepairs, MAX_PLANS } from '../src/lib/repair'
import { computeMinDeviationSchedule } from '../src/lib/schedule'
import { buildConsistentSample, buildContradictionSample } from '../src/lib/samples'
import { migrateState } from '../src/lib/storage'
import { buildImportEntities, parseDsl } from '../src/lib/dsl'
import { serializeSnapshot, validateSnapshot } from '../src/lib/snapshot'
import type {
  Constraint,
  LayerResult,
  PriorityLevel,
  ScheduleResult,
  TimeObservation,
  TEvent,
} from '../src/types'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error('FAIL:', msg)
  }
}

function approxEq(a: number | null, b: number | null) {
  if (a === null || b === null) return a === b
  return a === b
}

const ANCHOR_ISO = '2026-01-01T08:00'
/** 相对固定基准时间的 datetime-local 字符串 */
function isoPlus(min: number, base = ANCHOR_ISO): string {
  const d = new Date(base)
  d.setMinutes(d.getMinutes() + min)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一条对某事件的精确（零宽）观测 */
function exactObs(id: string, eventId: string, atMin: number, base = ANCHOR_ISO): TimeObservation {
  const t = isoPlus(atMin, base)
  return { id, eventId, start: t, end: t }
}

// ---- 单条约束的边转换 ----
{
  const c: Constraint = {
    id: 'c1', aId: 'A', bId: 'B', relation: 'earlier', min: 3, max: 8, enabled: true,
  }
  const idx = new Map([['A', 0], ['B', 1]])
  const es = constraintToEdges(c, (id) => idx.get(id)!)
  // earlier: A->B +8 (t_B - t_A <= 8), B->A -3 (t_A - t_B <= -3)
  assert(es.some((e) => e.u === 0 && e.v === 1 && e.w === 8 && e.kind === 'constraint'), 'earlier 上界边 A->B +8')
  assert(es.some((e) => e.u === 1 && e.v === 0 && e.w === -3 && e.kind === 'constraint'), 'earlier 下界边 B->A -3')

  const c2: Constraint = {
    id: 'c2', aId: 'A', bId: 'B', relation: 'later', min: 3, max: 8, enabled: true,
  }
  const es2 = constraintToEdges(c2, (id) => idx.get(id)!)
  assert(es2.some((e) => e.u === 1 && e.v === 0 && e.w === 8), 'later 上界边 B->A +8')
  assert(es2.some((e) => e.u === 0 && e.v === 1 && e.w === -3), 'later 下界边 A->B -3')
}

// ---- 禁用约束不产生边 ----
{
  const state = buildConsistentSample()
  const all = buildEdges(state.events, state.constraints).edges.length
  const disabled = state.constraints.map((c) => ({ ...c, enabled: false }))
  assert(buildEdges(state.events, disabled).edges.length === 0, '全部停用时相对边集为空')
  assert(all === state.constraints.length * 2, '每条约束产生 2 条边')
}

// ==================== 绝对时间观测 → 统一差分图 ====================

// ---- buildSystem：观测产生与时间原点 t0 相连的两条边，基准 = 最早观测起点 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]
  const obs: TimeObservation[] = [
    { id: 'o1', eventId: 'x', start: isoPlus(10), end: isoPlus(20) },
    exactObs('o2', 'y', 30),
  ]
  const sys = buildSystem(events, [], obs)
  assert(sys.originIdx === 2, '时间原点下标为 n')
  assert(sys.baseISO === isoPlus(10), '基准 t0 = 最早观测起点（X 的 +10）')
  // o1 相对基准：X ∈ [0, 10] => t0->X +10（上界），X->t0 0（下界）
  assert(
    sys.edges.some((e) => e.kind === 'observation' && e.u === 2 && e.v === 0 && e.w === 10 && e.bound === 'upper' && e.observationId === 'o1'),
    '观测区间上界边 t0 -> X +10',
  )
  assert(
    sys.edges.some((e) => e.kind === 'observation' && e.u === 0 && e.v === 2 && e.w === 0 && e.bound === 'lower' && e.observationId === 'o1'),
    '观测区间下界边 X -> t0 0',
  )
  // o2 相对基准：Y = +20（30 − 10）精确
  assert(
    sys.edges.some((e) => e.kind === 'observation' && e.u === 2 && e.v === 1 && e.w === 20),
    '精确观测上界边 t0 -> Y +20（相对基准换算）',
  )
  assert(
    sys.edges.some((e) => e.kind === 'observation' && e.u === 1 && e.v === 2 && e.w === -20),
    '精确观测下界边 Y -> t0 −20（零宽）',
  )
}

// ---- buildSystem：无有效观测时 baseISO 为 null，原点没有观测边 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }]
  const sys = buildSystem(events, [], [])
  assert(sys.baseISO === null, '无观测时基准为 null')
  assert(!sys.edges.some((e) => e.kind === 'observation'), '无观测时没有观测边')
  // 引用已删除事件 / 无效时间的观测被跳过
  const dirty = buildSystem(events, [], [
    { id: 'd1', eventId: 'gone', start: ANCHOR_ISO, end: ANCHOR_ISO },
    { id: 'd2', eventId: 'x', start: 'not-a-time', end: 'not-a-time' },
  ])
  assert(dirty.baseISO === null && dirty.edges.length === 0, '无效观测一律跳过')
  // end < start 归一为精确时刻
  const norm = buildSystem(events, [], [
    { id: 'd3', eventId: 'x', start: isoPlus(10), end: isoPlus(5) },
  ])
  assert(norm.baseISO === isoPlus(10), '终点早于起点时按起点精确时刻归一')
}

// ---- 可满足示例的窗口（观测锚定 t0；旧锚点事件现在是被精确观测的普通事件）----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.observations)
  assert(r.satisfiable, '可满足示例判定为可满足')
  assert(!r.cycle, '可满足示例无矛盾环')
  assert(r.baseISO === s.observations[0].start, '基准即告警的精确观测时刻')
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const w = (name: string) => r.windows.get(byName.get(name)!)!

  assert(approxEq(w('值班工程师介入').earliestOffset, 2), '介入最早 +2')
  assert(approxEq(w('值班工程师介入').latestOffset, 5), '介入最晚 +5')
  assert(approxEq(w('定位到故障节点').earliestOffset, 5), '定位最早 +5')
  assert(approxEq(w('定位到故障节点').latestOffset, 15), '定位最晚 +15')
  assert(approxEq(w('完成流量切换').earliestOffset, 6), '切换最早 +6')
  assert(approxEq(w('完成流量切换').latestOffset, 19), '切换最晚 +19（受恢复反推约束）')
  assert(approxEq(w('服务恢复').earliestOffset, 10), '恢复最早 +10（受"定位早于恢复5~15"收紧）')
  assert(approxEq(w('服务恢复').latestOffset, 20), '恢复最晚 +20（整体约束）')
  assert(approxEq(w('复盘会议').earliestOffset, 70), '复盘最早 +70')
  assert(approxEq(w('复盘会议').latestOffset, 200), '复盘最晚 +200')
  assert(w('媒体报道').status === 'disconnected', '媒体报道未连通任何观测 -> 无法定时')
  const wa = w('值班告警触发')
  assert(wa.status === 'bounded' && wa.earliestOffset === 0 && wa.latestOffset === 0, '告警被精确观测钉在 t0（窗宽 0）')
  assert(wa.directObservationIds.length === 1, '告警标注 1 条直接观测')
}

// ---- 多条观测共同定时：观测与相对约束在同一张图上互相收紧 ----
{
  // Y 比 X 晚 10~20；X ∈ [10:00,10:10]；Y 精确发生于 10:30（基准 10:00）。
  const events: TEvent[] = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'y', bId: 'x', relation: 'later', min: 10, max: 20, enabled: true },
  ]
  const obs: TimeObservation[] = [
    { id: 'o1', eventId: 'x', start: isoPlus(0), end: isoPlus(10) },
    exactObs('o2', 'y', 30),
  ]
  const r = analyze(events, cs, obs)
  assert(r.satisfiable, '多观测示例可满足')
  assert(r.baseISO === isoPlus(0), '基准 = 10:00')
  const wx = r.windows.get(0)!
  const wy = r.windows.get(1)!
  // Y=30 与 Y-X ∈ [10,20] 反推 X ∈ [10,20]，与观测 X ∈ [0,10] 相交 => X=10
  assert(wx.earliestOffset === 10 && wx.latestOffset === 10, 'X 被两条观测经相对约束共同钉在 +10')
  assert(wy.earliestOffset === 30 && wy.latestOffset === 30, 'Y 精确观测给 +30')
  assert(wx.directObservationIds[0] === 'o1' && wy.directObservationIds[0] === 'o2', '直接观测标注正确')
}

// ---- 观测区间（非零宽）正常放宽窗口 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }]
  const obs: TimeObservation[] = [{ id: 'o1', eventId: 'x', start: isoPlus(5), end: isoPlus(15) }]
  const r = analyze(events, [], obs)
  const w = r.windows.get(0)!
  assert(r.baseISO === isoPlus(5), '基准取观测起点 +5')
  assert(w.earliestOffset === 0 && w.latestOffset === 10 && w.status === 'bounded', '单条区间观测：窗宽 10 分钟')
}

// ---- 矛盾示例：负环提取（环为纯相对约束 A-B-C，不含时间原点）----
{
  const s = buildContradictionSample()
  const r = analyze(s.events, s.constraints, s.observations)
  assert(!r.satisfiable, '矛盾示例判定为不可满足')
  assert(!!r.cycle, '提取出矛盾环')
  if (r.cycle) {
    assert(r.cycle.totalWeight === -25, '环权重之和 = -25')
    assert(!r.cycle.edges.some((e) => e.kind === 'observation'), '该矛盾环纯由相对约束构成')
    assert(!r.cycle.nodes.includes(s.events.length), '纯相对矛盾环不含时间原点')
    // 环必须覆盖 A、B、C（不含 D）
    const names = r.cycle.nodes.map((i) => s.events[i].name[0]).sort()
    assert(JSON.stringify(names) === JSON.stringify(['A', 'B', 'C']), '环为 A-B-C')
    // 校验 edges[i] 从 nodes[i] 指向 nodes[(i+1)%n]
    const n = r.cycle.nodes.length
    let aligned = true
    for (let i = 0; i < n; i++) {
      const e = r.cycle.edges[i]
      if (e.u !== r.cycle.nodes[i] || e.v !== r.cycle.nodes[(i + 1) % n]) aligned = false
    }
    assert(aligned, '环边与环节点严格对齐 edges[i]: nodes[i] -> nodes[i+1]')
    const sum = r.cycle.edges.reduce((a, e) => a + e.w, 0)
    assert(sum === r.cycle.totalWeight, '环权重求和一致')
  }
}

// ---- 观测与相对约束冲突：矛盾环同时包含观测边与约束边（不逐锚点独立判断）----
{
  // B 比 A 晚至少 10 分钟；观测 A=08:00、B=08:05 => t0->B +5 与 B->A −10、A->t0 0 成环 −5
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
  ]
  const obs: TimeObservation[] = [exactObs('oa', 'a', 0), exactObs('ob', 'b', 5)]
  const r = analyze(events, cs, obs)
  assert(!r.satisfiable, '观测与相对约束冲突判为矛盾')
  assert(!!r.cycle, '抽出观测与约束混合的矛盾环')
  if (r.cycle) {
    assert(r.cycle.nodes.includes(2), '混合矛盾环包含时间原点 t0')
    assert(r.cycle.edges.some((e) => e.kind === 'observation'), '矛盾链含观测边')
    assert(r.cycle.edges.some((e) => e.kind === 'constraint'), '矛盾链同时含相对约束边')
    assert(r.cycle.totalWeight < 0, '混合环权重之和为负')
    // 至少一条观测边属于 B（+5 上界）或 A（0 边）
    const obsIds = new Set(r.cycle.edges.filter((e) => e.kind === 'observation').map((e) => e.observationId))
    assert(obsIds.has('oa') || obsIds.has('ob'), '矛盾链映射回具体观测记录')
    const cIds = new Set(r.cycle.edges.filter((e) => e.kind === 'constraint').map((e) => e.constraintId))
    assert(cIds.has('c1'), '矛盾链映射回具体相对约束')
  }
}

// ---- 两条观测互相矛盾（同一事件两个不相交的精确时刻）----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }]
  const obs: TimeObservation[] = [exactObs('o1', 'x', 0), exactObs('o2', 'x', 30)]
  const r = analyze(events, [], obs)
  assert(!r.satisfiable, '同一事件的两条冲突观测判为矛盾')
  assert(!!r.cycle && r.cycle.edges.every((e) => e.kind === 'observation'), '矛盾环完全由观测边构成')
  assert(r.cycle!.totalWeight === -30, '两条精确观测环权重 −30')
}

// ---- 两条区间观测不相交亦成环 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }]
  const obs: TimeObservation[] = [
    { id: 'o1', eventId: 'x', start: isoPlus(0), end: isoPlus(10) },
    { id: 'o2', eventId: 'x', start: isoPlus(20), end: isoPlus(30) },
  ]
  const r = analyze(events, [], obs)
  assert(!r.satisfiable, '不相交观测区间矛盾')
  assert(r.cycle!.edges.every((e) => e.kind === 'observation'), '区间观测矛盾环只含观测边')
}

// ---- 精确间隔约束（min == max）：窗口退化为点 ----
{
  const s = buildConsistentSample()
  s.constraints = s.constraints.map((c) =>
    c.aId === s.events[1].id ? { ...c, min: 4, max: 4 } : c,
  )
  const r = analyze(s.events, s.constraints, s.observations)
  const w = r.windows.get(1)!
  assert(r.satisfiable, '改精确间隔后仍可满足')
  assert(w.earliestOffset === 4 && w.latestOffset === 4, '介入窗口退化为 +4 单点')
}

// ---- 空系统 / 无观测 ----
{
  const r0 = analyze([], [], [])
  assert(r0.satisfiable && r0.baseISO === null, '空系统可满足且无基准')
  const s = buildConsistentSample()
  const r1 = analyze(s.events, s.constraints, [])
  assert(r1.satisfiable, '无观测时相对系统仍判可满足')
  assert(r1.baseISO === null, '无观测时无基准')
  assert([...r1.windows.values()].every((w) => w.status === 'disconnected'), '无观测时全部无法定时')
}

// ---- 纯相对矛盾在无观测时仍可检出（相对约束先自洽，观测只负责锚定绝对时间）----
{
  const s = buildContradictionSample()
  const r = analyze(s.events, s.constraints, [])
  assert(!r.satisfiable && !!r.cycle, '无观测也能检出相对约束之间的负环')
}

// ---- 经典矛盾：A 早于 B 10 分钟，又晚于 B 5 分钟（两点环）----
{
  const ev = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]
  const cs: Constraint[] = [
    { id: 'x', aId: 'a', bId: 'b', relation: 'earlier', min: 10, max: 20, enabled: true },
    { id: 'y', aId: 'a', bId: 'b', relation: 'later', min: 5, max: 8, enabled: true },
  ]
  const r = analyze(ev, cs, [exactObs('o', 'a', 0)])
  assert(!r.satisfiable, '双向时间冲突判为矛盾')
  assert(r.cycle !== undefined && r.cycle.totalWeight < 0, '两点负环权重为负')
}

// ---- 未被任何观测连通的独立分量：可满足但无法定时 ----
{
  // X 有观测；Z 只与 W 有相对约束，与 X 分量完全隔离
  const events: TEvent[] = [
    { id: 'x', name: 'X' }, { id: 'w', name: 'W' }, { id: 'z', name: 'Z' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'z', bId: 'w', relation: 'later', min: 0, max: 10, enabled: true },
  ]
  const r = analyze(events, cs, [exactObs('o', 'x', 0)])
  assert(r.satisfiable, '系统整体可满足')
  assert(r.windows.get(0)!.status === 'bounded', 'X 被观测定时')
  assert(r.windows.get(1)!.status === 'disconnected', 'W 未连通观测 -> 无法定时')
  assert(r.windows.get(2)!.status === 'disconnected', 'Z 未连通观测 -> 无法定时')
}

// ==================== 最小修复 ====================

// ---- 最小修复：矛盾示例最少停用 1 条，3 个并列方案 ----
{
  const s = buildContradictionSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.observations)
  assert(r.found, '矛盾示例找到修复方案')
  assert(r.disableCount === 1, '矛盾示例最少停用 1 条')
  assert(r.optimumProven && !r.truncated && !r.observationConflict, '最优性已证明、未截断、非纯观测冲突')
  assert(r.totalPlans === 3, `3 个并列最优方案（实际 ${r.totalPlans}）`)
  assert(r.plans.length === 3, '展示全部 3 个方案（≤5）')

  // 每个方案停用 1 条环上约束（前 3 条构成负环；第 4 条是无关正常约束）
  const ringIds = s.constraints.slice(0, 3).map((c) => c.id)
  const unrelatedId = s.constraints[3].id
  for (const plan of r.plans) {
    assert(plan.disableConstraintIds.length === 1, '每个方案停用恰好 1 条')
    assert(ringIds.includes(plan.disableConstraintIds[0]), '停用的是矛盾环上的约束')
    assert(!plan.disableConstraintIds.includes(unrelatedId), '不会建议停用无关约束')
  }

  // 方案按约束录入顺序稳定排序
  const orders = r.plans.map((p) => s.constraints.findIndex((c) => c.id === p.disableConstraintIds[0]))
  assert(JSON.stringify(orders) === JSON.stringify([0, 1, 2]), '方案按录入顺序排序')

  // 每个方案修复后系统确实可满足，且时间窗可计算（观测保持生效）
  for (const plan of r.plans) {
    const off = new Set(plan.disableConstraintIds)
    const sim = s.constraints.map((c) => (off.has(c.id) ? { ...c, enabled: false } : c))
    const ar = analyze(s.events, sim, s.observations)
    assert(ar.satisfiable, '按方案停用后系统可满足')
    assert(plan.windows.get(0)?.status === 'bounded' && plan.windows.get(0)?.latestOffset === 0, '方案时间窗：A 仍被观测钉在 0')
  }
}

// ---- 最小修复：观测与约束冲突时，停用环上相对约束即可修复（保留观测）----
{
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
  ]
  const obs: TimeObservation[] = [exactObs('oa', 'a', 0), exactObs('ob', 'b', 5)]
  const r = findMinimalRepairs(events, cs, obs)
  assert(r.found && r.disableCount === 1, '观测-约束混合冲突：停用唯一相对约束即可修复')
  assert(r.plans[0].disableConstraintIds[0] === 'c1', '停用的是相对约束而非观测')
  assert(!r.observationConflict, '存在可停用约束时不标记纯观测冲突')
}

// ---- 最小修复：纯观测矛盾无法靠停用约束消除 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }]
  const obs: TimeObservation[] = [exactObs('o1', 'x', 0), exactObs('o2', 'x', 30)]
  const r = findMinimalRepairs(events, [], obs)
  assert(!r.found, '纯观测矛盾找不到约束停用方案')
  assert(r.observationConflict, '明确标记需要核对观测记录')
}

// ---- 最小修复：观测环上没有可停用约束（约束不在该环上）时标记观测冲突 ----
{
  // X 两条冲突观测；另有一条与矛盾无关的 Y 约束——它不可能修复 X 的环
  const events: TEvent[] = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]
  const cs: Constraint[] = [
    { id: 'g1', aId: 'y', bId: 'x', relation: 'later', min: 0, max: 100, enabled: true },
  ]
  const obs: TimeObservation[] = [exactObs('o1', 'x', 0), exactObs('o2', 'x', 30)]
  const r = findMinimalRepairs(events, cs, obs)
  assert(!r.found && r.observationConflict, '无关约束不能修复观测矛盾，标记观测冲突')
}

// ---- 最小修复：两个互不相交的相对负环需各停 1 条（最少 2 条，9 个并列方案）----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
    { id: 'd', name: 'D' }, { id: 'e', name: 'E' }, { id: 'f', name: 'F' },
  ]
  const cs: Constraint[] = [
    // 环 1：A-B-C
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'a', bId: 'c', relation: 'later', min: 10, max: 30, enabled: true },
    // 环 2：D-E-F
    { id: 'c4', aId: 'e', bId: 'd', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c5', aId: 'f', bId: 'e', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c6', aId: 'd', bId: 'f', relation: 'later', min: 10, max: 30, enabled: true },
  ]
  assert(!analyze(events, cs, []).satisfiable, '双环系统存在矛盾')
  const r = findMinimalRepairs(events, cs, [])
  assert(r.found && r.disableCount === 2, '双环最少停用 2 条')
  assert(r.totalPlans === 9, `9 个并列方案（3×3，实际 ${r.totalPlans}）`)
  assert(r.plans.length === MAX_PLANS, '最多展示 5 个')
  assert(!r.truncated, '9 个状态的搜索远未达上限，不截断')

  // 每个方案必须两环各命中一条
  for (const plan of r.plans) {
    const idx = plan.disableConstraintIds.map((id) => cs.findIndex((c) => c.id === id))
    assert(idx.length === 2, '方案停用 2 条')
    assert(idx[0] < 3 && idx[1] >= 3, '两环各停用 1 条')
  }
  // 展示的是字典序最小的 5 个：[0,3],[0,4],[0,5],[1,3],[1,4]
  const firstFive = r.plans.map((p) =>
    p.disableConstraintIds.map((id) => cs.findIndex((c) => c.id === id)),
  )
  assert(
    JSON.stringify(firstFive) === JSON.stringify([[0, 3], [0, 4], [0, 5], [1, 3], [1, 4]]),
    '截断展示录入顺序最靠前的 5 个',
  )
}

// ---- 最小修复：两环共用一条约束时，停用该共用约束为唯一最优 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
    { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
  ]
  const cs: Constraint[] = [
    { id: 'g', aId: 'a', bId: 'b', relation: 'earlier', min: 30, max: 40, enabled: true }, // 共用边
    { id: 'x', aId: 'c', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'y', aId: 'b', bId: 'c', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'p', aId: 'd', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'q', aId: 'b', bId: 'd', relation: 'later', min: 0, max: 10, enabled: true },
  ]
  assert(!analyze(events, cs, [exactObs('o', 'a', 0)]).satisfiable, '双环（共用边）存在矛盾')
  const r = findMinimalRepairs(events, cs, [exactObs('o', 'a', 0)])
  assert(r.found && r.disableCount === 1, '共用约束使最少停用数为 1')
  assert(r.totalPlans === 1 && r.plans.length === 1, '唯一最优方案')
  assert(r.plans[0].disableConstraintIds[0] === 'g', '唯一方案即停用共用约束')
  // 停用共用约束后 A/B 仍有窗口：B 受 0..10 链路约束相对 A
  const wb = r.plans[0].windows.get(1)!
  assert(wb.status === 'bounded', '修复后 B 仍可定时')
}

// ---- 最小修复：状态数上限触发，明确标记可能不完备 ----
{
  const s = buildContradictionSample()
  // stateLimit = 1：只分析根状态（未分支）即达上限，找不到方案
  const r0 = findMinimalRepairs(s.events, s.constraints, s.observations, { stateLimit: 1 })
  assert(!r0.found, '上限 1（仅根状态）时未找到方案')
  assert(r0.truncated && !r0.optimumProven, '标记截断且最优性未证明')
  assert(r0.stateLimit === 1 && r0.statesVisited === 1, '回传上限与已访问状态数')

  // stateLimit = 3：根 + 2 个一层状态；三个环约束各停 1 条都可行，
  // 第 3 个并列方案未探索到 -> 找到最优但列表可能不完备
  const r1 = findMinimalRepairs(s.events, s.constraints, s.observations, { stateLimit: 3 })
  assert(r1.found && r1.disableCount === 1, '上限 3 时在第 1 层找到最优')
  assert(r1.truncated, '同层未探索完：标记截断（结果可能不完备）')
  assert(r1.plans.length === 2, '只展示已探索到的 2 个并列方案')

  // 双环系统：根 1 + 一层 3 个状态均不可行；上限 4 时第 2 层一个都未分析 -> 未找到且截断
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
    { id: 'd', name: 'D' }, { id: 'e', name: 'E' }, { id: 'f', name: 'F' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'a', bId: 'c', relation: 'later', min: 10, max: 30, enabled: true },
    { id: 'c4', aId: 'e', bId: 'd', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c5', aId: 'f', bId: 'e', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c6', aId: 'd', bId: 'f', relation: 'later', min: 10, max: 30, enabled: true },
  ]
  const r2 = findMinimalRepairs(events, cs, [], { stateLimit: 4 })
  assert(!r2.found && r2.truncated && !r2.optimumProven, '双环在上限 4 时截断且未找到方案')

  // 上限 5：根 + 3 个一层 + 1 个二层可行状态 -> 找到 1 个最优但截断
  const r3 = findMinimalRepairs(events, cs, [], { stateLimit: 5 })
  assert(r3.found && r3.disableCount === 2 && r3.truncated, '上限 5 时找到二层最优但截断')
  assert(r3.totalPlans === 1 && r3.optimumProven, '最少停用数 2 仍被证明，并列方案不全')
}

// ---- 最小修复：常量默认值 ----
{
  assert(DEFAULT_STATE_LIMIT === 2000, '默认搜索上限为 2000 个状态')
  assert(MAX_PLANS === 5, '并列方案最多展示 5 个')
}

// ---- 最小修复：可满足系统无需修复 ----
{
  const s = buildConsistentSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.observations)
  assert(r.found && r.plans.length === 0 && r.disableCount === 0, '可满足系统返回空方案、停用数 0')
  assert(!r.truncated && r.optimumProven, '可满足系统不截断')
}

// ---- 最小修复：已停用 / 引用缺失事件的约束不进入候选 ----
{
  const s = buildContradictionSample()
  const disabled = s.constraints.map((c, i) =>
    i === 0 ? { ...c, enabled: false } : c,
  )
  // 停用环上第一条后系统本应恢复，这里再验证修复搜索候选不含已停用约束
  const stillConflict = analyze(s.events, disabled, s.observations)
  assert(stillConflict.satisfiable, '手动停用环上一条后矛盾消除（与修复建议等价）')
  const r = findMinimalRepairs(s.events, disabled, s.observations)
  assert(r.found && r.disableCount === 0 && r.plans.length === 0, '已无可修复矛盾')
}

// ==================== 边界依据追溯 ====================

// ---- 边界追溯：精确观测事件的零步证明 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const alert = byName.get('值班告警触发')!
  for (const kind of ['earliest', 'latest'] as const) {
    const t = traceBound(s.events, s.constraints, s.observations, alert, kind)!
    assert(t !== null, `追溯：精确观测事件 ${kind} 可追溯`)
    assert(t.steps.length === 0 && t.offset === 0, `追溯：精确观测 ${kind} 为零步证明`)
    assert(t.directObservationId === s.observations[0].id, '追溯：零步证明记录直接观测 id')
  }
}

// ---- 边界追溯：可满足示例的最晚边界（t0 -> 观测边 -> 紧约束链）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const alert = byName.get('值班告警触发')!

  // 介入最晚 +5：t0 --观测0--> 告警 --上界+5--> 介入，共 2 步
  const t1 = traceBound(s.events, s.constraints, s.observations, byName.get('值班工程师介入')!, 'latest')!
  assert(t1.offset === 5, '追溯：介入最晚偏移 +5')
  assert(t1.steps.length === 2, '追溯：介入最晚为观测边 + 单步约束链')
  assert(t1.steps[0].edge.kind === 'observation' && t1.steps[0].from === s.events.length, '追溯：第 1 步自时间原点的观测边')
  assert(t1.steps[1].edge.bound === 'upper' && t1.steps[1].edge.w === 5, '追溯：第 2 步采用上界侧 +5')
  assert(t1.steps[0].to === alert && t1.steps[1].to === byName.get('值班工程师介入')!, '追溯：链从 t0 指向目标')
  assert(t1.steps[1].cumulative === 5, '追溯：累计偏移 +5')

  // 恢复最晚 +20：t0 -> 告警(0) -> 恢复(+20)，2 步
  const t2 = traceBound(s.events, s.constraints, s.observations, byName.get('服务恢复')!, 'latest')!
  assert(t2.offset === 20 && t2.steps.length === 2, '追溯：恢复最晚 +20 为观测边 + 单步直达')
  assert(t2.steps[1].edge.w === 20 && t2.steps[1].cumulative === 20, '追溯：恢复最晚累计 +20')
}

// ---- 边界追溯：最早边界正确还原反向图路径（含观测边）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const origin = s.events.length
  const alert = byName.get('值班告警触发')!
  const onCall = byName.get('值班工程师介入')!
  const recovered = byName.get('服务恢复')!

  // 介入最早 +2：反向图上 t0 -> 告警（观测下界反向）-> 介入（约束下界反向）
  const t1 = traceBound(s.events, s.constraints, s.observations, onCall, 'earliest')!
  assert(t1.offset === 2, '追溯：介入最早偏移 +2')
  assert(t1.steps.length === 2, '追溯：介入最早为观测边 + 单步链')
  const s0 = t1.steps[0]
  assert(s0.edge.kind === 'observation' && s0.from === origin && s0.to === alert, '追溯：最早链第 1 步还原观测边 t0→告警')
  assert(s0.cumulative === 0, '追溯：观测步累计 0')
  const s1 = t1.steps[1]
  assert(s1.edge.bound === 'lower' && s1.edge.w === -2, '追溯：采用下界侧（权 −2）')
  assert(s1.edge.u === onCall && s1.edge.v === alert, '追溯：最早边界还原为原始约束边方向')
  assert(s1.from === alert && s1.to === onCall, '追溯：行走方向从告警到介入')
  assert(s1.cumulative === 2, '追溯：最早累计偏移 +2')

  // 恢复最早 +10：t0→告警（观测）→介入→定位→恢复（−2,−3,−5），共 4 步
  const t2 = traceBound(s.events, s.constraints, s.observations, recovered, 'earliest')!
  assert(t2.offset === 10, '追溯：恢复最早偏移 +10')
  assert(t2.steps.length === 4, '追溯：恢复最早为观测边 + 3 步约束链')
  assert(t2.steps[0].from === origin, '追溯：链起点为时间原点')
  assert(t2.steps[3].to === recovered, '追溯：链终点为目标事件')
  for (let i = 1; i < t2.steps.length; i++) {
    assert(t2.steps[i].from === t2.steps[i - 1].to, `追溯：第 ${i + 1} 步与上一步首尾相接`)
  }
  assert(
    JSON.stringify(t2.steps.map((x) => x.cumulative)) === JSON.stringify([0, 2, 5, 10]),
    '追溯：累计偏移依次为 0, 2, 5, 10',
  )
  assert(
    t2.steps.slice(1).every((x) => x.edge.bound === 'lower') &&
      JSON.stringify(t2.steps.slice(1).map((x) => x.edge.w)) === JSON.stringify([-2, -3, -5]),
    '追溯：约束各步均为下界侧，权重 −2/−3/−5',
  )
  // 每步的 edge 必须是原始系统中的真实边（u/v 未被反向图污染）
  const sys = buildSystem(s.events, s.constraints, s.observations)
  for (const st of t2.steps) {
    assert(
      sys.edges.some(
        (e) =>
          e.u === st.edge.u &&
          e.v === st.edge.v &&
          e.w === st.edge.w &&
          e.kind === st.edge.kind &&
          (e.kind === 'observation' ? e.observationId === st.edge.observationId : e.constraintId === st.edge.constraintId) &&
          e.bound === st.edge.bound,
      ),
      '追溯：最早链上的边均来自原始系统（反向路径已正确还原）',
    )
  }
}

// ---- 边界追溯：非零宽观测边也可作为链的一步（不触发零步证明）----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }]
  const obs: TimeObservation[] = [{ id: 'o1', eventId: 'x', start: isoPlus(0), end: isoPlus(8) }]
  const tl = traceBound(events, [], obs, 0, 'latest')!
  const te = traceBound(events, [], obs, 0, 'earliest')!
  assert(tl.steps.length === 1 && tl.offset === 8 && tl.directObservationId === null, '追溯：区间观测最晚为 1 步 +8')
  assert(te.steps.length === 1 && te.offset === 0 && te.directObservationId === null, '追溯：区间观测最早为 1 步 0')
}

// ---- 边界追溯：全部事件的追溯值与时间窗一致（性质校验）----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.observations)
  for (let i = 0; i < s.events.length; i++) {
    const w = r.windows.get(i)!
    for (const kind of ['earliest', 'latest'] as const) {
      const t = traceBound(s.events, s.constraints, s.observations, i, kind)
      const offset = kind === 'earliest' ? w.earliestOffset : w.latestOffset
      if (offset === null) {
        assert(t === null, `追溯：${s.events[i].name} ${kind} 无界时返回 null`)
        continue
      }
      assert(t !== null && t.offset === offset, `追溯：${s.events[i].name} ${kind} 偏移与时间窗一致`)
      if (!t) continue
      // 非零步链：链首尾正确、步步相接、累计收敛到边界值
      if (t.steps.length === 0) continue
      assert(t.steps[0].from === s.events.length, `追溯：${s.events[i].name} ${kind} 链起于时间原点`)
      assert(t.steps[t.steps.length - 1].to === i, `追溯：${s.events[i].name} ${kind} 链终于目标`)
      let contiguous = true
      for (let k = 1; k < t.steps.length; k++) {
        if (t.steps[k].from !== t.steps[k - 1].to) contiguous = false
      }
      assert(contiguous, `追溯：${s.events[i].name} ${kind} 链步步相接`)
      const sum = t.steps.reduce((a, st) => a + st.edge.w, 0)
      assert(
        kind === 'latest' ? sum === t.offset : sum === -t.offset,
        `追溯：${s.events[i].name} ${kind} 权重和与边界一致`,
      )
      assert(
        t.steps[t.steps.length - 1].cumulative === t.offset,
        `追溯：${s.events[i].name} ${kind} 末步累计即边界值`,
      )
    }
  }
}

// ---- 边界追溯：无观测 / 无法定时 / 非法下标 / 停用约束后重算 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))

  // 无观测：无时间基准，全部不可追溯
  assert(traceBound(s.events, s.constraints, [], 0, 'latest') === null, '追溯：无观测返回 null')
  assert(traceBound(s.events, s.constraints, s.observations, 999, 'latest') === null, '追溯：非法事件下标返回 null')

  // 无法定时（媒体报道）：两侧均不可追溯
  const press = byName.get('媒体报道')!
  assert(traceBound(s.events, s.constraints, s.observations, press, 'earliest') === null, '追溯：无法定时事件最早返回 null')
  assert(traceBound(s.events, s.constraints, s.observations, press, 'latest') === null, '追溯：无法定时事件最晚返回 null')

  // 模拟修复预览：停用「恢复 晚于 告警 8~20」后，恢复最晚边界改走观测边 + 4 步链（+25）
  const recovered = byName.get('服务恢复')!
  const overall = s.constraints.find((c) => c.min === 8 && c.max === 20)!
  const previewed = s.constraints.map((c) => (c.id === overall.id ? { ...c, enabled: false } : c))
  const t = traceBound(s.events, previewed, s.observations, recovered, 'latest')!
  assert(t.offset === 25 && t.steps.length === 5, '追溯：停用整体约束后最晚边界按有效约束重算为 +25（观测边 + 4 步）')
  assert(
    JSON.stringify(t.steps.map((s2) => s2.cumulative)) === JSON.stringify([0, 5, 15, 21, 25]),
    '追溯：重算链累计偏移 0/5/15/21/25',
  )
  assert(!t.steps.some((s2) => s2.edge.constraintId === overall.id), '追溯：重算链不含已停用约束')
}

// ==================== 旧存档迁移 ====================

// ---- 旧版单锚点存档自动迁移为一条精确观测 ----
{
  const m = migrateState({
    events: [{ id: 'a', name: 'A' }],
    constraints: [],
    anchorId: 'a',
    anchorTime: ANCHOR_ISO,
  } as never)
  assert(m.observations.length === 1, '迁移：产生 1 条观测')
  const o = m.observations[0]
  assert(o.eventId === 'a' && o.start === ANCHOR_ISO && o.end === ANCHOR_ISO, '迁移：锚点 → 锚点事件上的零宽精确观测')
  assert(!!o.id, '迁移：观测有新 id')
  // 迁移后的语义：A 被钉在 08:00
  const r = analyze(m.events, m.constraints, m.observations)
  assert(r.baseISO === ANCHOR_ISO && r.windows.get(0)!.latestOffset === 0, '迁移：分析结果与显式精确观测一致')
}

// ---- 迁移：锚点事件已不存在 / 时间无效时不产生观测 ----
{
  const m1 = migrateState({ events: [], constraints: [], anchorId: 'gone', anchorTime: ANCHOR_ISO } as never)
  assert(m1.observations.length === 0, '迁移：锚点事件缺失则不迁移')
  const m2 = migrateState({
    events: [{ id: 'a', name: 'A' }], constraints: [], anchorId: 'a', anchorTime: 'bad',
  } as never)
  assert(m2.observations.length === 0, '迁移：锚点时间无效则不迁移')
}

// ---- 迁移：已有 observations 字段时保留并清洗；旧期望/优先级缺省兼容 ----
{
  const m = migrateState({
    events: [{ id: 'a', name: 'A' }],
    constraints: [],
    observations: [
      { id: 'o1', eventId: 'a', start: isoPlus(0), end: isoPlus(10) },
      { id: 'o2', eventId: 'gone', start: isoPlus(0), end: isoPlus(0) }, // 引用缺失：删除
      { id: 'o3', eventId: 'a', start: isoPlus(10), end: isoPlus(0) },   // end<start：夹为精确
    ],
  } as never)
  assert(m.observations.length === 2, '迁移：保留 2 条有效观测')
  assert(m.observations.find((o) => o.id === 'o3')!.end === isoPlus(10), '迁移：非法区间归一为精确时刻')

  const m2 = migrateState({
    events: [{ id: 'a', name: 'A' }],
    constraints: [],
    observations: [],
    desiredPriorities: { a: 'bogus', b: 'high' } as never,
  })
  assert(!('a' in m2.desiredPriorities), '迁移：非法优先级被过滤')
  assert(Object.keys(m2.desiredTimes).length === 0, '迁移：缺期望字段补空表')
}

// ==================== 分层最小偏差排程 ====================

/** 取某一层（高/中/低）的结果 */
function layerOf(r: ScheduleResult, level: PriorityLevel): LayerResult {
  return r.layers.find((l) => l.level === level)!
}

/** 性质校验：排程满足全部启用约束/观测、每个期望偏差均在其所属层的 ±D 内 */
function scheduleFeasible(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
  r: ScheduleResult,
  baseISO: string,
): boolean {
  const idx = new Map(events.map((e, i) => [e.id, i]))
  const ms = (iso: string) => Math.round((new Date(iso).getTime() - new Date(baseISO).getTime()) / 60000)
  for (const o of observations) {
    const i = idx.get(o.eventId)
    if (i === undefined) continue
    const t = r.entries[i].offsetMin
    if (t === null) continue
    if (t < ms(o.start) - 1e-9 || t > ms(o.end) + 1e-9) return false
  }
  for (const c of constraints) {
    if (!c.enabled) continue
    const ia = idx.get(c.aId)
    const ib = idx.get(c.bId)
    if (ia === undefined || ib === undefined) continue
    const ta = r.entries[ia].offsetMin
    const tb = r.entries[ib].offsetMin
    if (ta === null || tb === null) continue // 未连通分量不参与
    const diff = c.relation === 'earlier' ? tb! - ta! : ta! - tb!
    if (diff < c.min - 1e-9 || diff > c.max + 1e-9) return false
  }
  return r.entries.every((en) => {
    if (en.deviation === null) return true
    const layer = layerOf(r, en.priority!)
    return layer.D !== null && Math.abs(en.deviation) <= layer.D + 1e-9
  })
}

// ---- 分层排程：全部默认「中」时退化为单层最小最大偏差（示例 D=5，恢复达到 −D）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const recovered = byName.get('服务恢复')!
  const postmortem = byName.get('复盘会议')!
  const press = byName.get('媒体报道')!
  const base = s.observations[0].start
  const desired: Record<string, string> = {
    [s.events[recovered].id]: isoPlus(25, base),
    [s.events[postmortem].id]: isoPlus(120, base),
  }
  const r = computeMinDeviationSchedule(s.events, s.constraints, s.observations, desired, {})!
  assert(r !== null, '排程：示例可计算')
  assert(r.layers.length === 3, '排程：固定输出高、中、低三层')
  const lm = layerOf(r, 'medium')
  assert(lm.D === 5, `排程：默认层级下中层最优 D=5（实际 ${lm.D}）`)
  assert(lm.count === 2 && r.desiredCount === 2, '排程：2 个期望事件参与整体搜索')
  assert(layerOf(r, 'high').count === 0 && layerOf(r, 'high').D === null, '排程：高层无参与事件')
  assert(layerOf(r, 'low').count === 0, '排程：低层无参与事件')
  const enRec = r.entries[recovered]
  assert(enRec.status === 'scheduled' && enRec.offsetMin === 20, '排程：恢复被钉在窗口端点 +20')
  assert(enRec.deviation === -5, '排程：恢复偏差 −5（达到 −D）')
  assert(enRec.priority === 'medium', '排程：未指定层级时按「中」')
  assert(lm.tightEventIdx.includes(recovered), '排程：恢复列入中层达到 ±D 的事件')
  assert(lm.maxDeviation === 5, '排程：中层最大偏差恰为 D=5')
  const enPost = r.entries[postmortem]
  assert(enPost.deviation !== null && Math.abs(enPost.deviation) <= 5, '排程：复盘偏差在中层 ±D 内')
  const enPress = r.entries[press]
  assert(enPress.status === 'unscheduled' && enPress.offsetMin === null, '排程：未连通事件标记未定时')
  assert(scheduleFeasible(s.events, s.constraints, s.observations, r, s.observations[0].start), '排程：输出满足全部观测、启用约束且各层偏差 ≤ 本层 D')
}

// ---- 分层排程：内置示例（恢复=高、复盘=低）按 高→中→低 字典序求解 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const recovered = byName.get('服务恢复')!
  const postmortem = byName.get('复盘会议')!
  const r = computeMinDeviationSchedule(
    s.events, s.constraints, s.observations, s.desiredTimes, s.desiredPriorities,
  )!
  assert(r !== null, '排程：内置示例可计算')
  const lh = layerOf(r, 'high')
  const ll = layerOf(r, 'low')
  assert(lh.D === 5 && lh.count === 1, `排程：内置示例高层 D=5（实际 ${lh.D}）`)
  assert(lh.tightEventIdx.includes(recovered), '排程：恢复达到高层 ±D')
  assert(layerOf(r, 'medium').count === 0, '排程：内置示例中层为空')
  assert(ll.D === 0 && ll.count === 1, `排程：高层容差固定后低层 D=0（实际 ${ll.D}）`)
  assert(ll.tightEventIdx.includes(postmortem), '排程：复盘达到低层 ±D（偏差 0）')
  assert(r.entries[recovered].priority === 'high' && r.entries[postmortem].priority === 'low', '排程：条目标注各自层级')
  assert(scheduleFeasible(s.events, s.constraints, s.observations, r, s.observations[0].start), '排程：内置示例输出可行')
}

// ---- 分层排程：整体可满足性搜索，不能独立夹窗 ----
{
  // t_Y = t_X + 5 使两事件耦合：各自窗口为 X∈[0,5]、Y∈[5,10]。
  // 期望 X=+10、Y=0 时，独立夹窗把 X 夹到 5、Y 夹到 5（各偏差 5）会误判 D=5；
  // 但 t_X=5 ⇒ t_Y=10（偏差 10），整体最小偏差实为 D=8。
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'x', name: 'X' }, { id: 'y', name: 'Y' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'x', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c2', aId: 'y', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c3', aId: 'y', bId: 'x', relation: 'later', min: 5, max: 5, enabled: true },
  ]
  const obs = [exactObs('o0', 'a', 0)]
  const win = analyze(events, cs, obs)
  const wx = win.windows.get(1)!
  const wy = win.windows.get(2)!
  assert(wx.earliestOffset === 0 && wx.latestOffset === 5, '排程：X 窗口被耦合收紧为 [0,5]')
  assert(wy.earliestOffset === 5 && wy.latestOffset === 10, '排程：Y 窗口被耦合收紧为 [5,10]')
  const r = computeMinDeviationSchedule(events, cs, obs, { x: isoPlus(10), y: isoPlus(0) }, {})!
  const lm = layerOf(r, 'medium')
  assert(lm.D === 8, `排程：耦合系统整体搜索得 D=8（实际 ${lm.D}），独立夹窗会误判为 5`)
  assert(lm.maxDeviation === 8 && lm.tightEventIdx.length >= 1, '排程：耦合系统有事件达到 ±D')
  assert(scheduleFeasible(events, cs, obs, r, ANCHOR_ISO), '排程：耦合系统输出可行')
}

// ---- 分层排程：字典序——高层先把偏差压到 0，低层承担全部耦合代价 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'x', name: 'X' }, { id: 'y', name: 'Y' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'x', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c2', aId: 'y', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'c3', aId: 'y', bId: 'x', relation: 'later', min: 0, max: 0, enabled: true }, // t_Y = t_X
  ]
  const obs = [exactObs('o0', 'a', 0)]
  const flat = computeMinDeviationSchedule(events, cs, obs, { x: isoPlus(10), y: isoPlus(0) }, {})!
  assert(layerOf(flat, 'medium').D === 5, '排程：同层平级时最小最大偏差 D=5（对照组）')

  const r = computeMinDeviationSchedule(
    events, cs, obs,
    { x: isoPlus(10), y: isoPlus(0) },
    { x: 'high', y: 'low' },
  )!
  const lh = layerOf(r, 'high')
  const ll = layerOf(r, 'low')
  assert(lh.D === 0, `排程：字典序下高层 D=0（实际 ${lh.D}）`)
  assert(ll.D === 10, `排程：高层容差固定后低层 D=10（实际 ${ll.D}）`)
  const enX = r.entries[1]
  const enY = r.entries[2]
  assert(enX.offsetMin === 10 && enX.deviation === 0, '排程：X 精确达到期望（高层零偏差）')
  assert(enY.offsetMin === 10 && enY.deviation === 10, '排程：Y 承担全部耦合代价（低层偏差 10）')
  assert(lh.tightEventIdx.includes(1) && ll.tightEventIdx.includes(2), '排程：各层达到 ±D 的事件正确')
  assert(scheduleFeasible(events, cs, obs, r, ANCHOR_ISO), '排程：字典序输出满足全部约束与各层容差')
}

// ---- 分层排程：高层非零容差被固定后限制低层 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'x', name: 'X' }, { id: 'y', name: 'Y' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'x', bId: 'a', relation: 'later', min: 0, max: 20, enabled: true },
    { id: 'c2', aId: 'y', bId: 'x', relation: 'later', min: 5, max: 5, enabled: true },
  ]
  const obs = [exactObs('o0', 'a', 0)]
  const r = computeMinDeviationSchedule(
    events, cs, obs,
    { x: isoPlus(25), y: isoPlus(40) },
    { x: 'high', y: 'low' },
  )!
  assert(layerOf(r, 'high').D === 5, '排程：高层 D=5（期望超出窗口 5 分钟）')
  assert(layerOf(r, 'low').D === 15, `排程：高层容差固定后低层 D=15（实际 ${layerOf(r, 'low').D}）`)
  assert(r.entries[1].offsetMin === 20 && r.entries[2].offsetMin === 25, '排程：X 钉在 20、Y 钉在 25')
  assert(scheduleFeasible(events, cs, obs, r, ANCHOR_ISO), '排程：固定容差场景输出可行')
}

// ---- 分层排程：三层独立事件各自求解 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'x', name: 'X' }, { id: 'y', name: 'Y' }, { id: 'z', name: 'Z' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'x', bId: 'a', relation: 'later', min: 0, max: 20, enabled: true },
    { id: 'c2', aId: 'y', bId: 'a', relation: 'later', min: 0, max: 8, enabled: true },
    { id: 'c3', aId: 'z', bId: 'a', relation: 'later', min: 0, max: 6, enabled: true },
  ]
  const obs = [exactObs('o0', 'a', 0)]
  const r = computeMinDeviationSchedule(
    events, cs, obs,
    { x: isoPlus(25), y: isoPlus(10), z: isoPlus(-5) },
    { x: 'high', y: 'medium', z: 'low' },
  )!
  assert(layerOf(r, 'high').D === 5, '排程：三层场景高层 D=5')
  assert(layerOf(r, 'medium').D === 2, '排程：三层场景中层 D=2')
  assert(layerOf(r, 'low').D === 5, '排程：三层场景低层 D=5')
  assert(r.desiredCount === 3, '排程：三层共 3 个期望事件')
  assert(
    r.entries[1].offsetMin === 20 && r.entries[2].offsetMin === 8 && r.entries[3].offsetMin === 0,
    '排程：三层事件各自钉在窗口最近端点',
  )
  assert(scheduleFeasible(events, cs, obs, r, ANCHOR_ISO), '排程：三层场景输出可行')
}

// ---- 分层排程：基准不在首条事件上（观测在 +60，期望使用绝对时刻换算仍正确）----
{
  // 对 X 的观测为 09:00（基准 09:00），X ∈ 精确 0；期望 09:10，约束无 => D=10 且 X=0
  const events: TEvent[] = [{ id: 'x', name: 'X' }]
  const base = '2026-01-01T09:00'
  const obs = [exactObs('o1', 'x', 0, base)]
  const r = computeMinDeviationSchedule(events, [], obs, { x: isoPlus(10, base) }, {})!
  assert(layerOf(r, 'medium').D === 10, '排程：基准 09:00 下期望 09:10 的偏差为 10')
  assert(r.entries[0].offsetMin === 0, '排程：X 固定在基准偏移 0（= 09:00）')
  assert(scheduleFeasible(events, [], obs, r, base), '排程：非整点基准场景可行')
}

// ---- 分层排程：无可参与期望 / 前提不满足时返回 null ----
{
  const s = buildConsistentSample()
  assert(
    computeMinDeviationSchedule(s.events, s.constraints, s.observations, {}, {}) === null,
    '排程：未填写期望返回 null',
  )
  const pressId = s.events.find((e) => e.name === '媒体报道')!.id
  assert(
    computeMinDeviationSchedule(s.events, s.constraints, s.observations, { [pressId]: isoPlus(30) }, { [pressId]: 'high' }) === null,
    '排程：期望仅在未连通事件上时返回 null（即使标了高优先级）',
  )
  assert(
    computeMinDeviationSchedule(s.events, s.constraints, [], { [s.events[1].id]: isoPlus(5) }, {}) === null,
    '排程：无观测返回 null',
  )
  const bad = buildContradictionSample()
  assert(
    computeMinDeviationSchedule(bad.events, bad.constraints, bad.observations, {
      [bad.events[1].id]: isoPlus(15),
    }, {}) === null,
    '排程：矛盾系统返回 null（不输出旧结果）',
  )
}

// ---- 分层排程：期望全部可达时各层 D=0；相同输入输出确定一致 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const base = s.observations[0].start
  const desired = {
    [s.events[byName.get('服务恢复')!].id]: isoPlus(15, base),
    [s.events[byName.get('复盘会议')!].id]: isoPlus(120, base),
  }
  const prio = { [s.events[byName.get('服务恢复')!].id]: 'high' as const }
  const r = computeMinDeviationSchedule(s.events, s.constraints, s.observations, desired, prio)!
  assert(layerOf(r, 'high').D === 0 && layerOf(r, 'medium').D === 0, '排程：期望全部可达时各层 D=0')
  assert(
    r.entries.every((en) => en.deviation === null || en.deviation === 0),
    '排程：D=0 时全部期望偏差为 0',
  )
  assert(scheduleFeasible(s.events, s.constraints, s.observations, r, base), '排程：D=0 输出可行')

  const mk = () =>
    computeMinDeviationSchedule(
      s.events, s.constraints, s.observations,
      { [s.events[byName.get('服务恢复')!].id]: isoPlus(25, base) },
      { [s.events[byName.get('服务恢复')!].id]: 'low' },
    )
  assert(JSON.stringify(mk()) === JSON.stringify(mk()), '排程：相同输入输出确定一致')
}

// ---- 分层排程：未连通事件的期望与层级被忽略并明确标记 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const press = byName.get('媒体报道')!
  const base = s.observations[0].start
  const r = computeMinDeviationSchedule(
    s.events, s.constraints, s.observations,
    {
      [s.events[byName.get('服务恢复')!].id]: isoPlus(25, base),
      [s.events[press].id]: isoPlus(50, base),
    },
    { [s.events[press].id]: 'high' },
  )!
  assert(r.desiredCount === 1, '排程：未连通事件的期望不参与搜索（仅 1 个有效期望）')
  assert(layerOf(r, 'high').count === 0, '排程：未连通事件的高层级不进入高层搜索')
  const enPress = r.entries[press]
  assert(enPress.status === 'unscheduled' && enPress.desiredIgnored, '排程：未连通事件标记未定时且期望被忽略')
  assert(enPress.desiredOffset === 50, '排程：被忽略的期望仍记录偏移以便展示')
  assert(enPress.priority === 'high', '排程：被忽略的期望仍记录层级以便展示')
}

// ---- 分层排程：多条观测锚定不同事件时期望偏移按统一基准换算 ----
{
  // A 精确 08:00；B 精确 08:20；A、B 间无约束。期望 B = 08:20 => 偏差 0；期望 A = 08:05 => D=5
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const obs: TimeObservation[] = [exactObs('oa', 'a', 0), exactObs('ob', 'b', 20)]
  const r = computeMinDeviationSchedule(
    events, [], obs,
    { a: isoPlus(5), b: isoPlus(20) },
    { a: 'high', b: 'low' },
  )!
  assert(layerOf(r, 'high').D === 5, '排程：多观测下 A 的期望偏差按基准正确换算为 5')
  assert(layerOf(r, 'low').D === 0, '排程：多观测下 B 期望精确可达 D=0')
  assert(r.entries[0].offsetMin === 0 && r.entries[1].offsetMin === 20, '排程：两事件分别由各自观测定时')
  assert(scheduleFeasible(events, [], obs, r, ANCHOR_ISO), '排程：多锚定场景可行')
}

// ==================== 批量证词导入 DSL ====================

// ---- 基本解析：三类语句 + 注释 + 空行 + JSON 转义 ----
{
  const text = [
    '# 注释行被忽略',
    '',
    'EVENT "碰撞发生" | "路口\\n监控缺失"',
    'EVENT "救护车到达" | ""',
    'REL "碰撞发生" earlier "救护车到达" 8..25',
    'OBS "救护车到达" 2026-01-01T08:20..2026-01-01T08:35',
    '   ',
  ].join('\n')
  const r = parseDsl(text, [])
  assert(r.errors.length === 0, 'DSL：合法文本无错误')
  assert(r.lines.length === 4, 'DSL：空行与注释行不产生语句')
  assert(r.events.length === 2 && r.constraints.length === 1 && r.observations.length === 1, 'DSL：三类语句各归其类')
  assert(r.events[0].name === '碰撞发生' && r.events[0].note === '路口\n监控缺失', 'DSL：JSON 转义 \\n 正确解析')
  assert(r.events[1].note === '', 'DSL：空备注解析为空字符串')
  assert(r.constraints[0].min === 8 && r.constraints[0].max === 25 && r.constraints[0].relation === 'earlier', 'DSL：REL 区间与方向')
  assert(r.observations[0].start === '2026-01-01T08:20' && r.observations[0].end === '2026-01-01T08:35', 'DSL：OBS 时间区间')
  assert(r.lines[0].line === 3, 'DSL：行号按原始行定位（前 2 行为注释与空行）')
  assert(r.lines[2].targets.a?.existing === false && r.lines[2].targets.b?.existing === false, 'DSL：同批 EVENT 引用标记为本批新增')
}

// ---- 中文转义与空格分隔时间 ----
{
  const r = parseDsl('EVENT "A" | "\\u4f4f\\u9662" \nOBS "A" 2026-01-01 08:00..2026-01-01 08:00', [])
  assert(r.errors.length === 0, 'DSL：\\uXXXX 转义与空格分隔时间合法')
  assert(r.events[0].note === '住院', 'DSL：\\u 转义解析为中文')
  assert(r.observations[0].start === '2026-01-01T08:00' && r.observations[0].end === '2026-01-01T08:00', 'DSL：空格分隔时间归一为 T 分隔（精确时刻）')
}

// ---- 引用现有事件；现有重名事件导致引用不唯一 ----
{
  const existing: TEvent[] = [{ id: 'e1', name: '告警' }]
  const r = parseDsl('REL "告警" later "新事件" 1..5\nEVENT "新事件" | "n"', existing)
  assert(r.errors.length === 0, 'DSL：引用现有事件合法')
  assert(r.lines[0].targets.a?.existing === true, 'DSL：现有事件引用标记为现有')
  assert(r.lines[0].targets.b?.existing === false, 'DSL：同批声明引用标记为本批新增')

  const dup: TEvent[] = [{ id: 'e1', name: '告警' }, { id: 'e2', name: '告警' }]
  const r2 = parseDsl('OBS "告警" 2026-01-01T08:00..2026-01-01T08:00', dup)
  assert(r2.errors.length === 1 && r2.errors[0].line === 1 && r2.errors[0].message.includes('引用不唯一'), 'DSL：现有重名事件 → 引用不唯一并定位行号')
}

// ---- 重名 / 重复声明 ----
{
  const r = parseDsl('EVENT "A" | "x"\nEVENT "A" | "y"', [])
  assert(r.errors.length === 1 && r.errors[0].line === 2 && r.errors[0].message.includes('重复声明'), 'DSL：批内重复声明定位第二行')
  const r2 = parseDsl('EVENT "已有" | "x"', [{ id: 'e1', name: '已有' }])
  assert(r2.errors.length === 1 && r2.errors[0].message.includes('重名'), 'DSL：与现有事件重名被拒绝（不覆盖现有数据）')
}

// ---- 引用不存在 / 自引用 ----
{
  const r = parseDsl('REL "甲" earlier "乙" 1..2', [])
  assert(r.errors.length === 2 && r.errors.every((e) => e.line === 1 && e.message.includes('引用不存在')), 'DSL：两个未声明引用各报一次且定位行号')
  const r2 = parseDsl('EVENT "甲" | ""\nREL "甲" later "甲" 1..2', [])
  assert(r2.errors.length === 1 && r2.errors[0].line === 2 && r2.errors[0].message.includes('不能指向同一事件'), 'DSL：REL 自引用被拒绝')
}

// ---- 非法区间与时间格式 ----
{
  const r1 = parseDsl('EVENT "A" | ""\nEVENT "B" | ""\nREL "A" earlier "B" 30..8', [])
  assert(r1.errors.length === 1 && r1.errors[0].line === 3 && r1.errors[0].message.includes('非法区间'), 'DSL：min > max 报非法区间')
  const r2 = parseDsl('EVENT "A" | ""\nOBS "A" 2026-01-01T08:35..2026-01-01T08:20', [])
  assert(r2.errors.length === 1 && r2.errors[0].line === 2 && r2.errors[0].message.includes('非法区间'), 'DSL：OBS 终点早于起点报非法区间')
  const r3 = parseDsl('EVENT "A" | ""\nOBS "A" 2026-02-30T08:00..2026-03-01T08:00', [])
  assert(r3.errors.length === 1 && r3.errors[0].message.includes('时间格式非法'), 'DSL：不存在的日期被拒绝')
  const r4 = parseDsl('EVENT "A" | ""\nOBS "A" 2026-01-01T25:00..2026-01-01T26:00', [])
  assert(r4.errors.length === 1 && r4.errors[0].message.includes('时间格式非法'), 'DSL：小时 25 被拒绝')
  const r5 = parseDsl('EVENT "A" | ""\nOBS "A" 2026/01/01T08:00..2026/01/02T08:00', [])
  assert(r5.errors.length === 1 && r5.errors[0].message.includes('时间区间格式'), 'DSL：斜杠日期被拒绝')
  const r6 = parseDsl('EVENT "A" | ""\nEVENT "B" | ""\nREL "A" earlier "B" 1.5..3', [])
  assert(r6.errors.length === 1 && r6.errors[0].message.includes('分钟区间格式'), 'DSL：小数分钟被拒绝')
}

// ---- 语法错误：缺引号 / 缺竖线 / 尾部垃圾 / 未知关键字 / 非法转义 ----
{
  const r1 = parseDsl('EVENT 碰撞 | "n"', [])
  assert(r1.errors.length === 1 && r1.errors[0].message.includes('JSON 字符串'), 'DSL：名称未加引号报错')
  const r2 = parseDsl('EVENT "A" "n"', [])
  assert(r2.errors.length === 1 && r2.errors[0].message.includes('"|"'), 'DSL：缺少竖线报错')
  const r3 = parseDsl('EVENT "A" | "n" extra', [])
  assert(r3.errors.length === 1 && r3.errors[0].message.includes('尾部'), 'DSL：尾部多余内容报错')
  const r4 = parseDsl('FOO "A"', [])
  assert(r4.errors.length === 1 && r4.errors[0].message.includes('EVENT、REL 或 OBS'), 'DSL：未知语句类型报错')
  const r5 = parseDsl('EVENT "A" | "\\q"', [])
  assert(r5.errors.length === 1 && r5.errors[0].message.includes('非法 JSON 字符串'), 'DSL：非法转义报错')
  const r6 = parseDsl('EVENT "A" | "未闭合', [])
  assert(r6.errors.length === 1 && r6.errors[0].message.includes('结束引号'), 'DSL：未闭合字符串报错')
  const r7 = parseDsl('EVENT "A" | ""\nEVENT "B" | ""\nREL "A" middle "B" 1..2', [])
  assert(r7.errors.length === 1 && r7.errors[0].message.includes('earlier'), 'DSL：非法关系方向报错')
}

// ---- 同批 EVENT 声明顺序无关（前向引用合法）；lines 完整列出供逐行预览 ----
{
  const r = parseDsl('EVENT "A" | "x"\nREL "A" earlier "B" 1..2\nEVENT "B" | "y"', [])
  assert(r.errors.length === 0, 'DSL：同批 EVENT 声明顺序无关，前向引用合法')
  assert(r.lines.length === 3, 'DSL：三条语句全部进入预览')
}

// ---- 确认导入：实体生成与合并不覆盖现有数据 ----
{
  const existing: TEvent[] = [{ id: 'e1', name: '告警', note: '原有备注' }]
  const text = [
    'EVENT "介入" | "值班工程师"',
    'REL "介入" later "告警" 2..5',
    'OBS "告警" 2026-01-01T08:00..2026-01-01T08:00',
  ].join('\n')
  const r = parseDsl(text, existing)
  assert(r.errors.length === 0, 'DSL：混合现有/新增引用的文本无错误')
  const ent = buildImportEntities(r, existing)
  assert(ent.events.length === 1 && ent.events[0].name === '介入' && ent.events[0].note === '值班工程师', 'DSL：仅新增声明的事件')
  assert(ent.constraints.length === 1 && ent.constraints[0].aId === ent.events[0].id && ent.constraints[0].bId === 'e1', 'DSL：约束正确映射到新增/现有事件 id')
  assert(ent.constraints[0].enabled === true, 'DSL：导入的约束默认启用')
  assert(ent.observations.length === 1 && ent.observations[0].eventId === 'e1', 'DSL：观测挂到现有事件')
  assert(ent.eventIdByName.get('告警') === 'e1' && ent.eventIdByName.get('介入') === ent.events[0].id, 'DSL：名称→id 映射完整')
  // 合并后现有事件保持原样（不覆盖）
  const merged = [...existing, ...ent.events]
  assert(merged[0].id === 'e1' && merged[0].note === '原有备注', 'DSL：合并不覆盖现有事件')
  // 合并结果可直接进入图分析
  const ana = analyze(merged, ent.constraints, ent.observations)
  assert(ana.satisfiable && ana.baseISO === '2026-01-01T08:00', 'DSL：导入结果接入统一差分图')
}

// ==================== 冗余证词审计 ====================

// ---- 链式蕴含：被其余约束推出的证词标为冗余；边界相等也算落在区间内 ----
{
  // c1: Y 比 X 晚 5~10；c2: Z 比 Y 晚 5~10；c3: Z 比 X 晚 10~20；c4: Z 比 X 晚 12~18
  // 排除 c3 后由 c1+c2+c4 推出 t_Z − t_X ∈ [12,18] ⊆ [10,20] → 冗余
  const events: TEvent[] = [
    { id: 'x', name: 'X' }, { id: 'y', name: 'Y' }, { id: 'z', name: 'Z' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'y', bId: 'x', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c2', aId: 'z', bId: 'y', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'z', bId: 'x', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c4', aId: 'z', bId: 'x', relation: 'later', min: 12, max: 18, enabled: true },
  ]
  const entries = auditRedundancy(events, cs, [])
  assert(entries !== null, '可满足系统返回审计结果')
  assert(entries!.length === 4, '每条启用约束都有一条审计条目')
  assert(
    entries!.map((e) => e.constraintId).join(',') === 'c1,c2,c3,c4',
    '审计条目顺序与约束录入顺序一致',
  )
  const byId = new Map(entries!.map((e) => [e.constraintId, e]))
  // c1：排除后 t_Y − t_X ∈ [2,13]（由 c2+c3/c4 夹出），超出 [5,10] → 必要
  assert(byId.get('c1')!.verdict === 'necessary', 'c1 判为必要')
  assert(byId.get('c1')!.derivedMin === 2 && byId.get('c1')!.derivedMax === 13, 'c1 推导区间 [2,13]')
  // c2：排除后 t_Z − t_Y ∈ [2,13]，超出 [5,10] → 必要
  assert(byId.get('c2')!.verdict === 'necessary', 'c2 判为必要')
  assert(byId.get('c2')!.derivedMin === 2 && byId.get('c2')!.derivedMax === 13, 'c2 推导区间 [2,13]')
  // c3：推导 [12,18] 完整落在声称 [10,20] 内 → 冗余
  assert(byId.get('c3')!.verdict === 'redundant', 'c3 被其余约束蕴含，判为冗余')
  assert(byId.get('c3')!.derivedMin === 12 && byId.get('c3')!.derivedMax === 18, 'c3 推导区间 [12,18]')
  // c4：排除后 t_Z − t_X ∈ [10,20]，超出 [12,18] → 必要
  assert(byId.get('c4')!.verdict === 'necessary', 'c4 判为必要')
  assert(byId.get('c4')!.derivedMin === 10 && byId.get('c4')!.derivedMax === 20, 'c4 推导区间 [10,20]')
}

// ---- 边界相等也算落入：推导区间与证词区间完全相同 → 冗余 ----
{
  const events: TEvent[] = [
    { id: 'x', name: 'X' }, { id: 'y', name: 'Y' }, { id: 'z', name: 'Z' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'y', bId: 'x', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c2', aId: 'z', bId: 'y', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'z', bId: 'x', relation: 'later', min: 10, max: 20, enabled: true },
  ]
  const byId = new Map(auditRedundancy(events, cs, [])!.map((e) => [e.constraintId, e]))
  // 排除 c3 后由 c1+c2 恰好推出 t_Z − t_X ∈ [10,20]，与证词相同 → 冗余
  assert(byId.get('c3')!.verdict === 'redundant', '推导区间与证词区间相同也判冗余')
  assert(byId.get('c3')!.derivedMin === 10 && byId.get('c3')!.derivedMax === 20, 'c3 推导区间 [10,20]')
}

// ---- 观测参与推导：两条精确观测钉死两端，证词被观测蕴含 → 冗余 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'y', bId: 'x', relation: 'later', min: 20, max: 40, enabled: true },
  ]
  const obs = [exactObs('o1', 'x', 0), exactObs('o2', 'y', 30)]
  const entries = auditRedundancy(events, cs, obs)!
  assert(entries.length === 1, '单条约束一条审计条目')
  assert(entries[0].verdict === 'redundant', '观测钉死时差 30 ∈ [20,40]，证词判冗余')
  assert(entries[0].derivedMin === 30 && entries[0].derivedMax === 30, '推导区间退化为 +30 单点')
}

// ---- 观测推导超出证词声称范围 → 必要 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'y', bId: 'x', relation: 'later', min: 30, max: 40, enabled: true },
  ]
  // X 精确 0、Y ∈ [+25,+35]：排除证词后推出 t_Y − t_X ∈ [25,35]，下界 25 < 30 → 必要
  const obs = [exactObs('o1', 'x', 0), { id: 'o2', eventId: 'y', start: isoPlus(25), end: isoPlus(35) }]
  const entries = auditRedundancy(events, cs, obs)!
  assert(entries[0].verdict === 'necessary', '推导区间下界越出证词区间，判必要')
  assert(entries[0].derivedMin === 25 && entries[0].derivedMax === 35, '推导区间 [25,35]')
}

// ---- 无其他信息：排除后两端不连通，两侧均按无界处理 → 必要 ----
{
  const events: TEvent[] = [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'y', bId: 'x', relation: 'later', min: 5, max: 10, enabled: true },
  ]
  const entries = auditRedundancy(events, cs, [])!
  assert(entries[0].derivedMin === null && entries[0].derivedMax === null, '不可达的边界按无界处理（null）')
  assert(entries[0].verdict === 'necessary', '无界推导区间不落入侵证词区间 → 必要')
}

// ---- earlier 方向：差值按 t_B − t_A 推导 ----
{
  const events: TEvent[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'a', bId: 'b', relation: 'earlier', min: 5, max: 10, enabled: true },
  ]
  // A 精确 0、B ∈ [+7,+9]：排除证词后推出 t_B − t_A ∈ [7,9] ⊆ [5,10] → 冗余
  const obs = [exactObs('o1', 'a', 0), { id: 'o2', eventId: 'b', start: isoPlus(7), end: isoPlus(9) }]
  const entries = auditRedundancy(events, cs, obs)!
  assert(entries[0].verdict === 'redundant', 'earlier 方向按 t_B − t_A 推导并判冗余')
  assert(entries[0].derivedMin === 7 && entries[0].derivedMax === 9, 'earlier 推导区间 [7,9]')
}

// ---- 停用约束不参与审计，其边也不参与推导 ----
{
  const events: TEvent[] = [
    { id: 'x', name: 'X' }, { id: 'y', name: 'Y' }, { id: 'z', name: 'Z' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'y', bId: 'x', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c2', aId: 'z', bId: 'y', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'z', bId: 'x', relation: 'later', min: 10, max: 20, enabled: false },
    { id: 'c4', aId: 'z', bId: 'x', relation: 'later', min: 12, max: 18, enabled: true },
  ]
  const entries = auditRedundancy(events, cs, [])!
  assert(entries.length === 3, '停用约束不生成审计条目')
  assert(!entries.some((e) => e.constraintId === 'c3'), '停用约束不参与审计')
  // c4 的推导只经过 c1+c2（c3 已停用）：t_Z − t_X ∈ [10,20]，超出 [12,18] → 必要
  const e4 = entries.find((e) => e.constraintId === 'c4')!
  assert(e4.derivedMin === 10 && e4.derivedMax === 20, '停用约束的边不参与推导')
  assert(e4.verdict === 'necessary', 'c4 判为必要')
}

// ---- 矛盾系统：返回 null（暂停审计）----
{
  const s = buildContradictionSample()
  assert(auditRedundancy(s.events, s.constraints, s.observations) === null, '矛盾状态暂停审计（返回 null）')
  assert(auditRedundancy(s.events, s.constraints, []) === null, '无观测的纯相对矛盾同样暂停审计')
}

// ---- 空约束 / 全部停用：审计结果为空（而非暂停）----
{
  assert(auditRedundancy([], [], [])!.length === 0, '空系统审计为空')
  const s = buildConsistentSample()
  const allOff = s.constraints.map((c) => ({ ...c, enabled: false }))
  const entries = auditRedundancy(s.events, allOff, s.observations)
  assert(entries !== null && entries.length === 0, '全部停用时审计为空')
}

// ---- 可满足示例：每条启用约束一条审计条目，结论与手工推导一致 ----
{
  const s = buildConsistentSample()
  const entries = auditRedundancy(s.events, s.constraints, s.observations)!
  assert(entries.length === s.constraints.length, '可满足示例全部启用约束参与审计')
  const byId = new Map(entries.map((e) => [e.constraintId, e]))
  // 「恢复比告警晚 8~20」：排除后由链路推出 t_恢复 − t_告警 ∈ [10,25]，上界越出 → 必要
  const c5 = s.constraints[4]
  const e5 = byId.get(c5.id)!
  assert(e5.derivedMin === 10 && e5.derivedMax === 25, '整体约束推导区间 [10,25]')
  assert(e5.verdict === 'necessary', '整体约束判为必要')
  // 「介入比告警晚 2~5」：排除后推导 [−12,12] → 必要
  const e1 = byId.get(s.constraints[0].id)!
  assert(e1.derivedMin === -12 && e1.derivedMax === 12 && e1.verdict === 'necessary', '首条约束推导区间 [−12,12]')
  assert(entries.every((e) => e.verdict === 'necessary'), '可满足示例的证词全部为必要（无冗余）')
}

// ==================== 案卷快照：导出 / 导入完整校验 ====================

/** 构造一段快照 JSON 文本（默认带正确的格式标记与版本号） */
function snapText(data: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app: 'temporal-constraint-checker',
    kind: 'case-snapshot',
    version: 1,
    exportedAt: '2026-09-26T00:00:00.000Z',
    data,
    ...extra,
  })
}

/** 一份最小合法案卷数据 */
function minimalData() {
  return {
    events: [
      { id: 'e1', name: '甲' },
      { id: 'e2', name: '乙', note: '备注' },
    ],
    constraints: [
      { id: 'c1', aId: 'e1', bId: 'e2', relation: 'earlier', min: 5, max: 10, enabled: true },
    ],
    observations: [
      { id: 'o1', eventId: 'e1', start: '2026-01-01T08:00', end: '2026-01-01T08:30' },
    ],
    desiredTimes: { e2: '2026-01-01T09:00' },
    desiredPriorities: { e2: 'high' as const },
  }
}

/** 深拷贝一份最小合法数据，便于逐项破坏 */
function mutatedData(mutate: (d: ReturnType<typeof minimalData>) => void) {
  const d = JSON.parse(JSON.stringify(minimalData())) as ReturnType<typeof minimalData>
  mutate(d)
  return d
}

/** 键序无关的规范化序列化（undefined 字段忽略），用于往返一致性比较 */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(rec[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

// ---- 导出→校验往返：内置两套示例都能无损往返 ----
{
  for (const [label, s] of [
    ['可满足示例', buildConsistentSample()],
    ['矛盾示例', buildContradictionSample()],
  ] as const) {
    const v = validateSnapshot(serializeSnapshot(s))
    assert(v.ok, `快照往返：${label}校验通过`)
    assert(v.errors.length === 0, `快照往返：${label}无错误`)
    const st = v.state!
    assert(canon(st.events) === canon(s.events), `快照往返：${label}事件一致`)
    assert(canon(st.constraints) === canon(s.constraints), `快照往返：${label}约束一致`)
    assert(canon(st.observations) === canon(s.observations), `快照往返：${label}观测一致`)
    assert(canon(st.desiredTimes) === canon(s.desiredTimes), `快照往返：${label}期望时刻一致`)
    assert(
      canon(st.desiredPriorities) === canon(s.desiredPriorities),
      `快照往返：${label}优先级一致`,
    )
    assert(
      v.counts !== null &&
        v.counts.events === s.events.length &&
        v.counts.constraints === s.constraints.length &&
        v.counts.observations === s.observations.length &&
        v.counts.desiredTimes === Object.keys(s.desiredTimes).length &&
        v.counts.desiredPriorities === Object.keys(s.desiredPriorities).length,
      `快照往返：${label}记录数预览一致`,
    )
  }
  // 导出文本为带缩进的格式化 JSON
  assert(serializeSnapshot(buildConsistentSample()).includes('\n  "app"'), '快照导出为带缩进的格式化 JSON')
}

// ---- 最小合法数据：校验通过且状态可直接接入分析 ----
{
  const v = validateSnapshot(snapText(minimalData()))
  assert(v.ok && v.state !== null, '最小合法快照校验通过')
  assert(v.counts!.enabledConstraints === 1, '记录数预览统计启用约束数')
  const r = analyze(v.state!.events, v.state!.constraints, v.state!.observations)
  assert(r.satisfiable && r.baseISO === '2026-01-01T08:00', '导入状态可直接接入实时分析')
  // 无 note 的事件不补 note 字段；有 note 的原样保留
  assert(!('note' in v.state!.events[0]), '无备注事件不补 note 字段')
  assert(v.state!.events[1].note === '备注', '备注原样保留')
}

// ---- JSON 语法 / 根结构 / 格式标记与版本号 ----
{
  assert(!validateSnapshot('{ 这不是 JSON').ok, 'JSON 语法错误被拒绝')
  assert(validateSnapshot('{ 这不是 JSON').counts === null, 'JSON 语法错误时无记录数预览')
  assert(!validateSnapshot('[1,2,3]').ok, '根节点为数组被拒绝')
  assert(!validateSnapshot('"str"').ok, '根节点为字符串被拒绝')
  const noVersion = JSON.stringify({ app: 'temporal-constraint-checker', kind: 'case-snapshot', data: minimalData() })
  const vNoVer = validateSnapshot(noVersion)
  assert(!vNoVer.ok && vNoVer.errors.some((e) => e.path === '$.version'), '缺少版本号被拒绝')
  const vBadVer = validateSnapshot(snapText(minimalData(), { version: 2 }))
  assert(!vBadVer.ok && vBadVer.errors.some((e) => e.path === '$.version'), '不支持的版本号被拒绝')
  const vBadApp = validateSnapshot(snapText(minimalData(), { app: 'other-app' }))
  assert(!vBadApp.ok && vBadApp.errors.some((e) => e.path === '$.app'), '格式标记 app 不匹配被拒绝')
  const vBadKind = validateSnapshot(snapText(minimalData(), { kind: 'other' }))
  assert(!vBadKind.ok && vBadKind.errors.some((e) => e.path === '$.kind'), '格式标记 kind 不匹配被拒绝')
  const vNoData = validateSnapshot(JSON.stringify({ version: 1 }))
  assert(!vNoData.ok && vNoData.errors.some((e) => e.path === '$.data'), '缺少 data 被拒绝')
}

// ---- 字段类型校验 ----
{
  const v1 = validateSnapshot(snapText(mutatedData((d) => ((d as any).events = {}))))
  assert(!v1.ok && v1.errors.some((e) => e.path === 'data.events'), 'events 非数组被拒绝')
  const v2 = validateSnapshot(snapText(mutatedData((d) => ((d.events[0] as any).id = 7))))
  assert(!v2.ok && v2.errors.some((e) => e.path === 'data.events[0].id'), '事件 id 非字符串被拒绝')
  const v3 = validateSnapshot(snapText(mutatedData((d) => ((d.events[0] as any).name = 1))))
  assert(!v3.ok && v3.errors.some((e) => e.path === 'data.events[0].name'), '事件名非字符串被拒绝')
  const v4 = validateSnapshot(snapText(mutatedData((d) => ((d.events[1] as any).note = 42))))
  assert(!v4.ok && v4.errors.some((e) => e.path === 'data.events[1].note'), '事件备注非字符串被拒绝')
  const v5 = validateSnapshot(snapText(mutatedData((d) => ((d.constraints[0] as any).enabled = 'yes'))))
  assert(!v5.ok && v5.errors.some((e) => e.path === 'data.constraints[0].enabled'), 'enabled 非布尔被拒绝')
  const v6 = validateSnapshot(snapText(mutatedData((d) => ((d.constraints[0] as any).relation = 'before'))))
  assert(!v6.ok && v6.errors.some((e) => e.path === 'data.constraints[0].relation'), '非法关系方向被拒绝')
  const v7 = validateSnapshot(snapText(mutatedData((d) => ((d as any).desiredTimes = []))))
  assert(!v7.ok && v7.errors.some((e) => e.path === 'data.desiredTimes'), 'desiredTimes 非对象被拒绝')
  const v8 = validateSnapshot(snapText(mutatedData((d) => ((d as any).desiredPriorities = null))))
  assert(!v8.ok && v8.errors.some((e) => e.path === 'data.desiredPriorities'), 'desiredPriorities 非对象被拒绝')
}

// ---- 各类 id 唯一 ----
{
  const v1 = validateSnapshot(
    snapText(mutatedData((d) => d.events.push({ id: 'e1', name: '重复事件' } as any))),
  )
  assert(!v1.ok && v1.errors.some((e) => e.path === 'data.events[2].id' && e.message.includes('重复')), '事件 id 重复被拒绝')
  const v2 = validateSnapshot(
    snapText(
      mutatedData((d) =>
        d.constraints.push({ id: 'c1', aId: 'e1', bId: 'e2', relation: 'later', min: 1, max: 2, enabled: true } as any),
      ),
    ),
  )
  assert(!v2.ok && v2.errors.some((e) => e.path === 'data.constraints[1].id'), '约束 id 重复被拒绝')
  const v3 = validateSnapshot(
    snapText(
      mutatedData((d) =>
        d.observations.push({ id: 'o1', eventId: 'e2', start: '2026-01-01T09:00', end: '2026-01-01T09:00' } as any),
      ),
    ),
  )
  assert(!v3.ok && v3.errors.some((e) => e.path === 'data.observations[1].id'), '观测 id 重复被拒绝')
  // 不同类之间允许同 id（命名空间不同）
  const crossOk = validateSnapshot(
    snapText(
      mutatedData((d) => {
        ;(d.events[0] as any).id = 'shared'
        ;(d.constraints[0] as any).id = 'shared'
        ;(d.observations[0] as any).id = 'shared'
        ;(d.constraints[0] as any).aId = 'shared'
        ;(d.observations[0] as any).eventId = 'shared'
      }),
    ),
  )
  assert(crossOk.ok, '不同类实体允许相同 id')
}

// ---- 引用必须指向现存事件 ----
{
  const v1 = validateSnapshot(snapText(mutatedData((d) => ((d.constraints[0] as any).aId = 'ghost'))))
  assert(!v1.ok && v1.errors.some((e) => e.path === 'data.constraints[0].aId' && e.message.includes('ghost')), '约束 aId 引用不存在事件被拒绝')
  const v2 = validateSnapshot(snapText(mutatedData((d) => ((d.constraints[0] as any).bId = 'ghost'))))
  assert(!v2.ok && v2.errors.some((e) => e.path === 'data.constraints[0].bId'), '约束 bId 引用不存在事件被拒绝')
  const v3 = validateSnapshot(snapText(mutatedData((d) => ((d.observations[0] as any).eventId = 'ghost'))))
  assert(!v3.ok && v3.errors.some((e) => e.path === 'data.observations[0].eventId'), '观测引用不存在事件被拒绝')
  const v4 = validateSnapshot(snapText(mutatedData((d) => ((d.desiredTimes as any).ghost = '2026-01-01T09:00'))))
  assert(!v4.ok && v4.errors.some((e) => e.path.startsWith('data.desiredTimes')), '期望时刻键不存在事件被拒绝')
  const v5 = validateSnapshot(snapText(mutatedData((d) => ((d.desiredPriorities as any).ghost = 'high'))))
  assert(!v5.ok && v5.errors.some((e) => e.path.startsWith('data.desiredPriorities')), '优先级键不存在事件被拒绝')
}

// ---- 约束分钟数：非负整数且 min ≤ max ----
{
  const v1 = validateSnapshot(snapText(mutatedData((d) => ((d.constraints[0] as any).min = -1))))
  assert(!v1.ok && v1.errors.some((e) => e.path === 'data.constraints[0].min' && e.message.includes('非负')), '负数分钟被拒绝')
  const v2 = validateSnapshot(snapText(mutatedData((d) => ((d.constraints[0] as any).max = 2.5))))
  assert(!v2.ok && v2.errors.some((e) => e.path === 'data.constraints[0].max' && e.message.includes('整数')), '小数分钟被拒绝')
  const v3 = validateSnapshot(snapText(mutatedData((d) => ((d.constraints[0] as any).min = '5'))))
  assert(!v3.ok && v3.errors.some((e) => e.path === 'data.constraints[0].min'), '分钟数为字符串被拒绝')
  const v4 = validateSnapshot(
    snapText(mutatedData((d) => {
      ;(d.constraints[0] as any).min = 10
      ;(d.constraints[0] as any).max = 5
    })),
  )
  assert(!v4.ok && v4.errors.some((e) => e.message.includes('下界') && e.message.includes('上界')), 'min > max 被拒绝')
  const zero = validateSnapshot(
    snapText(mutatedData((d) => {
      ;(d.constraints[0] as any).min = 0
      ;(d.constraints[0] as any).max = 0
    })),
  )
  assert(zero.ok, 'min = max = 0 的精确间隔合法')
}

// ---- 观测与期望时刻：有效 yyyy-MM-ddTHH:mm；观测起点不晚于终点 ----
{
  const badFormats = ['2026-01-01 08:00', '2026-1-1T08:00', '2026-01-01T8:00', '2026-01-01', '08:00', '2026-02-30T08:00', '2026-01-01T25:00', '2026-01-01T08:60']
  for (const bad of badFormats) {
    const v = validateSnapshot(snapText(mutatedData((d) => ((d.observations[0] as any).start = bad))))
    assert(!v.ok && v.errors.some((e) => e.path === 'data.observations[0].start'), `非法观测时刻被拒绝：${bad}`)
  }
  const vEnd = validateSnapshot(snapText(mutatedData((d) => ((d.observations[0] as any).end = '2026-13-01T08:00'))))
  assert(!vEnd.ok && vEnd.errors.some((e) => e.path === 'data.observations[0].end'), '非法观测终点被拒绝')
  const vOrder = validateSnapshot(
    snapText(mutatedData((d) => {
      ;(d.observations[0] as any).start = '2026-01-01T09:00'
      ;(d.observations[0] as any).end = '2026-01-01T08:00'
    })),
  )
  assert(!vOrder.ok && vOrder.errors.some((e) => e.message.includes('早于起点')), '观测终点早于起点被拒绝')
  const vExact = validateSnapshot(
    snapText(mutatedData((d) => {
      ;(d.observations[0] as any).start = '2026-01-01T08:00'
      ;(d.observations[0] as any).end = '2026-01-01T08:00'
    })),
  )
  assert(vExact.ok, '起点等于终点的精确观测合法')
  const vDesired = validateSnapshot(snapText(mutatedData((d) => ((d.desiredTimes as any).e2 = '2026-02-29T09:00'))))
  assert(!vDesired.ok && vDesired.errors.some((e) => e.path.startsWith('data.desiredTimes')), '非法期望时刻被拒绝（2026 非闰年）')
  const leap = validateSnapshot(snapText(mutatedData((d) => ((d.desiredTimes as any).e2 = '2028-02-29T09:00'))))
  assert(leap.ok, '闰年 2 月 29 日的期望时刻合法')
}

// ---- 优先级仅 高/中/低 ----
{
  for (const bad of ['urgent', 'HIGH', '', 1, null]) {
    const v = validateSnapshot(snapText(mutatedData((d) => ((d.desiredPriorities as any).e2 = bad))))
    assert(!v.ok && v.errors.some((e) => e.path.startsWith('data.desiredPriorities')), `非法优先级被拒绝：${JSON.stringify(bad)}`)
  }
  for (const good of ['high', 'medium', 'low']) {
    const v = validateSnapshot(snapText(mutatedData((d) => ((d.desiredPriorities as any).e2 = good))))
    assert(v.ok && (v.state!.desiredPriorities as Record<string, string>).e2 === good, `合法优先级通过：${good}`)
  }
}

// ---- 任一错误禁止应用：不静默丢弃记录，错误逐项齐全，记录数预览仍给出 ----
{
  const dirty = mutatedData((d) => {
    d.events.push({ id: 'e3', name: '丙' } as any) // 合法记录
    ;(d.constraints[0] as any).min = -3 // 非法
    d.observations.push({ id: 'o2', eventId: 'nobody', start: '2026-01-01T10:00', end: '2026-01-01T10:00' } as any) // 非法引用
    ;(d.desiredPriorities as any).e2 = 'urgent' // 非法层级
  })
  const v = validateSnapshot(snapText(dirty))
  assert(!v.ok, '含错误快照整体被拒绝')
  assert(v.state === null, '有错误时不产出可应用状态（不静默丢弃记录后放行）')
  assert(v.errors.length === 3, '三类错误逐项齐全')
  assert(
    v.counts !== null &&
      v.counts.events === 3 &&
      v.counts.constraints === 1 &&
      v.counts.observations === 2 &&
      v.counts.desiredTimes === 1 &&
      v.counts.desiredPriorities === 1,
    '有错误时仍给出记录数预览',
  )
}

// ---- 格式合法但时序矛盾的快照可导入，并接入现有矛盾分析 ----
{
  const s = buildContradictionSample()
  const v = validateSnapshot(serializeSnapshot(s))
  assert(v.ok && v.state !== null, '时序矛盾不属于格式错误：快照可导入')
  const r = analyze(v.state!.events, v.state!.constraints, v.state!.observations)
  assert(!r.satisfiable && !!r.cycle, '导入的矛盾快照由现有分析检出负环')
}

// ---- 停用约束与空案卷也可往返 ----
{
  const s = buildConsistentSample()
  s.constraints[0].enabled = false
  const v = validateSnapshot(serializeSnapshot(s))
  assert(v.ok && v.state!.constraints[0].enabled === false, '停用约束原样往返')
  assert(v.counts!.enabledConstraints === s.constraints.length - 1, '记录数预览不计入停用约束')
  const empty = validateSnapshot(
    snapText({ events: [], constraints: [], observations: [], desiredTimes: {}, desiredPriorities: {} }),
  )
  assert(empty.ok && empty.state!.events.length === 0, '空案卷快照合法')
}

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) process.exit(1)