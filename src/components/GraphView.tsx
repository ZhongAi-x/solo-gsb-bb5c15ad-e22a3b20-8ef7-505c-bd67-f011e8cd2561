import { useMemo } from 'react'
import type { Constraint, DiffEdge, TimeObservation, TEvent } from '../types'
import { buildSystem } from '../lib/graph'

interface Props {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
  cycleNodes: Set<number>
  /** 高亮边的全局键：edgeKey(edge) = `${kind}:${id}:${bound}` */
  cycleEdgeKeys: Set<string>
  /** 边界追溯链上的节点（含时间原点与目标事件） */
  traceNodes?: Set<number>
  /** 边界追溯链上的边，键同 cycleEdgeKeys */
  traceEdgeKeys?: Set<string>
}

const W = 760
const H = 480
const CX = W / 2
const CY = H / 2
const R = 180
const NODE_R = 26

/** 差分边的全局标识键（约束边与观测边各有命名空间） */
export function edgeKey(e: DiffEdge): string {
  return e.kind === 'observation'
    ? `observation:${e.observationId ?? ''}:${e.bound}`
    : `constraint:${e.constraintId ?? ''}:${e.bound}`
}

function nodePos(i: number, n: number, originPresent: boolean): { x: number; y: number } {
  if (n === 1) {
    // 唯一事件需给中心时间原点让位：放在原点正上方
    return originPresent ? { x: CX, y: CY - R * 0.8 } : { x: CX, y: CY }
  }
  const ang = -Math.PI / 2 + (2 * Math.PI * i) / n
  return { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) }
}

interface Arc {
  edge: DiffEdge
  path: string
  lx: number
  ly: number
  inCycle: boolean
  inTrace: boolean
}

/**
 * 差分约束图可视化：事件节点环形布局，中心为虚拟「时间原点 t₀」（仅在存在有效观测时
 * 出现观测边）。相对约束边为灰蓝色，观测边为琥珀色；矛盾环红色、追溯链紫色。
 */
