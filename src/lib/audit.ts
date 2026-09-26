import type { AuditEntry, Constraint, TimeObservation, TEvent } from '../types'
import { buildSystem, findNegativeCycle, shortestFrom } from './graph'

/**
 * 冗余证词审计：系统可满足时，逐条暂时排除一条已启用相对约束，
 * 基于其余约束与全部观测重新推导该证词两端事件的最紧时间差区间。
 *
 * 对证词「A 比 B 早/晚 min~max 分钟」，记差值 d = t_to − t_from
 *（earlier：to=B、from=A；later：to=A、from=B），证词声称 d ∈ [min, max]。
 * 在移除该约束两条差分边后的图（其余启用约束 + 全部观测 + 时间原点）上：
 *
 *   推导上界 derivedMax = from → to 的最短路（t_to − t_from 的最紧上界）
 *   推导下界 derivedMin = −(to → from 的最短路)
 *
 * 不可达的边界按无界处理（null 表示 −∞ / +∞）。
 * 仅当 [derivedMin, derivedMax] 完整落在 [min, max] 内时结论为「冗余」
 * （其余约束与观测已蕴含不弱于该证词的时差），否则为「必要」。
 *
 * 停用的约束不参与审计（既不产生边，也不生成审计条目）；引用已删除事件的
 * 约束在差分图中本就不产生边，同样跳过。系统存在矛盾（负环）时返回 null：
 * 此时最短路推导没有意义，审计暂停。系统可满足时移除一条约束不会产生负环，
 * 最短路必然有定义。
 *
 * 本函数为纯计算：不修改约束、观测或任何本地存档。
 */
export function auditRedundancy(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
): AuditEntry[] | null {
  const sys = buildSystem(events, constraints, observations)
  const { n, edges, indexOf } = sys
  const m = n + 1
  // 矛盾状态下审计暂停（排除法的最短路推导以无负环为前提）
  if (findNegativeCycle(m, edges)) return null

  const entries: AuditEntry[] = []
  for (const c of constraints) {
    if (!c.enabled) continue // 停用的约束不参与审计
    const a = indexOf.get(c.aId)
    const b = indexOf.get(c.bId)
    if (a === undefined || b === undefined) continue // 引用已删除事件的约束不产生边
    // 证词声称的差值方向：min ≤ t_to − t_from ≤ max
    const from = c.relation === 'earlier' ? a : b
    const to = c.relation === 'earlier' ? b : a
    // 暂时排除该证词的两条差分边，其余约束与全部观测保持不变
    const rest = edges.filter((e) => !(e.kind === 'constraint' && e.constraintId === c.id))
    const upper = shortestFrom(from, m, rest)[to]
    const lower = shortestFrom(to, m, rest)[from]
    const derivedMax = Number.isFinite(upper) ? upper : null
    const derivedMin = Number.isFinite(lower) ? -lower : null
    // 推导区间完整落在原证词区间内 → 冗余；无界（null）视为不落入
    const redundant =
      derivedMin !== null && derivedMax !== null && derivedMin >= c.min && derivedMax <= c.max
    entries.push({
      constraintId: c.id,
      derivedMin,
      derivedMax,
      verdict: redundant ? 'redundant' : 'necessary',
    })
  }
  return entries
}
