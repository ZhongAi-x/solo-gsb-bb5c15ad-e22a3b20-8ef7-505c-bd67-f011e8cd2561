import type {
  Constraint,
  DiffEdge,
  LayerResult,
  PriorityLevel,
  ScheduleEntry,
  ScheduleResult,
  TimeObservation,
  TEvent,
} from '../types'
import { analyze, buildSystem, feasiblePotentials } from './graph'

const MINUTE_MS = 60_000

/** 钉住期望事件时使用的合成来源 id（仅内部标识，不进入展示） */
const PIN_ID = '__desired_pin__'

/** 字典序优化的层级顺序：先高、再中、后低 */
const LEVEL_ORDER: PriorityLevel[] = ['high', 'medium', 'low']

/** 未显式选择层级时的默认优先级（旧版存档没有层级字段，也按此兼容） */
export const DEFAULT_PRIORITY: PriorityLevel = 'medium'

/** 解析期望时刻为相对时间原点（baseISO）的分钟偏移；无效输入返回 null */
function desiredOffsetMin(baseISO: string, desiredISO: string): number | null {
  const a = new Date(baseISO).getTime()
  const t = new Date(desiredISO).getTime()
  if (Number.isNaN(a) || Number.isNaN(t)) return null
  return Math.round((t - a) / MINUTE_MS)
}

/**
 * 分层最小偏差排程（高 → 中 → 低 字典序最小化）。
 *
 * 前提：统一差分系统（相对约束 + 绝对时间观测）可满足且至少存在一条有效观测
 * （时间原点 t0 已被锚定到真实时刻；不满足时返回 null）。
 * 对每个「已填写有效期望时刻且与时间原点连通」的事件 i，记其期望相对 t0 的偏移为
 * d_i、优先级层级为 L(i)（未选择时按「中」）。按层级 高 → 中 → 低 依次求解：
 *
 * 1. 求当前层的最小非负整数容差 D_L，使**累计差分系统**（原始相对约束、全部观测
 *    + 所有更高层已固定的 ±D 钉住约束）与本层全部钉住约束
 *
 *        d_i − D_L ≤ t_i − t0 ≤ d_i + D_L
 *
 *    同时可满足；每个候选 D 的可行性都通过对**整体**差分图做负环检测来判定
 *    （整体可满足性搜索），而不是把各事件独立夹到各自的时间窗——后者忽略事件间
 *    耦合（例如 t_Y = t_X + 5 时，X、Y 各自的窗口都可能包含期望值，但二者不能
 *    同时取到），会得出偏小的伪最优；
 * 2. 把本层 ±D_L 的钉住边**永久并入累计边集**（固定其最优容差），再求下一层。
 *    低层优化在任何候选下都受高层钉住约束限制，绝不可能牺牲高层已达成的容差；
 *    尚未求到的更低层此时不参与钉住（自由），符合字典序语义。
 *
 * 不使用加权和、也不分层各自排程后拼接：所有可行性判定与最终输出都产生自同一个
 * 累计差分图，因此最终排程同时满足全部相对约束、全部观测与各层最优容差。
 *
 * 每层的搜索结构：
 * 1. 上界：累计系统的任一可行势 t*（超级源点 Bellman-Ford）给出可行
 *    D_ub = max_{i 属于本层} |(t*_i − t*_t0) − d_i|；
 * 2. 在 [0, D_ub] 上二分最小的可行非负整数 D_L；
 * 3. 全部层级求完后，取累计钉住图上的一组可行势、平移到 t0 = 0 作为输出排程。
 *    边集与边顺序确定时 Bellman-Ford 结果确定，因此输出是确定性的可行排程。
 *    由于每层 D_L 最小（D_L − 1 在更少约束下已不可行），最终排程中每层必然
 *    有事件达到 ±D_L。
 *
 * 与时间原点不连通（未被任何观测连通）的事件不参与搜索，在结果中标记为
 * unscheduled（未定时）；其上填写的期望时刻与层级被忽略（desiredIgnored = true）。
 */
