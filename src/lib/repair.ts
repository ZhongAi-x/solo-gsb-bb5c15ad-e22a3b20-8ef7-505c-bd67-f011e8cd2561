import type {
  Constraint,
  RepairPlan,
  RepairSearchResult,
  TimeObservation,
  TEvent,
} from '../types'
import { analyze, buildSystem, findNegativeCycle } from './graph'

/** 累计搜索状态数上限：超过即停止，并标记结果可能不完备 */
export const DEFAULT_STATE_LIMIT = 2000

/** 并列最优方案最多展示数量 */
export const MAX_PLANS = 5

type State = number[] // 已停用约束在候选序列（即约束录入顺序）中的下标，升序

/** 按录入顺序（下标字典序）比较两个停用集合 */
function lexCmp(a: State, b: State): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * 最小修复建议：当统一差分系统（相对约束 + 绝对时间观测）存在负环时，搜索
 * “停用相对约束数量最少”的可满足方案。
 *
 * 观测是对事实的绝对时间记录，不允许停用——因此当矛盾链完全由观测（以及观测与
 * 约束的组合）造成、无法仅靠停用约束消除时，返回 observationConflict = true，
 * 由界面提示用户核对观测记录本身。矛盾环的检测与抽取始终在观测边 + 约束边的
 * 同一张图上完成，分支依据的环同时包含两类边，不会逐锚点独立判断。
 *
 * 搜索以每次 Bellman-Ford 发现的负环为分支依据（branch on one negative cycle）：
 * 设当前已停用集合 D，差分图中仍有负环 C，则任何可满足的停用集合都必须再停掉
 * C 上的至少一条**相对约束**。因此只需对 C 上的可停用约束逐一分支，既保证完备性，
 * 又避免枚举无关约束。按停用数 0,1,2,… 逐层 BFS，第一层中出现的可行状态即最优
 * （停用数最少）；同层全部状态都会被考察，以收集并列最优方案。
 *
 * 累计访问状态数超过 stateLimit（默认 2000）时停止，结果标记 truncated，
 * 提示结果可能不完备。
 */
export function findMinimalRepairs(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
  opts: { stateLimit?: number } = {},
): RepairSearchResult {
  const stateLimit = opts.stateLimit ?? DEFAULT_STATE_LIMIT

  // 候选约束 = 当前启用且引用事件均存在的相对约束（buildSystem 实际采用的那些），
  // 保持约束录入顺序，使方案排序稳定。观测不进入候选。
  const eventIds = new Set(events.map((e) => e.id))
  const candidates = constraints.filter(
    (c) => c.enabled && eventIds.has(c.aId) && eventIds.has(c.bId),
  )

  const sys = buildSystem(events, constraints, observations)
  const m = sys.n + 1
  const allEdges = sys.edges
  const candidateIndex = new Map(candidates.map((c, i) => [c.id, i]))
  const activeEdges = (state: State) => {
    if (state.length === 0) return allEdges
    const off = new Set(state.map((i) => candidates[i].id))
    return allEdges.filter((e) => !(e.kind === 'constraint' && e.constraintId !== undefined && off.has(e.constraintId)))
  }

  let statesVisited = 0
  const keyOf = (state: State) => state.join('.')
  const visited = new Set<string>([''])

  let level: State[] = [[]]
  let truncated = false

  while (level.length > 0) {
    const feasible: State[] = []
    const next: State[] = []

    for (const state of level) {
      if (statesVisited >= stateLimit) {
        truncated = true
        break
      }
      statesVisited++
      const edges = activeEdges(state)
      const cyc = findNegativeCycle(m, edges)
      if (!cyc) {
        feasible.push(state)
        continue
      }

      // 以该负环上的不同**相对约束**（候选下标升序）为分支；观测边不可停用
      const onCycle = new Set<number>()
      for (const e of cyc.edges) {
        if (e.kind !== 'constraint' || !e.constraintId) continue
        const ci = candidateIndex.get(e.constraintId)
        if (ci !== undefined && !state.includes(ci)) onCycle.add(ci)
      }
      const branchIdx = [...onCycle].sort((a, b) => a - b)
      for (const ci of branchIdx) {
        const child = [...state, ci].sort((a, b) => a - b)
        const key = keyOf(child)
        if (!visited.has(key)) {
          visited.add(key)
          next.push(child)
        }
      }
    }

    if (feasible.length > 0) {
      // 按层 BFS：第一次出现可行状态的层，停用数即最小（已被证明）。
      const disableCount = feasible[0].length
      // 根状态即可行：系统本身无矛盾，无需修复
      if (disableCount === 0) {
        return {
          found: true,
          plans: [],
          totalPlans: 0,
          disableCount: 0,
          truncated: false,
          optimumProven: true,
          statesVisited,
          stateLimit,
          observationConflict: false,
        }
      }
      // 若中途因状态数上限截断，本层可能还有未访问的并列方案 —— 明确标记。
      feasible.sort(lexCmp)
      return {
        found: true,
        plans: feasible.slice(0, MAX_PLANS).map((s) => toPlan(s, candidates, events, constraints, observations)),
        totalPlans: feasible.length,
        disableCount,
        truncated,
        optimumProven: true,
        statesVisited,
        stateLimit,
        observationConflict: false,
      }
    }

    if (truncated) {
      // 已达到状态数上限，且尚未在任何层找到可行方案
      return {
        found: false,
        plans: [],
        totalPlans: 0,
        disableCount: -1,
        truncated: true,
        optimumProven: false,
        statesVisited,
        stateLimit,
        observationConflict: hasObservationInCycle(events, constraints, observations),
      }
    }

    if (next.length === 0) {
      // 所有可达状态都已穷尽且无一可行：剩余矛盾环上没有可停用的相对约束，
      // 矛盾只能由绝对时间观测（与约束的组合）造成
      return {
        found: false,
        plans: [],
        totalPlans: 0,
        disableCount: -1,
        truncated: false,
        optimumProven: false,
        statesVisited,
        stateLimit,
        observationConflict: hasObservationInCycle(events, constraints, observations),
      }
    }

    level = next
  }

  // 理论上不可达：停用全部候选约束后图中只剩观测边
  return {
    found: false,
    plans: [],
    totalPlans: 0,
    disableCount: -1,
    truncated: false,
    optimumProven: false,
    statesVisited,
    stateLimit,
    observationConflict: hasObservationInCycle(events, constraints, observations),
  }
}

/** 当前（未额外停用约束的）系统矛盾环中是否包含观测边 */
function hasObservationInCycle(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
): boolean {
  const sys = buildSystem(events, constraints, observations)
  const cyc = findNegativeCycle(sys.n + 1, sys.edges)
  return !!cyc && cyc.edges.some((e) => e.kind === 'observation')
}

/** 由停用下标构造可展示的修复方案（停用约束 + 修复后时间窗） */
function toPlan(
  state: State,
  candidates: Constraint[],
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
): RepairPlan {
  const offIds = new Set(state.map((i) => candidates[i].id))
  const simulated = constraints.map((c) =>
    offIds.has(c.id) ? { ...c, enabled: false } : c,
  )
  // 复用 analyze 得到修复后的时间窗，保证与主界面完全一致的口径（观测保持生效）
  const { windows } = analyze(events, simulated, observations)
  return {
    disableConstraintIds: state.map((i) => candidates[i].id),
    windows,
  }
}
