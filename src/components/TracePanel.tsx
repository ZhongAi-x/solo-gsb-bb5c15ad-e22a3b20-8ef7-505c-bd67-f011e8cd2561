import type { BoundTrace, Constraint, DiffEdge, TimeObservation, TEvent } from '../types'
import { describeConstraint, describeObservation, formatAt, formatFullDateTime } from '../lib/format'

interface Props {
  trace: BoundTrace
  events: TEvent[]
  /** 与图/分析一致的（可能叠加了修复预览的）有效约束 */
  constraints: Constraint[]
  /** 与图/分析一致的观测（观测不可停用，预览时也保持不变） */
  observations: TimeObservation[]
  /** 时间原点对应的真实时刻；null 时无有效观测（不会产生追溯） */
  baseISO: string | null
  onClose: () => void
}

/** 带符号的分钟数：+5 / −2 / 0 */
function signed(n: number): string {
  if (n > 0) return `+${n}`
  if (n < 0) return `−${Math.abs(n)}`
  return '0'
}

const ORIGIN_LABEL = '时间原点 t₀'

/**
 * 边界依据追溯面板：逐步列出从时间原点推导某事件最早/最晚边界所采用的
 * 原始观测/约束、上/下界侧与累计偏移；事件被一条精确（零宽）观测直接钉住时
 * 给出零步证明。
 */
