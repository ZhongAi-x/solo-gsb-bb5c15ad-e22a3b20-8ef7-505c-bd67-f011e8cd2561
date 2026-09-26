import type { PriorityLevel, ScheduleResult, TEvent, WindowInfo } from '../types'
import { formatAt, formatOffset } from '../lib/format'
import { DEFAULT_PRIORITY } from '../lib/schedule'

interface Props {
  events: TEvent[]
  /** 时间原点对应的真实时刻（= 最早观测起点）；无观测为 null */
  baseISO: string | null
  desiredTimes: Record<string, string>
  /** 各事件期望时刻的优先级层级（未设置的按「中」） */
  desiredPriorities: Record<string, PriorityLevel>
  /** 有效差分系统是否可满足；矛盾时不展示任何旧排程结果 */
  satisfiable: boolean
  /** 是否至少存在一条有效观测（时间原点已锚定到真实时刻） */
  hasObservations: boolean
  /** 有效时间窗（用于识别未与任何观测连通的事件） */
  windows: Map<number, WindowInfo>
  /** 排程结果；无可参与期望时为 null */
  schedule: ScheduleResult | null
  onDesiredChange: (eventId: string, iso: string | null) => void
  onPriorityChange: (eventId: string, level: PriorityLevel) => void
}

/** 偏差展示：+5 分钟 / −3 分钟 / 0 分钟 */
function deviationText(d: number): string {
  if (d === 0) return '0 分钟'
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} 分钟`
}

/** 层级短标签（徽章/表格用） */
const LEVEL_LABEL: Record<PriorityLevel, string> = { high: '高', medium: '中', low: '低' }
/** 层级全称（分层小节标题用） */
const LEVEL_NAME: Record<PriorityLevel, string> = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
}

/**
 * 分层最小偏差排程面板：为事件填写期望时刻，并可为每个期望选择
 * 高 / 中 / 低优先级（默认中）。系统对整体差分系统（相对约束 + 全部绝对时间观测）
 * 按 高 → 中 → 低 做字典序最小化：先求本层最小非负整数容差 D，使全部启用约束、
 * 观测、已固定的高层容差与本层每个期望「实际时刻 ∈ 期望 ±D」同时可满足，
 * 固定该层容差后再求下一层；最终输出一份确定性可行排程。
 * 任何编辑（约束、观测、期望、层级）都会触发实时重算；矛盾时不展示任何旧结果。
 */
export default function SchedulePanel({
  events,
  baseISO,
  desiredTimes,
  desiredPriorities,
  satisfiable,
  hasObservations,
  windows,
  schedule,
  onDesiredChange,
  onPriorityChange,
}: Props) {
  const ready = satisfiable && hasObservations
  const anyDesired = events.some((e) => !!desiredTimes[e.id])
  // 各层达到 ±D 的事件合集（用于表格中的标记）
  const tight = new Set<number>()
  if (schedule) for (const l of schedule.layers) for (const i of l.tightEventIdx) tight.add(i)

  return (
    <div className="panel schedule-panel">
      <h3>
        分层最小偏差排程
        <span className="count">
          {schedule
            ? `按 高 → 中 → 低 字典序最小化 · ${schedule.desiredCount} 个期望事件参与整体搜索`
            : '为事件填写期望时刻后自动计算'}
        </span>
      </h3>

      {events.length === 0 && (
        <div className="empty-hint">添加事件、录入观测与约束后，可使用分层最小偏差排程。</div>
      )}

      {events.length > 0 && !satisfiable && (
        <div className="schedule-note danger">
          ⛔ 差分系统存在矛盾，分层最小偏差排程不可用：请先核对观测/证词或按上方修复建议处理。
          矛盾解除前<strong>不展示任何排程结果</strong>（避免误用过期结论）。
        </div>
      )}

      {events.length > 0 && satisfiable && !hasObservations && (
        <div className="schedule-note warn">
          🎯 尚未录入任何绝对时间观测：请先在「绝对时间观测」面板录入至少一条观测，再填写期望时刻。
        </div>
      )}

      {events.length > 0 && ready && (
        <>
          <div className="desired-title">
            期望时刻（留空则不参与排程；未与任何观测连通的事件不参与。
            每个期望可选高 / 中 / 低优先级，默认「中」）
          </div>
          <div className="desired-list">
            {events.map((ev, i) => {
              const disconnected = windows.get(i)?.status === 'disconnected'
              const val = desiredTimes[ev.id] ?? ''
              const level = desiredPriorities[ev.id] ?? DEFAULT_PRIORITY
              return (
                <div className="desired-row" key={ev.id}>
                  <span className="name" title={ev.name}>
                    {ev.name}
                  </span>
                  {disconnected && (
                    <span className="badge offlink" title="该事件与任何观测都没有约束通路，期望时刻不参与排程">
                      未连通
                    </span>
                  )}
                  <input
                    type="datetime-local"
                    value={val}
                    onChange={(e) => onDesiredChange(ev.id, e.target.value || null)}
                    aria-label={`${ev.name} 的期望时刻`}
                  />
                  {val && (
                    <>
                      <select
                        className="prio-select"
                        value={level}
                        onChange={(e) => onPriorityChange(ev.id, e.target.value as PriorityLevel)}
                        title="期望优先级：按 高 → 中 → 低 字典序最小化各层最大偏差"
                        aria-label={`${ev.name} 的期望优先级`}
                      >
                        <option value="high">高</option>
                        <option value="medium">中</option>
                        <option value="low">低</option>
                      </select>
                      <button
                        className="small"
                        onClick={() => onDesiredChange(ev.id, null)}
                        title="清除该期望时刻"
                      >
                        清除
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {!schedule && (
            <div className="empty-hint">
              {anyDesired
                ? '已填写的期望时刻均属于未与任何观测连通的事件，不参与排程；请为可定时事件填写期望时刻。'
                : '还没有期望时刻：填写后系统将按 高 → 中 → 低 字典序搜索各层最小偏差 D，并给出一份确定性的可行排程。'}
            </div>
          )}

          {schedule && (
            <>
              {/* 分层结果：每层最优 D、参与事件数与达到 ±D 的事件 */}
              <div className="layer-list">
                {schedule.layers.map((layer) => (
                  <div className="layer-block" key={layer.level}>
                    <span className={`badge prio-${layer.level}`}>{LEVEL_NAME[layer.level]}</span>
                    {layer.count === 0 || layer.D === null ? (
                      <span className="layer-empty">无参与事件</span>
                    ) : (
                      <>
                        <span>
                          最优 <span className="dval">D = {layer.D}</span> 分钟
                        </span>
                        <span className="sep">·</span>
                        <span>{layer.count} 个事件</span>
                        <span className="sep">·</span>
                        <span>本层最大偏差 {layer.maxDeviation} 分钟</span>
                        {layer.tightEventIdx.length > 0 && (
                          <>
                            <span className="sep">·</span>
                            <span>
                              达到 ±D：
                              {layer.tightEventIdx.map((i) => `「${events[i].name}」`).join('、')}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table className="windows">
                  <thead>
                    <tr>
                      <th>事件</th>
                      <th>层级</th>
                      <th>状态</th>
                      <th className="num">实际时刻</th>
                      <th className="num">相对基准</th>
                      <th className="num">期望时刻</th>
                      <th className="num">期望偏差</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.entries.map((en) => {
                      const ev = events[en.eventIdx]
                      return (
                        <tr key={ev.id}>
                          <td>
                            {ev.name}
                            {en.status === 'unscheduled' && (
                              <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                                未与任何观测连通{en.desiredIgnored && '，期望时刻未生效'}
                              </div>
                            )}
                          </td>
                          <td>
                            {en.priority !== null ? (
                              <span
                                className={`badge prio-${en.priority}`}
                                title={`期望优先级：${LEVEL_NAME[en.priority]}`}
                              >
                                {LEVEL_LABEL[en.priority]}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            {en.status === 'scheduled' && (
                              <span className="status-pill bounded">已定时</span>
                            )}
                            {en.status === 'unscheduled' && (
                              <span
                                className="status-pill disconnected"
                                title="与任何绝对时间观测都没有约束通路，无法定时"
                              >
                                未定时
                              </span>
                            )}
                          </td>
                          <td className="num">
                            {en.offsetMin !== null ? formatAt(baseISO, en.offsetMin) : '—'}
                          </td>
                          <td className="num">
                            {en.offsetMin !== null ? formatOffset(en.offsetMin) : '—'}
                          </td>
                          <td className="num">
                            {en.desiredOffset !== null
                              ? formatAt(baseISO, en.desiredOffset)
                              : '—'}
                          </td>
                          <td className="num">
                            {en.deviation !== null ? (
                              <>
                                {deviationText(en.deviation)}
                                {tight.has(en.eventIdx) && en.priority !== null && (
                                  <span
                                    className="badge tight"
                                    title={`该事件的偏差达到${LEVEL_NAME[en.priority]}层最小偏差 D = ${
                                      schedule.layers.find((l) => l.level === en.priority)?.D
                                    } 分钟`}
                                  >
                                    达到 ±D
                                  </span>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