export function computeMinDeviationSchedule(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
  desiredTimes: Record<string, string>,
  desiredPriorities: Record<string, PriorityLevel>,
): ScheduleResult | null {
  const base = analyze(events, constraints, observations)
  if (!base.satisfiable || base.baseISO === null) return null
  const baseISO = base.baseISO

  const sys = buildSystem(events, constraints, observations)
  const { n, edges, indexOf, originIdx } = sys
  if (n === 0) return null
  const m = n + 1

  // 期望时刻 → 相对时间原点的分钟偏移
  const desired = new Map<number, number>()
  for (const [id, iso] of Object.entries(desiredTimes)) {
    const i = indexOf.get(id)
    if (i === undefined || !iso) continue
    const off = desiredOffsetMin(baseISO, iso)
    if (off !== null) desired.set(i, off)
  }

  const connected = (i: number) => {
    const w = base.windows.get(i)
    return !!w && w.status !== 'disconnected'
  }

  const priorityOf = (i: number): PriorityLevel =>
    desiredPriorities[events[i].id] ?? DEFAULT_PRIORITY

  // 参与整体搜索的期望事件：期望有效且与时间原点连通（按事件下标升序，保证确定性）
  const targets = [...desired.keys()].filter(connected).sort((a, b) => a - b)
  if (targets.length === 0) return null

  // 按层级分组（组内保持事件下标升序）
  const byLevel = new Map<PriorityLevel, number[]>()
  for (const i of targets) {
    const lv = priorityOf(i)
    const g = byLevel.get(lv)
    if (g) g.push(i)
    else byLevel.set(lv, [i])
  }

  /** 一组事件在给定 D 下的钉住边（对时间原点双向夹逼） */
  const pinEdges = (group: number[], D: number): DiffEdge[] => {
    const es: DiffEdge[] = []
    for (const i of group) {
      const d = desired.get(i)!
      es.push(
        { u: originIdx, v: i, w: d + D, kind: 'observation', constraintId: undefined, observationId: PIN_ID, bound: 'upper' as const },
        { u: i, v: originIdx, w: D - d, kind: 'observation', constraintId: undefined, observationId: PIN_ID, bound: 'lower' as const },
      )
    }
    return es
  }

  // —— 字典序主循环：累计边集从原始边出发，逐层并入已固定的钉住边 ——
  const accEdges = edges.slice()
  const layers: LayerResult[] = []
  for (const level of LEVEL_ORDER) {
    const group = byLevel.get(level) ?? []
    if (group.length === 0) {
      layers.push({ level, count: 0, D: null, tightEventIdx: [], maxDeviation: null })
      continue
    }

    // 上界：累计系统的可行势 t* 满足全部已固定约束，D_ub = max |(t*_i−t*_t0) − d_i| 必然可行。
    // 不变式：accEdges 可满足（原始系统可满足；每层并入的钉住边在并入前已验证可行）。
    const pot = feasiblePotentials(m, accEdges)
    if (!pot) return null // 防御：不变式保证可满足，理论不可达
    let hi = 0
    for (const i of group) {
      hi = Math.max(hi, Math.abs(pot[i] - pot[originIdx] - desired.get(i)!))
    }

    // 二分本层最小可行非负整数 D；不变式：lo 不可行（−1 为哨兵），hi 可行
    let lo = -1
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (feasiblePotentials(m, [...accEdges, ...pinEdges(group, mid)]) !== null) hi = mid
      else lo = mid
    }
    const D = hi

    // 固定本层最优容差：钉住边并入累计边集，约束后续所有更低层
    accEdges.push(...pinEdges(group, D))
    layers.push({ level, count: group.length, D, tightEventIdx: [], maxDeviation: null })
  }

  // 输出排程：累计钉住图上的一组可行势，平移到 t0 = 0（确定性）
  const h = feasiblePotentials(m, accEdges)!
  const offsetOf = (i: number) => h[i] - h[originIdx]

  const entries: ScheduleEntry[] = events.map((_, i): ScheduleEntry => {
    const d = desired.get(i) ?? null
    const priority = d !== null ? priorityOf(i) : null
    if (!connected(i)) {
      return {
        eventIdx: i,
        status: 'unscheduled',
        offsetMin: null,
        desiredOffset: d,
        deviation: null,
        desiredIgnored: d !== null,
        priority,
      }
    }
    const off = offsetOf(i)
    return {
      eventIdx: i,
      status: 'scheduled',
      offsetMin: off,
      desiredOffset: d,
      deviation: d !== null ? off - d : null,
      desiredIgnored: false,
      priority,
    }
  })

  // 由最终排程回填各层的最大偏差与达到 ±D 的事件
  for (const layer of layers) {
    if (layer.count === 0) continue
    const tight: number[] = []
    let maxDeviation = 0
    for (const i of byLevel.get(layer.level)!) {
      const dev = Math.abs(entries[i].deviation!)
      if (dev > maxDeviation) maxDeviation = dev
      if (Math.abs(dev - layer.D!) < 1e-9) tight.push(i)
    }
    layer.tightEventIdx = tight
    layer.maxDeviation = maxDeviation
  }

  return { layers, entries, desiredCount: targets.length }
}
