import { useMemo } from 'react'
import type { Constraint, RepairSearchResult, TimeObservation, TEvent } from '../types'
import { describeConstraint } from '../lib/format'
import WindowsTable from './WindowsTable'

interface Props {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
  repair: RepairSearchResult
  baseISO: string | null
  previewIndex: number | null
  onPreview: (index: number) => void
  onExitPreview: () => void
  onApply: (index: number) => void
}

/**
 * 最小修复建议面板：并列最优（停用相对约束数最少）方案最多 5 个，
 * 按约束录入顺序稳定排序；支持不写入 localStorage 的一键预览与确认应用。
 * 观测是事实记录、不参与停用；当矛盾无法仅靠停用约束消除时明确提示核对观测。
 */
export default function RepairPanel({
  events,
  constraints,
  observations,
  repair,
  baseISO,
  previewIndex,
  onPreview,
  onExitPreview,
  onApply,
}: Props) {
  const constraintById = useMemo(
    () => new Map(constraints.map((c, i) => [c.id, { c, order: i + 1 }])),
    [constraints],
  )
  const nameById = useMemo(() => new Map(events.map((e) => [e.id, e.name])), [events])

  const headNote = repair.optimumProven
    ? `每个方案只需停用 ${repair.disableCount} 条相对约束（已证明为最少停用数）`
    : '未能在搜索上限内给出方案'

  return (
    <div className="panel repair-panel">
      <h3>
        最小修复建议
        <span className="count">
          {headNote} · 累计探索 {repair.statesVisited}/{repair.stateLimit} 个状态
        </span>
      </h3>

      {repair.observationConflict && (
        <div className="repair-trunc danger-note">
          ⛔ 当前矛盾链中包含<strong>绝对时间观测</strong>，且无法仅靠停用相对约束消除
          {repair.truncated ? '（或已达到搜索状态上限）' : ''}
          ：观测被视为事实记录、不可停用。请对照上方红色矛盾链核对涉及的观测区间与证词
          ——例如两条观测互相矛盾，或某条证词要求的间隔与观测到的绝对时刻不相容。
          修改观测后系统会实时重算。
        </div>
      )}

      {!repair.found && !repair.observationConflict && (
        <div className="repair-trunc">
          ⚠️ 在累计探索 {repair.stateLimit} 个状态的上限内未找到可满足的修复方案，搜索已停止。
          <strong>结果可能不完备</strong>：可尝试手动逐条停用可疑约束后继续观察，或增大搜索上限。
        </div>
      )}

      {repair.found && repair.truncated && (
        <div className="repair-trunc">
          ⚠️ 搜索累计达到 {repair.stateLimit} 个状态上限后提前停止，已给出的 {repair.plans.length}
          个方案均为停用 {repair.disableCount} 条约束的最优方案，但同层可能还有未探索到的并列方案，
          <strong>结果可能不完备</strong>。
        </div>
      )}

      {repair.found && !repair.truncated && repair.totalPlans > repair.plans.length && (
        <div className="repair-info">
          共找到 {repair.totalPlans} 个并列最优方案，按约束录入顺序展示前 {repair.plans.length} 个。
        </div>
      )}

      {repair.found && (
        <div className="repair-list">
          {repair.plans.map((plan, i) => {
            const previewing = previewIndex === i
            return (
              <div
                key={plan.disableConstraintIds.join('|') || i}
                className={`repair-card${previewing ? ' previewing' : ''}`}
              >
                <div className="repair-card-head">
                  <strong>方案 {i + 1}</strong>
                  <span className="repair-count">停用 {plan.disableConstraintIds.length} 条相对约束</span>
                  {previewing && <span className="repair-badge">预览中（未保存）</span>}
                  <span className="repair-spacer" />
                  {previewing ? (
                    <button className="small" onClick={onExitPreview}>
                      退出预览
                    </button>
                  ) : (
                    <button
                      className="small"
                      disabled={previewIndex !== null}
                      title={previewIndex !== null ? '请先退出当前预览' : '临时停用这些约束预览效果，不写入本地存储'}
                      onClick={() => onPreview(i)}
                    >
                      一键预览
                    </button>
                  )}
                  <button
                    className="small primary"
                    onClick={() => onApply(i)}
                    title="批量停用这些约束并保存"
                  >
                    确认应用
                  </button>
                </div>

                <div className="repair-off-list">
                  <span className="repair-off-title">需停用：</span>
                  {plan.disableConstraintIds.map((id) => {
                    const hit = constraintById.get(id)
                    if (!hit) return null
                    return (
                      <span key={id} className="repair-off-item">
                        <code className="order-no">#{hit.order}</code>
                        {describeConstraint(hit.c, (eid) => nameById.get(eid) ?? '（已删除事件）')}
                      </span>
                    )
                  })}
                </div>

                <div className="repair-windows">
                  <div className="repair-windows-title">停用后的事件绝对时间窗（观测保持生效）：</div>
                  <WindowsTable
                    events={events}
                    windows={plan.windows}
                    cycleEventIds={EMPTY_SET}
                    baseISO={baseISO}
                    observations={observations}
                    embedded
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const EMPTY_SET: Set<string> = new Set()
