import { useState } from 'react'
import type { TimeObservation, TEvent } from '../types'
import { describeObservation, formatFullDateTime } from '../lib/format'

interface Props {
  events: TEvent[]
  observations: TimeObservation[]
  /** 矛盾环上的观测 id（红色高亮） */
  cycleObservationIds: Set<string>
  /** 边界追溯链上的观测 id（紫色高亮） */
  traceObservationIds?: Set<string>
  onAdd: (o: Omit<TimeObservation, 'id'>) => void
  onRemove: (id: string) => void
  onUpdate: (id: string, patch: Partial<TimeObservation>) => void
}

/**
 * 绝对时间观测录入面板：可为任意事件录入一条「发生于 start ~ end」的观测区间，
 * start 与 end 相同即精确时刻（零宽区间）。同一事件可录入多条观测；
 * 全部观测与相对约束进入同一差分图统一计算，任何增删改实时重算并持久化。
 */
export default function ObservationEditor({
  events,
  observations,
  cycleObservationIds,
  traceObservationIds,
  onAdd,
  onRemove,
  onUpdate,
}: Props) {
  const [eventId, setEventId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const nameOf = (id: string) => events.find((e) => e.id === id)?.name ?? '（已删除事件）'

  const startValid = !!start && !Number.isNaN(new Date(start).getTime())
  const endValid = !!end && !Number.isNaN(new Date(end).getTime())
  const rangeValid = startValid && endValid && new Date(end).getTime() >= new Date(start).getTime()
  const canAdd = events.length >= 1 && !!eventId && rangeValid

  const submit = () => {
    if (!canAdd) return
    onAdd({ eventId, start, end })
    setStart('')
    setEnd('')
  }

  /** 区间两个端点的同步编辑：改起点时若终点更早（或原为空），自动把终点收为精确时刻 */
  const editStart = (id: string, value: string) => {
    const o = observations.find((x) => x.id === id)
    if (!o) return
    if (value && (!o.end || new Date(o.end).getTime() < new Date(value).getTime())) {
      onUpdate(id, { start: value, end: value })
    } else {
      onUpdate(id, { start: value })
    }
  }

  return (
    <div className="panel observation-panel">
      <h3>
        绝对时间观测
        <span className="count">
          {observations.length} 条 · 起点与终点相同即精确时刻（零宽区间）· 与相对约束统一求解
        </span>
      </h3>

      {events.length === 0 && <div className="empty-hint">先添加事件，再录入对其发生时刻的观测。</div>}

      {events.length > 0 && observations.length === 0 && (
        <div className="empty-hint">
          还没有绝对时间观测。至少录入一条观测后，系统才能计算各事件的绝对时间窗；
          未被任何观测连通的事件仍会标记为「无法定时」。
        </div>
      )}

      {observations.map((o, i) => {
        const inCycle = cycleObservationIds.has(o.id)
        const inTrace = traceObservationIds?.has(o.id) ?? false
        const exact = o.start === o.end
        const invalid =
          !o.start ||
          Number.isNaN(new Date(o.start).getTime()) ||
          !o.end ||
          Number.isNaN(new Date(o.end).getTime()) ||
          new Date(o.end).getTime() < new Date(o.start).getTime()
        return (
          <div
            key={o.id}
            className={`observation-row${inCycle ? ' in-cycle' : ''}${inTrace ? ' in-trace' : ''}${invalid ? ' invalid' : ''}`}
          >
            <code className="order-no">#{i + 1}</code>
            <select
              value={o.eventId}
              onChange={(e) => onUpdate(o.id, { eventId: e.target.value })}
              aria-label="观测事件"
            >
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <span className="sep">发生于</span>
            <input
              type="datetime-local"
              value={o.start}
              onChange={(e) => editStart(o.id, e.target.value)}
              aria-label="观测最早时刻"
            />
            <span className="sep">~</span>
            <input
              type="datetime-local"
              value={o.end}
              onChange={(e) => onUpdate(o.id, { end: e.target.value || o.start })}
              aria-label="观测最晚时刻"
            />
            {exact ? (
              <span className="badge observed" title="起点与终点相同：精确时刻观测（零宽区间）">
                精确
              </span>
            ) : (
              <span className="badge interval" title="观测区间，单位分钟">
                区间 {Math.round((new Date(o.end).getTime() - new Date(o.start).getTime()) / 60000)} 分
              </span>
            )}
            {inCycle && <span className="badge cycle">矛盾环</span>}
            {inTrace && <span className="badge trace-badge">追溯链</span>}
            {invalid && <span className="badge invalid-badge">时间无效</span>}
            <button className="small danger-ghost" onClick={() => onRemove(o.id)} title="删除该观测">
              删除
            </button>
            <div className="observation-text">
              读作：{describeObservation(o, nameOf)}
              {!exact && !invalid && (
                <>
                  {' '}
                  · 区间 {formatFullDateTime(o.start)} ~ {formatFullDateTime(o.end)}
                </>
              )}
            </div>
          </div>
        )
      })}

      {events.length > 0 && (
        <div className="add-row observation-add">
          <select value={eventId} onChange={(e) => setEventId(e.target.value)} aria-label="新观测事件">
            <option value="">选择事件…</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <span className="sep">发生于</span>
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              // 新增表单：终点留空时跟随起点，默认得到精确时刻观测
              if (!end) setEnd(e.target.value)
            }}
            aria-label="新观测最早时刻"
          />
          <span className="sep">~</span>
          <input
            className={`${!endValid || new Date(end).getTime() < new Date(start).getTime() ? 'invalid' : ''}`}
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            aria-label="新观测最晚时刻"
          />
          <button
            className="primary"
            onClick={submit}
            disabled={!canAdd}
            title={!eventId ? '请选择事件' : !rangeValid ? '需填写有效区间，且终点不早于起点' : ''}
          >
            添加观测
          </button>
        </div>
      )}
    </div>
  )
}
