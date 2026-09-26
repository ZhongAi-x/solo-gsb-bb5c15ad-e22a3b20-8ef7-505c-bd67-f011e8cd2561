import { useMemo, useState } from 'react'
import type { AuditEntry, AuditVerdict, Constraint, TEvent } from '../types'
import { describeConstraint } from '../lib/format'

interface Props {
  events: TEvent[]
  /** 有效约束（含修复预览的临时停用）：用于把审计条目映射回证词原文 */
  constraints: Constraint[]
  /** 审计结果；null 表示系统存在矛盾，审计暂停 */
  audit: AuditEntry[] | null
}

type Filter = 'all' | AuditVerdict

/** 推导时差边界的紧凑展示：无界为 −∞ / +∞ */
function boundText(v: number | null, side: 'min' | 'max'): string {
  if (v === null) return side === 'min' ? '−∞' : '+∞'
  if (v === 0) return '0'
  return v > 0 ? `+${v}` : `−${Math.abs(v)}`
}

/** 审计结论的展示文案与悬浮说明 */
const VERDICT_META: Record<AuditVerdict, { label: string; hint: string }> = {
  redundant: {
    label: '冗余',
    hint: '其余约束与全部观测已能推出不弱于该证词的时差区间：该证词可视为冗余',
  },
  necessary: {
    label: '必要',
    hint: '排除该证词后，推导区间超出其声称范围：该证词提供了独立信息',
  },
}

/**
 * 冗余证词审计：附在「时序约束」列表下方的只读审计列表。
 * 系统可满足时逐条暂时排除一条已启用相对约束，用其余约束与全部观测
 * 重新推导该证词两端事件的最紧时差区间：完整落在原证词区间内 → 冗余，
 * 否则 → 必要（不可达的边界按无界处理；停用的约束不参与审计）。
 * 列表逐条展示推导区间与结论，支持按结论筛选；矛盾状态下审计暂停。
 * 审计为纯计算，不改写约束与本地存档。
 */
export default function AuditPanel({ events, constraints, audit }: Props) {
  const [filter, setFilter] = useState<Filter>('all')

  const nameOf = useMemo(() => {
    const m = new Map(events.map((e) => [e.id, e.name]))
    return (id: string) => m.get(id) ?? '（已删除事件）'
  }, [events])

  const byId = useMemo(() => new Map(constraints.map((c) => [c.id, c])), [constraints])

  const redundantCount = audit?.filter((e) => e.verdict === 'redundant').length ?? 0
  const necessaryCount = audit ? audit.length - redundantCount : 0
  const filtered = (audit ?? []).filter((e) => filter === 'all' || e.verdict === filter)

  return (
    <div className="audit-section">
      <div className="audit-head">
        <h4>冗余证词审计</h4>
        {audit !== null && audit.length > 0 && (
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            aria-label="按结论筛选审计结果"
            title="按结论筛选审计结果"
          >
            <option value="all">全部结论</option>
            <option value="redundant">仅冗余</option>
            <option value="necessary">仅必要</option>
          </select>
        )}
      </div>
      <div className="audit-desc">
        系统可满足时，逐条暂时排除一条已启用约束，用其余约束与全部观测重新推导该证词两端事件的
        最紧时差区间：完整落在原证词区间内 → <strong>冗余</strong>，否则 → <strong>必要</strong>
        （不可达的边界按无界处理；停用的约束不参与审计）。审计为只读计算，不改写约束与本地存档。
      </div>

      {audit === null && (
        <div className="audit-note danger">
          ⛔ 系统存在矛盾：冗余证词审计已暂停。请先按上方矛盾链与修复建议处理，
          恢复可满足后将自动重新审计。
        </div>
      )}

      {audit !== null && audit.length === 0 && (
        <div className="empty-hint">没有已启用的相对约束可审计。</div>
      )}

      {audit !== null && audit.length > 0 && (
        <>
          <div className="audit-summary">
            共 {audit.length} 条启用约束参与审计：冗余 {redundantCount} 条 · 必要 {necessaryCount} 条
          </div>
          {filtered.length === 0 && (
            <div className="empty-hint">当前筛选条件下没有审计结果。</div>
          )}
          {filtered.map((e) => {
            const c = byId.get(e.constraintId)
            if (!c) return null
            const meta = VERDICT_META[e.verdict]
            const unbounded = e.derivedMin === null || e.derivedMax === null
            return (
              <div className={`audit-row ${e.verdict}`} key={e.constraintId}>
                <div className="audit-row-head">
                  <span className="audit-text">{describeConstraint(c, nameOf)}</span>
                  <span className={`badge audit-${e.verdict}`} title={meta.hint}>
                    {meta.label}
                  </span>
                </div>
                <div className="audit-derived">
                  排除后推导时差：
                  <code>
                    {boundText(e.derivedMin, 'min')} ~ {boundText(e.derivedMax, 'max')} 分钟
                  </code>
                  {unbounded && <span title="该侧在差分图上不可达，按无界处理">（含无界侧）</span>}
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
