import type { Constraint, CycleInfo, TimeObservation, TEvent } from '../types'
import { describeConstraint, describeObservation } from '../lib/format'

interface Props {
  cycle: CycleInfo
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
}

const ORIGIN_LABEL = '时间原点 t₀'

/** 单条差分边的不等式含义：t_v - t_u <= w */
function edgeInequality(e: CycleInfo['edges'][number], nameOf: (i: number) => string): string {
  const sign = e.w >= 0 ? '+' : '−'
  return `t(${nameOf(e.v)}) − t(${nameOf(e.u)}) ≤ ${sign}${Math.abs(e.w)}`
}

/**
 * 矛盾环复核面板：
 * 以可逐步核对的方式列出环上每条差分不等式（观测边与相对约束边都可能在环上），
 * 求和后得到 0 ≤ 负数 的矛盾，并分别映射回用户录入的原始观测与自然语言约束。
 */
export default function CyclePanel({ cycle, events, constraints, observations }: Props) {
  const nameById = new Map(events.map((e) => [e.id, e.name]))
  const nameOfIdx = (i: number) => (i === events.length ? ORIGIN_LABEL : events[i]?.name ?? `#${i}`)
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  const observationById = new Map(observations.map((o) => [o.id, o]))
  const obsOrder = new Map(observations.map((o, i) => [o.id, i + 1]))

  const involvedConstraints = new Map<string, Constraint>()
  const involvedObservations = new Map<string, TimeObservation>()
  for (const e of cycle.edges) {
    if (e.kind === 'observation' && e.observationId) {
      const o = observationById.get(e.observationId)
      if (o && !involvedObservations.has(o.id)) involvedObservations.set(o.id, o)
    } else if (e.constraintId) {
      const c = constraintById.get(e.constraintId)
      if (c && !involvedConstraints.has(c.id)) involvedConstraints.set(c.id, c)
    }
  }

  const n = cycle.nodes.length
  const touchesOrigin = cycle.nodes.includes(events.length)

  return (
    <div className="cycle-box">
      <h4>
        可复核的矛盾环（{n} 个节点、{cycle.edges.length} 条差分边
        {touchesOrigin ? '，含时间原点：矛盾涉及绝对时间观测' : '，仅含相对约束'}）
      </h4>

      <div className="cycle-chain">
        {cycle.nodes.map((nodeIdx, i) => {
          const edge = cycle.edges[i]
          return (
            <span key={i}>
              <span className={`node${nodeIdx === events.length ? ' origin' : ''}`}>{nameOfIdx(nodeIdx)}</span>
              <span className="arrow">
                {' '}
                ── <span className="w">{edge.w > 0 ? `+${edge.w}` : edge.w}</span>
                {edge.kind === 'observation' && <span className="edge-tag obs">观测</span>}
                →{' '}
              </span>
              {i === n - 1 && (
                <span className={`node${cycle.nodes[0] === events.length ? ' origin' : ''}`}>
                  {nameOfIdx(cycle.nodes[0])}
                </span>
              )}
            </span>
          )
        })}
      </div>

      <ol className="cycle-constraint-list" style={{ paddingLeft: 18 }}>
        {cycle.edges.map((e, i) => (
          <li key={i} style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
            <span className={`edge-tag-inline ${e.kind}`}>{e.kind === 'observation' ? '观测' : '约束'}</span>{' '}
            {edgeInequality(e, nameOfIdx)}
          </li>
        ))}
      </ol>

      <div className="cycle-proof">
        以上不等式全部沿环<strong>左、右分别相加</strong>，各时间变量各出现一次正负、恰好抵消（含时间原点
        t₀），于是得到 <code> 0 ≤ {cycle.totalWeight}</code>，显然不成立——这就是矛盾的代数证据。
        由于观测与相对约束在<strong>同一张差分图</strong>上求解，这条矛盾链同时给出了参与冲突的观测与约束，
        而非对每个锚点独立判断。
      </div>

      {involvedObservations.size > 0 && (
        <div className="cycle-proof cycle-obs">
          涉及的绝对时间观测（{involvedObservations.size} 条，已在上图与观测列表中红色高亮）：
          <ul className="cycle-constraint-list" style={{ paddingLeft: 18, marginTop: 4 }}>
            {[...involvedObservations.values()].map((o) => (
              <li key={o.id}>
                <code className="order-no">#{obsOrder.get(o.id)}</code>{' '}
                {describeObservation(o, (id) => nameById.get(id) ?? '（已删除事件）')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="cycle-proof">
        涉及的原始证词 / 相对约束（{involvedConstraints.size} 条，已在上图与约束列表中红色高亮）：
        <ul className="cycle-constraint-list" style={{ paddingLeft: 18, marginTop: 4 }}>
          {[...involvedConstraints.values()].map((c) => (
            <li key={c.id}>
              {describeConstraint(c, (id) => nameById.get(id) ?? '（已删除事件）')}
            </li>
          ))}
          {involvedConstraints.size === 0 && <li>无——矛盾完全由绝对时间观测之间的冲突造成，需核对观测记录。</li>}
        </ul>
      </div>
    </div>
  )
}
