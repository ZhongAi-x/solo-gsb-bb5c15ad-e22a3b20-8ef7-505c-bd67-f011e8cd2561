import { useEffect, useMemo, useState } from 'react'
import type { AppState, PriorityLevel, Constraint, TimeObservation, TEvent } from './types'
import { analyze, traceBound } from './lib/graph'
import { auditRedundancy } from './lib/audit'
import { findMinimalRepairs } from './lib/repair'
import { computeMinDeviationSchedule } from './lib/schedule'
import {
  buildConsistentSample,
  buildContradictionSample,
  emptyState,
  uid,
} from './lib/samples'
import { clearState, loadState, saveState } from './lib/storage'
import { formatFullDateTime } from './lib/format'
import EventEditor from './components/EventEditor'
import ConstraintEditor from './components/ConstraintEditor'
import ObservationEditor from './components/ObservationEditor'
import GraphView, { edgeKey } from './components/GraphView'
import CyclePanel from './components/CyclePanel'
import WindowsTable from './components/WindowsTable'
import RepairPanel from './components/RepairPanel'
import SchedulePanel from './components/SchedulePanel'
import BatchImportPanel from './components/BatchImportPanel'
import SnapshotPanel from './components/SnapshotPanel'
import type { DslImportEntities } from './lib/dsl'

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? buildConsistentSample())
  // 修复方案预览：仅内存生效，不写入 localStorage；任何编辑操作都会退出预览
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  // 边界追溯请求：点击时间窗表中某事件的最早/最晚时间后设置；
  // 编辑数据、进入/退出修复预览时自动清除
  const [traceReq, setTraceReq] = useState<{ eventIdx: number; kind: 'earliest' | 'latest' } | null>(null)

  // 本地持久化：任何修改实时写入 localStorage（预览状态不入存储）
  useEffect(() => {
    saveState(state)
  }, [state])

  const { events, constraints, observations, desiredTimes, desiredPriorities } = state

  // —— 原始数据的实时分析：相对约束 + 绝对时间观测在同一张差分图上求解 ——
  const result = useMemo(
    () => analyze(events, constraints, observations),
    [events, constraints, observations],
  )

  // —— 最小修复建议：仅在检测到矛盾（负环）时搜索；观测不可停用 ——
  const repair = useMemo(
    () =>
      result.satisfiable
        ? null
        : findMinimalRepairs(events, constraints, observations),
    [events, constraints, observations, result.satisfiable],
  )

  // —— 预览中的停用集合 ——
  const previewOffIds = useMemo(() => {
    if (previewIndex === null || !repair) return null
    return new Set(repair.plans[previewIndex]?.disableConstraintIds ?? [])
  }, [previewIndex, repair])

  // —— 叠加预览后的约束与分析结果（观测不允许停用；不修改 state，因此不会写入 localStorage）——
  const effectiveConstraints = useMemo(() => {
    if (!previewOffIds) return constraints
    return constraints.map((c) =>
      previewOffIds.has(c.id) ? { ...c, enabled: false } : c,
    )
  }, [constraints, previewOffIds])

  const effectiveResult = useMemo(() => {
    if (!previewOffIds) return result
    return analyze(events, effectiveConstraints, observations)
  }, [events, effectiveConstraints, observations, previewOffIds, result])

  const hasObservations = result.baseISO !== null

  // —— 冗余证词审计：系统可满足时逐条暂时排除一条已启用约束，用其余约束与全部观测
  //    重推该证词两端的最紧时差区间；矛盾时返回 null（暂停审计）。
  //    编辑或批量导入后随 state 实时重算；只读计算，不改写约束与本地存档 ——
  const audit = useMemo(
    () => auditRedundancy(events, effectiveConstraints, observations),
    [events, effectiveConstraints, observations],
  )

  // —— 分层最小偏差排程：仅在有效系统可满足且存在观测（时间原点已锚定）时计算；
  //    编辑约束、观测、期望值或优先级都会触发实时重算，矛盾时返回 null（不展示旧结果）——
  const schedule = useMemo(() => {
    if (!effectiveResult.satisfiable || effectiveResult.baseISO === null) return null
    return computeMinDeviationSchedule(
      events,
      effectiveConstraints,
      observations,
      desiredTimes,
      desiredPriorities,
    )
  }, [effectiveResult.satisfiable, effectiveResult.baseISO, events, effectiveConstraints, observations, desiredTimes, desiredPriorities])

  // 矛盾环相关集合（用于跨组件高亮；预览可满足时为空）
  const cycleEventIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const i of effectiveResult.cycle.nodes) if (events[i]) s.add(events[i].id)
    }
    return s
  }, [effectiveResult, events])

  const cycleConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) {
        if (e.kind === 'constraint' && e.constraintId) s.add(e.constraintId)
      }
    }
    return s
  }, [effectiveResult])

  const cycleObservationIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) {
        if (e.kind === 'observation' && e.observationId) s.add(e.observationId)
      }
    }
    return s
  }, [effectiveResult])

  const cycleNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle)
      for (const i of effectiveResult.cycle.nodes) s.add(i)
    return s
  }, [effectiveResult])

  const cycleEdgeKeys = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) s.add(edgeKey(e))
    }
    return s
  }, [effectiveResult])

  // —— 边界依据追溯：按当前有效约束（含修复预览）与全部观测重新计算紧约束链 ——
  const trace = useMemo(() => {
    if (!traceReq || effectiveResult.baseISO === null || !effectiveResult.satisfiable) return null
    return traceBound(events, effectiveConstraints, observations, traceReq.eventIdx, traceReq.kind)
  }, [traceReq, events, effectiveConstraints, observations, effectiveResult.baseISO, effectiveResult.satisfiable])

  const traceEdgeKeys = useMemo(() => {
    const s = new Set<string>()
    if (trace) for (const st of trace.steps) s.add(edgeKey(st.edge))
    return s
  }, [trace])

  const traceNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (trace) {
      s.add(trace.eventIdx)
      s.add(events.length) // 时间原点
      for (const st of trace.steps) {
        s.add(st.from)
        s.add(st.to)
      }
    }
    return s
  }, [trace, events.length])

  const traceConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (trace)
      for (const st of trace.steps)
        if (st.edge.kind === 'constraint' && st.edge.constraintId) s.add(st.edge.constraintId)
    return s
  }, [trace])

  const traceObservationIds = useMemo(() => {
    const s = new Set<string>()
    if (trace)
      for (const st of trace.steps)
        if (st.edge.kind === 'observation' && st.edge.observationId && st.edge.observationId !== '__desired_pin__')
          s.add(st.edge.observationId)
    if (trace?.directObservationId) s.add(trace.directObservationId)
    return s
  }, [trace])

  /** 点击时间窗单元格：再次点击同一单元格则关闭追溯 */
  const requestTrace = (eventIdx: number, kind: 'earliest' | 'latest') => {
    setTraceReq((cur) =>
      cur && cur.eventIdx === eventIdx && cur.kind === kind ? null : { eventIdx, kind },
    )
  }

  const activeCount = constraints.filter((c) => c.enabled).length
  const previewing = previewOffIds !== null

  // —— 编辑操作（均退出预览并清除边界追溯，避免预览/追溯与新数据错位）——
  const addEvent = (name: string, note: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    const ev: TEvent = { id: uid('ev'), name, note: note || undefined }
    setState((s) => ({
      ...s,
      events: [...s.events, ev],
    }))
  }

  const removeEvent = (id: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => {
      const desiredTimes = { ...s.desiredTimes }
      delete desiredTimes[id]
      const desiredPriorities = { ...s.desiredPriorities }
      delete desiredPriorities[id]
      return {
        ...s,
        events: s.events.filter((e) => e.id !== id),
        constraints: s.constraints.filter((c) => c.aId !== id && c.bId !== id),
        observations: s.observations.filter((o) => o.eventId !== id),
        desiredTimes,
        desiredPriorities,
      }
    })
  }

  const renameEvent = (id: string, name: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      events: s.events.map((e) => (e.id === id ? { ...e, name } : e)),
    }))
  }

  const addConstraint = (c: Omit<Constraint, 'id'>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, constraints: [...s.constraints, { ...c, id: uid('ct') }] }))
  }

  const removeConstraint = (id: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, constraints: s.constraints.filter((c) => c.id !== id) }))
  }

  const updateConstraint = (id: string, patch: Partial<Constraint>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) => {
        if (c.id !== id) return c
        const next = { ...c, ...patch }
        // 防止输入过程中出现 min > max / 负数
        if (!Number.isFinite(next.min) || next.min < 0) next.min = 0
        if (!Number.isFinite(next.max) || next.max < next.min) next.max = next.min
        if (Number.isFinite(next.min) && next.min > next.max) next.min = next.max
        return next
      }),
    }))
  }

  // —— 绝对时间观测的增 / 改 / 删：与其他编辑一样退出预览、清追溯、实时重算并持久化 ——
  const addObservation = (o: Omit<TimeObservation, 'id'>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, observations: [...s.observations, { ...o, id: uid('obs') }] }))
  }

  const removeObservation = (id: string) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({ ...s, observations: s.observations.filter((o) => o.id !== id) }))
  }

  const updateObservation = (id: string, patch: Partial<TimeObservation>) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      observations: s.observations.map((o) => {
        if (o.id !== id) return o
        const next = { ...o, ...patch }
        // 输入过程中归一：终点早于起点时先夹到起点，避免瞬态出现非法区间造成误报
        if (next.start && next.end && new Date(next.end).getTime() < new Date(next.start).getTime()) {
          next.end = next.start
        }
        return next
      }),
    }))
  }

  // 填写 / 清除某事件的期望时刻（与其他编辑一样退出预览并清除追溯，随后自动重算排程）；
  // 清除期望时刻时一并移除其优先级层级
  const setDesiredTime = (id: string, iso: string | null) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => {
      const desiredTimes = { ...s.desiredTimes }
      const desiredPriorities = { ...s.desiredPriorities }
      if (iso) desiredTimes[id] = iso
      else {
        delete desiredTimes[id]
        delete desiredPriorities[id]
      }
      return { ...s, desiredTimes, desiredPriorities }
    })
  }

  // 设置某事件期望时刻的优先级层级（高/中/低）；与其他编辑一样触发实时重算
  const setDesiredPriority = (id: string, level: PriorityLevel) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      desiredPriorities: { ...s.desiredPriorities, [id]: level },
    }))
  }

  const loadSample = (kind: 'ok' | 'conflict') => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState(kind === 'ok' ? buildConsistentSample() : buildContradictionSample())
  }

  // —— 批量证词导入：解析已在面板内完成（有错误时确认按钮不可用），
  //    这里把生成好的实体一次性追加合并；state 变更即写入 localStorage，现有数据不被覆盖 ——
  const importBatch = (entities: DslImportEntities) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState((s) => ({
      ...s,
      events: [...s.events, ...entities.events],
      constraints: [...s.constraints, ...entities.constraints],
      observations: [...s.observations, ...entities.observations],
    }))
  }

  // —— 案卷快照导入：快照已在面板内通过完整校验（有错误时确认按钮不可用），
  //    这里整包替换当前案卷；state 变更即实时重算并写入 localStorage ——
  const applySnapshot = (next: AppState) => {
    setPreviewIndex(null)
    setTraceReq(null)
    setState(next)
  }

  const resetAll = () => {
    if (!window.confirm('确定清空全部事件、约束、观测与本地存储数据吗？')) return
    setPreviewIndex(null)
    setTraceReq(null)
    clearState()
    setState(emptyState())
  }

  // —— 修复方案：预览 / 确认应用 ——
  const previewRepair = (i: number) => {
    // 进入预览后按有效约束重新计算，旧追溯一律清除
    setTraceReq(null)
    setPreviewIndex(i)
  }
  const exitPreview = () => {
    setTraceReq(null)
    setPreviewIndex(null)
  }
  const applyRepair = (i: number) => {
    if (!repair) return
    const plan = repair.plans[i]
    if (!plan) return
    const off = new Set(plan.disableConstraintIds)
    setPreviewIndex(null)
    setTraceReq(null)
    // 确认后批量停用对应约束（state 变更即写入 localStorage）；观测不受影响
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) =>
        off.has(c.id) ? { ...c, enabled: false } : c,
      ),
    }))
  }

  // —— 顶部状态 ——
  const banner = (() => {
    if (events.length === 0) {
      return {
        cls: 'warn',
        icon: '📋',
        title: '等待录入',
        desc: '添加事件、录入相对时序约束与至少一条绝对时间观测后开始分析。也可以直接载入下方示例数据。',
      }
    }
    if (!effectiveResult.satisfiable) {
      return {
        cls: 'danger',
        icon: '⛔',
        title: '观测与约束相互矛盾，不存在任何可行的事件时间安排',
        desc: `统一差分约束图中检测到负环（环上权重之和为 ${effectiveResult.cycle?.totalWeight} 分钟 < 0）。红色标出的环即一条可复核的矛盾链，同时给出涉及的绝对时间观测与原始证词；下方给出停用相对约束最少的修复建议。`,
      }
    }
    if (previewing) {
      return {
        cls: 'ok',
        icon: '👁️',
        title: '修复预览：停用建议中的约束后，系统恢复可满足',
        desc: '当前为临时预览，停用尚未写入浏览器本地存储；确认无误后请在方案卡片上点击“确认应用”，或退出预览返回原数据。',
      }
    }
    if (!hasObservations) {
      return {
        cls: 'warn',
        icon: '🎯',
        title: '相对约束系统本身一致，但尚未录入任何绝对时间观测',
        desc: '在「绝对时间观测」面板为事件录入精确时刻或观测区间（可多条），即可统一计算各事件的绝对时间窗。',
      }
    }
    return {
      cls: 'ok',
      icon: '✅',
      title: '观测与约束可满足：存在与全部观测、约束相容的时间安排',
      desc: `共 ${events.length} 个事件、${activeCount} 条生效约束、${observations.length} 条观测，时间基准 t₀ = ${formatFullDateTime(result.baseISO)}（最早观测起点）。下表给出每个事件的绝对时间窗；未被任何观测连通的事件标记为“无法定时”。`,
    }
  })()

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>事件时序约束校验器</h1>
          <div className="subtitle">
            采访证词 / 事故复盘 · 多条绝对时间观测 + 相对约束接入同一差分约束图（Difference Constraints）实时求解
          </div>
        </div>
        <div className="toolbar">
          <button onClick={() => loadSample('ok')}>载入可满足示例</button>
          <button onClick={() => loadSample('conflict')}>载入矛盾示例</button>
          <button className="danger-ghost" onClick={resetAll}>
            清空全部数据
          </button>
        </div>
      </header>

      {/* 时间基准信息条 */}
      <div className="anchor-bar">
        <label className="title">时间基准</label>
        <span className="anchor-absolute">
          t₀ = {formatFullDateTime(effectiveResult.baseISO)}（全部有效观测中最早的起点；观测与相对约束均换算为相对 t₀ 的分钟偏移统一求解）
        </span>
      </div>

      {/* 判定横幅 */}
      <div className={`status-banner ${banner.cls}`}>
        <div className="icon">{banner.icon}</div>
        <div>
          <h2>{banner.title}</h2>
          <p>{banner.desc}</p>
          {!effectiveResult.satisfiable && effectiveResult.cycle && (
            <CyclePanel
              cycle={effectiveResult.cycle}
              events={events}
              constraints={effectiveConstraints}
              observations={observations}
            />
          )}
        </div>
      </div>

      {/* 修复预览提示条（预览不写入 localStorage） */}
      {previewing && (
        <div className="preview-bar">
          <span>
            👁️ 正在<strong>预览修复方案 {previewIndex! + 1}</strong>
            ：已临时停用 {previewOffIds!.size} 条相对约束（约束列表中置灰并标记“预览停用”），
            观测保持生效，本预览<strong>不会写入 localStorage</strong>。
          </span>
          <button className="small" onClick={exitPreview}>
            退出预览
          </button>
        </div>
      )}

      {/* 最小修复建议（仅原始数据存在矛盾时搜索并展示） */}
      {!result.satisfiable && repair && (
        <div style={{ marginBottom: 16 }}>
          <RepairPanel
            events={events}
            constraints={constraints}
            observations={observations}
            repair={repair}
            baseISO={effectiveResult.baseISO}
            previewIndex={previewIndex}
            onPreview={previewRepair}
            onExitPreview={exitPreview}
            onApply={applyRepair}
          />
        </div>
      )}

      {/* 差分图 */}
      <div className="panel graph-panel" style={{ marginBottom: 16 }}>
        <h3>
          差分约束图
          <span className="count">
            边标签 w 表示 t终点 − t起点 ≤ w（分钟）· 琥珀色虚线为观测边，中心 t₀ 为时间原点
          </span>
        </h3>
        <GraphView
          events={events}
          constraints={effectiveConstraints}
          observations={observations}
          cycleNodes={cycleNodeIdx}
          cycleEdgeKeys={cycleEdgeKeys}
          traceNodes={traceNodeIdx}
          traceEdgeKeys={traceEdgeKeys}
        />
      </div>

      {/* 编辑器 */}
      <div className="grid-2">
        <EventEditor
          events={events}
          cycleEventIds={cycleEventIds}
          onAdd={addEvent}
          onRemove={removeEvent}
          onRename={renameEvent}
        />
        <ConstraintEditor
          events={events}
          constraints={effectiveConstraints}
          cycleConstraintIds={cycleConstraintIds}
          traceConstraintIds={traceConstraintIds}
          previewOffIds={previewOffIds}
          audit={audit}
          onAdd={addConstraint}
          onRemove={removeConstraint}
          onUpdate={updateConstraint}
        />
      </div>

      {/* 绝对时间观测（全宽） */}
      <div style={{ marginTop: 16 }}>
        <ObservationEditor
          events={events}
          observations={observations}
          cycleObservationIds={cycleObservationIds}
          traceObservationIds={traceObservationIds}
          onAdd={addObservation}
          onRemove={removeObservation}
          onUpdate={updateObservation}
        />
      </div>

      {/* 批量证词导入（全宽）：粘贴 DSL → 只读预览 → 确认后一次性合并 */}
      <div style={{ marginTop: 16 }}>
        <BatchImportPanel events={events} onImport={importBatch} />
      </div>

      {/* 案卷快照（全宽）：导出带格式版本的 JSON；导入先完整校验，确认后整包替换 */}
      <div style={{ marginTop: 16 }}>
        <SnapshotPanel state={state} onApply={applySnapshot} />
      </div>

      {/* 时间窗（预览时展示修复后的窗口；正常可满足时展示当前窗口） */}
      {effectiveResult.satisfiable && (
        <div style={{ marginTop: 16 }}>
          <WindowsTable
            events={events}
            windows={effectiveResult.windows}
            cycleEventIds={cycleEventIds}
            baseISO={effectiveResult.baseISO}
            observations={observations}
            trace={trace}
            constraints={effectiveConstraints}
            onTrace={requestTrace}
            onCloseTrace={() => setTraceReq(null)}
          />
        </div>
      )}

      {/* 分层最小偏差排程：期望时刻与优先级填写 + 高→中→低字典序搜索得到的可行排程 */}
      <div style={{ marginTop: 16 }}>
        <SchedulePanel
          events={events}
          baseISO={effectiveResult.baseISO}
          desiredTimes={desiredTimes}
          desiredPriorities={desiredPriorities}
          satisfiable={effectiveResult.satisfiable}
          hasObservations={hasObservations}
          windows={effectiveResult.windows}
          schedule={schedule}
          onDesiredChange={setDesiredTime}
          onPriorityChange={setDesiredPriority}
        />
      </div>

      <div className="footer-note">
        事件、约束、观测、期望时刻与优先级均自动保存在浏览器 localStorage，刷新不丢失 ·
        旧版单一锚点存档会自动迁移为一条精确观测 ·
        停用某条相对约束可即时验证“去掉该证词后矛盾是否消除” ·
        观测的新增、编辑、删除与其他任何编辑一样实时重算并持久化；观测作为事实记录不参与修复停用 ·
        批量证词导入先解析为只读预览，任何一行有错都禁止写入，确认后一次性合并（不覆盖现有数据）·
        案卷快照可导出为带格式版本的 JSON，导入时先完整校验、任一错误禁止应用，确认后整包替换当前案卷 ·
        冗余证词审计实时重算且只读，不改写约束与本地存档
      </div>
    </div>
  )
}
