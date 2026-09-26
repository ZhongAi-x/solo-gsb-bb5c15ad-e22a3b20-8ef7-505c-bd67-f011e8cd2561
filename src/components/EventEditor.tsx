import { useState } from 'react'
import type { TEvent } from '../types'

interface Props {
  events: TEvent[]
  cycleEventIds: Set<string>
  onAdd: (name: string, note: string) => void
  onRemove: (id: string) => void
  onRename: (id: string, name: string) => void
}

export default function EventEditor({
  events,
  cycleEventIds,
  onAdd,
  onRemove,
  onRename,
}: Props) {
  const [name, setName] = useState('')
  const [note, setNote] = useState('')

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onAdd(trimmed, note.trim())
    setName('')
    setNote('')
  }

  return (
    <div className="panel">
      <h3>
        事件
        <span className="count">{events.length} 个</span>
      </h3>

      {events.length === 0 && <div className="empty-hint">还没有事件，先添加采访 / 复盘中的关键时点。</div>}

      {events.map((ev) => (
        <div className="event-row" key={ev.id}>
          <div className="name">
            <input
              value={ev.name}
              onChange={(e) => onRename(ev.id, e.target.value)}
              style={{ width: '100%' }}
              aria-label="事件名称"
            />
            {ev.note && <div className="note">{ev.note}</div>}
          </div>
          {cycleEventIds.has(ev.id) && <span className="badge cycle">矛盾环</span>}
          <button className="small danger-ghost" onClick={() => onRemove(ev.id)} title="删除事件及其相关约束与观测">
            删除
          </button>
        </div>
      ))}

      <div className="add-row">
        <input
          className="name-input"
          placeholder="新事件名称，如：服务恢复"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <input
          placeholder="备注（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          style={{ width: 160 }}
        />
        <button className="primary" onClick={submit} disabled={!name.trim()}>
          添加事件
        </button>
      </div>
    </div>
  )
}
