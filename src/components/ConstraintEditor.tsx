import { useMemo, useState } from 'react'
import type { AuditEntry, Constraint, Relation, TEvent } from '../types'
import AuditPanel from './AuditPanel'

interface Props {
  events: TEvent[]
  constraints: Constraint[]
  cycleConstraintIds: Set<string>
  /** 边界追溯链上的约束 id（同步高亮） */
  traceConstraintIds?: Set<string>
  /** 修复预览中临时停用的约束 id（不写入 localStorage） */
  previewOffIds?: Set<string> | null
  /** 冗余证词审计结果（null = 系统矛盾，审计暂停）；停用的约束不参与审计 */
  audit: AuditEntry[] | null
  onAdd: (c: Omit<Constraint, 'id'>) => void
  onRemove: (id: string) => void
  onUpdate: (id: string, patch: Partial<Constraint>) => void
}

export default function ConstraintEditor({
  events,
  constraints,
  cycleConstraintIds,
  traceConstraintIds,
  previewOffIds,
  audit,
  onAdd,
  onRemove,
  onUpdate,
}: Props) {
  const [aId, setAId] = useState('')
  const [relation, setRelation] = useState<Relation>('earlier')
  const [bId, setBId] = useState('')
  const [min, setMin] = useState('0')
  const [max, setMax] = useState('10')

  const nameOf = useMemo(() => {
    const m = new Map(events.map((e) => [e.id, e.name]))
    return (id: string) => m.get(id) ?? '（已删除事件）'
  }, [events])

  // 约束 id -> 审计条目（用于在约束行内标注冗余/必要结论；null 表示审计暂停）
  const auditById = useMemo(
    () => new Map((audit ?? []).map((e) => [e.constraintId, e])),
    [audit],
  )

  const minNum = Number(min)
  const maxNum = Number(max)
  const rangeValid =
    Number.isFinite(minNum) && Number.isFinite(maxNum) && minNum >= 0 && minNum <= maxNum
  const canAdd = events.length >= 2 && aId && bId && aId !== bId && rangeValid

  const submit = () => {
    if (!canAdd) return
    onAdd({ aId, bId, relation, min: minNum, max: maxNum, enabled: true })
  }

  return (
    <div className="panel">
      <h3>
        时序约束
        <span className="count">
          {constraints.filter((c) => c.enabled).length}/{constraints.length} 条生效
        </span>
      </h3>

      {events.length < 2 && <div className="empty-hint">至少添加两个事件后才能录入约束。</div>}

      {events.length >= 2 && constraints.length === 0 && (
        <div className="empty-hint">还没有约束。用下方表单录入“事件 A 比事件 B 早/晚 x~y 分钟”。</div>
      )}

      {constraints.map((c) => {
        const inCycle = cycleConstraintIds.has(c.id)
        const inTrace = traceConstraintIds?.has(c.id) ?? false
        const previewOff = previewOffIds?.has(c.id) ?? false
        const auditEntry = auditById.get(c.id)
        return (
          <div
            key={c.id}
            className={`constraint-row${inCycle ? ' in-cycle' : ''}${inTrace ? ' in-trace' : ''}${c.enabled && !previewOff ? '' : ' disabled'}${previewOff ? ' preview-off' : ''}`}
          >
            <div className="constraint-editors">
              <input
                type="checkbox"
                checked={c.enabled}
                disabled={previewOff}
                onChange={(e) => onUpdate(c.id, { enabled: e.target.checked })}
                title={previewOff ? '修复预览中临时停用（未保存）' : '启用 / 停用该约束'}
              />
              <select
                value={c.aId}
                onChange={(e) => onUpdate(c.id, { aId: e.target.value })}
                aria-label="事件 A"
              >
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <select
                value={c.relation}
                onChange={(e) => onUpdate(c.id, { relation: e.target.value as Relation })}
                aria-label="关系"
              >
                <option value="earlier">早于</option>
                <option value="later">晚于</option>
              </select>
              <select
                value={c.bId}
                onChange={(e) => onUpdate(c.id, { bId: e.target.value })}
                aria-label="事件 B"
              >
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <input
                className="num"
                type="number"
                min={0}
                value={c.min}
                onChange={(e) => onUpdate(c.id, { min: Number(e.target.value) })}
                aria-label="最小分钟数"
              />
              <span className="sep">~</span>
              <input
                className="num"
                type="number"
                min={0}
                value={c.max}
                onChange={(e) => onUpdate(c.id, { max: Number(e.target.value) })}
                aria-label="最大分钟数"
              />
              <span className="sep">分钟</span>
              <button className="small danger-ghost" onClick={() => onRemove(c.id)}>
                删除
              </button>
            </div>
            <div className="constraint-text">
              读作：「{nameOf(c.aId)}」{c.relation === 'earlier' ? '早于' : '晚于'}「{nameOf(c.bId)}」{' '}
              {c.min === c.max ? c.min : `${c.min}~${c.max}`} 分钟
              {auditEntry && (
                <span
                  className={`badge audit-${auditEntry.verdict}`}
                  title={
                    auditEntry.verdict === 'redundant'
                      ? '冗余证词审计：其余约束与全部观测已能推出不弱于该证词的时差区间'
                      : '冗余证词审计：排除该证词后推导区间超出其声称范围，该证词提供了独立信息'
                  }
                >
                  {auditEntry.verdict === 'redundant' ? '冗余' : '必要'}
                </span>
              )}
              {inCycle && '　← 属于矛盾环'}
              {inTrace && '　← 属于边界追溯链'}
              {previewOff && '　← 预览停用（未保存）'}
            </div>
          </div>
        )
      })}

      {events.length >= 2 && (
        <div className="add-row">
          <select value={aId} onChange={(e) => setAId(e.target.value)} aria-label="新约束事件 A">
            <option value="">事件 A…</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
            <option value="earlier">早于</option>
            <option value="later">晚于</option>
          </select>
          <select value={bId} onChange={(e) => setBId(e.target.value)} aria-label="新约束事件 B">
            <option value="">事件 B…</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <input
            className={`num${!rangeValid ? ' invalid' : ''}`}
            type="number"
            min={0}
            value={min}
            onChange={(e) => setMin(e.target.value)}
            aria-label="新约束最小分钟数"
            title="最小分钟数（≥0 且 ≤ 最大值）"
          />
          <span className="sep">~</span>
          <input
            className={`num${!rangeValid ? ' invalid' : ''}`}
            type="number"
            min={0}
            value={max}
            onChange={(e) => setMax(e.target.value)}
            aria-label="新约束最大分钟数"
          />
          <span className="sep">分钟</span>
          <button
            className="primary"
            onClick={submit}
            disabled={!canAdd}
            title={aId === bId ? '事件 A 与事件 B 不能相同' : !rangeValid ? '需满足 0 ≤ 最小值 ≤ 最大值' : ''}
          >
            添加约束
          </button>
        </div>
      )}

      {/* 冗余证词审计：复用本列表的约束与差分图，只读展示推导区间与结论 */}
      <AuditPanel events={events} constraints={constraints} audit={audit} />
    </div>
  )
}
