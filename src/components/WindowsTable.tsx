import type { BoundTrace, Constraint, TimeObservation, TEvent, WindowInfo } from '../types'
import { formatAt, formatFullDateTime, formatOffset } from '../lib/format'
import TracePanel from './TracePanel'

interface Props {
  events: TEvent[]
  windows: Map<number, WindowInfo>
  cycleEventIds: Set<string>
  /** 时间原点对应的真实时刻（= 最早观测起点）；无观测时为 null */
  baseISO: string | null
  /** 观测列表（追溯面板展示用） */
  observations: TimeObservation[]
  /** 嵌入修复方案卡片时复用，不再渲染外层面板标题 */
  embedded?: boolean
  /** 当前展示的边界追溯（仅主时间窗表传入） */
  trace?: BoundTrace | null
  /** 追溯面板展示所需的（有效）约束 */
  constraints?: Constraint[]
  /** 点击某事件的最早/最晚时间：请求追溯该边界 */
  onTrace?: (eventIdx: number, kind: 'earliest' | 'latest') => void
  onCloseTrace?: () => void
}

const STATUS_META: Record<WindowInfo['status'], { label: string; cls: string; hint: string }> = {
  bounded: { label: '可定时', cls: 'bounded', hint: '最早/最晚均可由观测与约束推出' },
  oneSided: { label: '仅单边有界', cls: 'oneSided', hint: '只能推出最早或最晚一侧' },
  disconnected: { label: '无法定时', cls: 'disconnected', hint: '未与任何绝对时间观测连通' },
}

/** 单元格不可追溯时的原因说明 */
function noTraceReason(w: WindowInfo | undefined, kind: 'earliest' | 'latest', baseMissing: boolean): string {
  const side = kind === 'earliest' ? '最早' : '最晚'
  if (baseMissing) {
    return `尚未录入任何绝对时间观测，没有时间基准，${side}边界不存在、不可追溯`
  }
  if (!w || w.status === 'disconnected') {
    return `该事件与任何绝对时间观测之间都没有约束通路，无法定时，${side}边界不存在、不可追溯`
  }
  // 仅单边有界：另一侧无界
  return `该事件的${side}一侧无界：${
    kind === 'earliest' ? '反向' : '正向'
  }差分图上从时间原点不可达，没有推出该边界的约束/观测链，不可追溯`
}

export default function WindowsTable({
  events,
  windows,
  cycleEventIds,
  baseISO,
  observations,
  embedded = false,
  trace = null,
  constraints = [],
  onTrace,
  onCloseTrace,
}: Props) {
  const traceable = !!onTrace && baseISO !== null

  /** 渲染最早/最晚时间单元格：有界且可追溯时为按钮，否则置灰并说明原因 */
  const renderTimeCell = (i: number, w: WindowInfo | undefined, kind: 'earliest' | 'latest') => {
    const offset = kind === 'earliest' ? w?.earliestOffset : w?.latestOffset
    if (!w || offset === null || offset === undefined) {
      return (
        <span className="cell-na" title={noTraceReason(w, kind, baseISO === null)}>
          —<span className="cell-na-icon">ⓘ</span>
        </span>
      )
    }
    const text = formatAt(baseISO, offset)
    if (!traceable) return text
    const active = trace !== null && trace.eventIdx === i && trace.kind === kind
    return (
      <button
        type="button"
        className={`cell-btn${active ? ' active' : ''}`}
        title={
          active
            ? '再次点击关闭追溯'
            : `点击追溯：从时间原点推导该${kind === 'earliest' ? '最早' : '最晚'}边界的紧约束链`
        }
        onClick={() => onTrace!(i, kind)}
      >
        {text}
      </button>
    )
  }

  return (
    <div className="panel" style={embedded ? { padding: 0, border: 'none', background: 'transparent' } : undefined}>
      {!embedded && (
        <h3>
          各事件的绝对时间窗
          <span className="count">
            最早 ≤ 实际时间 ≤ 最晚 · 基准 t₀ = {formatFullDateTime(baseISO)}（最早观测起点）
            {traceable && ' · 点击最早/最晚时间可追溯边界推导链'}
          </span>
        </h3>
      )}
      {baseISO === null && (
        <div className="empty-hint">尚未录入任何绝对时间观测：相对约束系统可先行校验，但绝对时间窗需要至少一条观测。</div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="windows">
          <thead>
            <tr>
              <th>事件</th>
              <th>状态</th>
              <th className="num">最早偏移</th>
              <th className="num">最早时间</th>
              <th className="num">最晚偏移</th>
              <th className="num">最晚时间</th>
              <th className="num">窗宽</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => {
              const w = windows.get(i)
              const meta = w ? STATUS_META[w.status] : STATUS_META.disconnected
              const inCycle = cycleEventIds.has(ev.id)
              const traced = trace !== null && trace.eventIdx === i
              const directCount = w?.directObservationIds.length ?? 0
              const width =
                w && w.earliestOffset !== null && w.latestOffset !== null
                  ? `${w.latestOffset - w.earliestOffset} 分钟`
                  : '—'
              return (
                <tr key={ev.id} className={`${inCycle ? 'cycle' : ''}${traced ? ' traced' : ''}`}>
                  <td>
                    {ev.name}
                    {ev.note && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>{ev.note}</div>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${meta.cls}`} title={meta.hint}>
                      {meta.label}
                    </span>
                    {directCount > 0 && (
                      <span
                        className="badge observed"
                        style={{ marginLeft: 6 }}
                        title={`该事件有 ${directCount} 条直接的绝对时间观测`}
                      >
                        直接观测 ×{directCount}
                      </span>
                    )}
                  </td>
                  <td className="num">{w ? formatOffset(w.earliestOffset) : '—'}</td>
                  <td className="num">{renderTimeCell(i, w, 'earliest')}</td>
                  <td className="num">{w ? formatOffset(w.latestOffset) : '—'}</td>
                  <td className="num">{renderTimeCell(i, w, 'latest')}</td>
                  <td className="num">{width}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 边界依据追溯面板（仅主时间窗表；修复方案卡片内嵌表格不可追溯） */}
      {!embedded && trace && onCloseTrace && (
        <TracePanel
          trace={trace}
          events={events}
          constraints={constraints}
          observations={observations}
          baseISO={baseISO}
          onClose={onCloseTrace}
        />
      )}
    </div>
  )
}