export default function TracePanel({ trace, events, constraints, observations, baseISO, onClose }: Props) {
  const nameOfIdx = (i: number) => (i === events.length ? ORIGIN_LABEL : events[i]?.name ?? `#${i}`)
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  const obsById = new Map(observations.map((o) => [o.id, o]))
  const orderOf = new Map(constraints.map((c, i) => [c.id, i + 1]))
  const obsOrderOf = new Map(observations.map((o, i) => [o.id, i + 1]))

  const targetName = nameOfIdx(trace.eventIdx)
  const kindLabel = trace.kind === 'earliest' ? '最早' : '最晚'
  const totalWeight = trace.steps.reduce((s, st) => s + st.edge.w, 0)

  /** 一条边的来源描述：原始约束（录入序号）或绝对时间观测（录入序号） */
  const sourceNode = (edge: DiffEdge) => {
    const nameOf = (id: string) => events.find((e) => e.id === id)?.name ?? '（已删除事件）'
    if (edge.kind === 'observation' && edge.observationId) {
      const o = obsById.get(edge.observationId)
      const no = obsOrderOf.get(edge.observationId)
      return (
        <>
          绝对时间观测 <code className="order-no">#{no ?? '?'}</code>{' '}
          {o ? describeObservation(o, nameOf) : '（观测已删除）'}
        </>
      )
    }
    const c = edge.constraintId ? constraintById.get(edge.constraintId) : undefined
    if (c) {
      return (
        <>
          原始约束 <code className="order-no">#{orderOf.get(c.id)}</code> {describeConstraint(c, nameOf)}
        </>
      )
    }
    return <>（来源已删除）</>
  }

  /** 边的来源类型标签 */
  const sourceKind = (edge: DiffEdge): string =>
    edge.kind === 'observation' ? '观测' : '约束'

  return (
    <div className="trace-box">
      <div className="trace-head">
        <h4>
          边界依据追溯：「{targetName}」的{kindLabel}时间
          <span className="trace-kind">{kindLabel === '最早' ? '下界' : '上界'}推导链</span>
        </h4>
        <button className="small" onClick={onClose} title="关闭追溯">
          关闭
        </button>
      </div>

      {trace.steps.length === 0 ? (
        <div className="trace-zero">
          {trace.directObservationId ? (
            (() => {
              const o = obsById.get(trace.directObservationId!)
              return (
                <>
                  「{targetName}」的{kindLabel}边界由一条<strong>精确时刻观测（零宽区间）</strong>直接给出
                  {o ? <>：{describeObservation(o, (id) => events.find((e) => e.id === id)?.name ?? '（已删除事件）')}</> : null}
                  ，<strong>不经过任何相对约束推导 —— 零步证明</strong>。
                </>
              )
            })()
          ) : (
            <>
              「{targetName}」就是时间原点：其{kindLabel}边界由基准定义直接给出
              （偏移 0 分钟，即 {formatFullDateTime(baseISO)}），<strong>零步证明</strong>。
            </>
          )}
        </div>
      ) : (
        <>
          <div className="trace-intro">
            {trace.kind === 'latest' ? (
              <>
                最晚边界 = 正向差分图上时间原点到该事件的最短路。沿链依次有
                t(下一节点) − t(上一节点) ≤ w，求和即得 t({targetName}) − t({ORIGIN_LABEL}) ≤ {signed(trace.offset)}。
              </>
            ) : (
              <>
                最早边界在<strong>反向差分图</strong>上推导：沿链依次有 t(上一节点) − t(下一节点) ≤ w，
                求和得 t({ORIGIN_LABEL}) − t({targetName}) ≤ {signed(totalWeight)}，即
                t({targetName}) − t({ORIGIN_LABEL}) ≥ {signed(trace.offset)}。
                下列步骤已按从时间原点出发的推导顺序<strong>还原为原始观测/约束</strong>（标注「反向」的为反向使用该条不等式）。
              </>
            )}
            链上的观测、约束与节点已在差分图和录入列表中同步高亮。
          </div>

          <ol className="trace-steps">
            {trace.steps.map((st, i) => {
              const backward = st.edge.u !== st.from
              const isOriginStep = st.from === events.length || st.to === events.length
              return (
                <li key={i} className="trace-step">
                  <div className="trace-step-head">
                    <span className="trace-step-no">第 {i + 1} 步</span>
                    <span className="trace-step-path">
                      「{nameOfIdx(st.from)}」→「{nameOfIdx(st.to)}」
                    </span>
                    <span className={`trace-src-kind ${st.edge.kind}`}>{sourceKind(st.edge)}</span>
                    {backward && <span className="trace-step-dir">反向</span>}
                    {isOriginStep && <span className="trace-step-dir origin">时间原点</span>}
                  </div>
                  <div className="trace-step-body">
                    {sourceNode(st.edge)}
                    <br />
                    采用{st.edge.bound === 'upper' ? '上界' : '下界'}侧不等式：
                    <code>
                      t({nameOfIdx(st.edge.v)}) − t({nameOfIdx(st.edge.u)}) ≤ {signed(st.edge.w)}
                    </code>
                    <br />
                    累计偏移：t({nameOfIdx(st.to)}) − t({ORIGIN_LABEL}){' '}
                    {trace.kind === 'latest' ? '≤' : '≥'} <code>{signed(st.cumulative)}</code> 分钟
                  </div>
                </li>
              )
            })}
          </ol>

          <div className="trace-proof">
            {trace.kind === 'latest' ? (
              <>
                各步权重求和：
                <code>
                  {trace.steps.map((st) => signed(st.edge.w)).join(' + ')} = {signed(totalWeight)}
                </code>
                ，即 t({targetName}) − t({ORIGIN_LABEL}) ≤ {signed(trace.offset)} 分钟。
                故「{targetName}」最晚为基准时刻 {signed(trace.offset)} 分钟 =
                <strong> {formatAt(baseISO, trace.offset)}</strong>。
              </>
            ) : (
              <>
                各步权重求和：
                <code>
                  {trace.steps.map((st) => signed(st.edge.w)).join(' + ')} = {signed(totalWeight)}
                </code>
                ，即 t({ORIGIN_LABEL}) − t({targetName}) ≤ {signed(totalWeight)}，亦即 t({targetName}) − t({ORIGIN_LABEL}) ≥{' '}
                {signed(trace.offset)} 分钟。 故「{targetName}」最早为基准时刻 {signed(trace.offset)} 分钟 =
                <strong> {formatAt(baseISO, trace.offset)}</strong>。
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