export default function GraphView({
  events,
  constraints,
  observations,
  cycleNodes,
  cycleEdgeKeys,
  traceNodes,
  traceEdgeKeys,
}: Props) {
  const sys = useMemo(
    () => buildSystem(events, constraints, observations),
    [events, constraints, observations],
  )
  const edges = sys.edges
  const originIdx = sys.originIdx
  const hasOriginEdges = useMemo(() => edges.some((e) => e.kind === 'observation'), [edges])

  const arcs = useMemo<Arc[]>(() => {
    const n = events.length
    // 同一对端点（无序）间的多条边分摊曲率，使正/反向弧彼此错开
    const pairCount = new Map<string, number>()
    const pairSeen = new Map<string, number>()

    return edges.map((edge) => {
      const p1 = posOf(edge.u)
      const p2 = posOf(edge.v)
      const unordered = [edge.u, edge.v].sort((a, b) => a - b).join(':')
      pairCount.set(unordered, (pairCount.get(unordered) ?? 0) + 1)
      const ord = pairSeen.get(unordered) ?? 0
      pairSeen.set(unordered, ord + 1)

      const { path, lx, ly } = arcPath(p1, p2, edge.u === edge.v, ord, pairCount.get(unordered) ?? 1)
      const key = edgeKey(edge)
      return {
        edge,
        path,
        lx,
        ly,
        inCycle: cycleEdgeKeys.has(key),
        inTrace: traceEdgeKeys?.has(key) ?? false,
      }
    })

    /** 事件节点环形排布；时间原点固定在画布中心（仅在有观测边时占据中心） */
    function posOf(idx: number): { x: number; y: number } {
      return idx === originIdx ? { x: CX, y: CY } : nodePos(idx, n, hasOriginEdges)
    }
  }, [edges, events.length, originIdx, hasOriginEdges, cycleEdgeKeys, traceEdgeKeys])

  if (events.length === 0) {
    return <div className="graph-empty">添加事件后，这里将展示差分约束图</div>
  }

  const n = events.length
  const originInCycle = cycleNodes.has(originIdx)
  const originInTrace = traceNodes?.has(originIdx) ?? false

  const edgeColor = (a: Arc) =>
    a.inCycle ? '#f85149' : a.inTrace ? '#bc8cff' : a.edge.kind === 'observation' ? '#e3a008' : '#5b7186'
  const edgeMarker = (a: Arc) =>
    a.inCycle ? 'url(#arrow-cycle)' : a.inTrace ? 'url(#arrow-trace)' : 'url(#arrow)'
  const edgeTextColor = (a: Arc) =>
    a.inCycle ? '#ff8f8a' : a.inTrace ? '#d2a8ff' : a.edge.kind === 'observation' ? '#f0c674' : '#8da2b5'

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="差分约束有向图">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#7d92a6" />
          </marker>
          <marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f85149" />
          </marker>
          <marker id="arrow-trace" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#bc8cff" />
          </marker>
        </defs>

        {arcs.map((a, i) => (
          <g key={i}>
            <path
              d={a.path}
              fill="none"
              stroke={edgeColor(a)}
              strokeWidth={a.inCycle || a.inTrace ? 2.6 : 1.4}
              strokeDasharray={a.edge.kind === 'observation' && !a.inCycle && !a.inTrace ? '6 3' : undefined}
              markerEnd={edgeMarker(a)}
              opacity={a.inCycle || a.inTrace ? 1 : a.edge.kind === 'observation' ? 0.95 : 0.85}
            />
            <text
              x={a.lx}
              y={a.ly}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="11"
              fontFamily="ui-monospace, monospace"
              fill={edgeTextColor(a)}
              stroke="#1a212b"
              strokeWidth="3.5"
              paintOrder="stroke"
            >
              {a.edge.w > 0 ? `+${a.edge.w}` : a.edge.w}
            </text>
          </g>
        ))}

        {events.map((ev, i) => {
          const { x, y } = nodePos(i, n, hasOriginEdges)
          const inCycle = cycleNodes.has(i)
          const inTrace = traceNodes?.has(i) ?? false
          const fill = inCycle ? '#3d1f22' : inTrace ? '#2d2440' : '#222c38'
          const stroke = inCycle ? '#f85149' : inTrace ? '#bc8cff' : '#46586b'
          const emphasized = inCycle || inTrace
          const label = ev.name.length > 6 ? `${ev.name.slice(0, 5)}…` : ev.name
          return (
            <g key={ev.id}>
              <circle cx={x} cy={y} r={NODE_R} fill={fill} stroke={stroke} strokeWidth={emphasized ? 2.4 : 1.4} />
              <text
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="12"
                fontWeight={emphasized ? 700 : 500}
                fill={inCycle ? '#ff8f8a' : inTrace ? '#d2a8ff' : '#e6edf3'}
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* 虚拟时间原点 t0（中心）：仅在有观测边时显示 */}
        {hasOriginEdges && (
          <g>
            <circle
              cx={CX}
              cy={CY}
              r={NODE_R + 2}
              fill={originInCycle ? '#3d1f22' : originInTrace ? '#2d2440' : '#332a12'}
              stroke={originInCycle ? '#f85149' : originInTrace ? '#bc8cff' : '#e3a008'}
              strokeWidth={originInCycle || originInTrace ? 2.6 : 2.0}
            />
            <text
              x={CX}
              y={CY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="12"
              fontWeight={700}
              fill={originInCycle ? '#ff8f8a' : originInTrace ? '#d2a8ff' : '#f0c674'}
            >
              t₀
            </text>
            <text x={CX} y={CY + NODE_R + 15} textAnchor="middle" fontSize="10.5" fill="#c99a2e">
              时间原点
            </text>
          </g>
        )}
      </svg>
      <div className="graph-legend">
        <span>
          <span className="swatch" style={{ background: '#5b7186' }} />
          相对约束边（t终点 − t起点 ≤ w，分钟）
        </span>
        <span>
          <span className="swatch" style={{ background: '#e3a008' }} />
          绝对时间观测边（与时间原点 t₀ 相连，虚线）
        </span>
        <span>
          <span className="swatch" style={{ background: '#f85149' }} />
          矛盾环
        </span>
        {(traceEdgeKeys?.size ?? 0) > 0 && (
          <span>
            <span className="swatch" style={{ background: '#bc8cff' }} />
            边界追溯链
          </span>
        )}
        <span>
          <span className="swatch" style={{ background: '#e3a008', borderRadius: '50%', width: 10, height: 10 }} />
          时间原点 t₀ = 最早观测起点
        </span>
      </div>
    </div>
  )
}

/** 计算边的二次贝塞尔路径与标签位置；自环画成节点上方的小环 */
function arcPath(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  self: boolean,
  ord: number,
  total: number,
): { path: string; lx: number; ly: number } {
  if (self) {
    const dx = 16 + ord * 6
    const path = `M ${p1.x - 8} ${p1.y - NODE_R + 2}
      C ${p1.x - dx} ${p1.y - NODE_R - 26}, ${p1.x + dx} ${p1.y - NODE_R - 26}, ${p1.x + 8} ${p1.y - NODE_R + 2}`
    return { path, lx: p1.x, ly: p1.y - NODE_R - 22 }
  }

  const mx = (p1.x + p2.x) / 2
  const my = (p1.y + p2.y) / 2
  const vx = p2.x - p1.x
  const vy = p2.y - p1.y
  const len = Math.hypot(vx, vy)
  // 单位法向量
  const nx = -vy / len
  const ny = vx / len
  // 同一条弦上的多条边分摊不同曲率；反向边天然分到另一侧
  const spread = total > 1 ? (ord - (total - 1) / 2) * 26 : 0
  const bend = 34 + spread
  const cxp = mx + nx * bend
  const cyp = my + ny * bend

  // 起止点收到圆周边，避免箭头埋进节点
  const ux = vx / len
  const uy = vy / len
  const sx = p1.x + ux * NODE_R
  const sy = p1.y + uy * NODE_R
  const ex = p2.x - ux * (NODE_R + 6)
  const ey = p2.y - uy * (NODE_R + 6)

  return {
    path: `M ${sx} ${sy} Q ${cxp} ${cyp} ${ex} ${ey}`,
    lx: mx + nx * (bend * 0.62),
    ly: my + ny * (bend * 0.62),
  }
}
