import { useRef, useState } from 'react'
import type { AppState } from '../types'
import {
  serializeSnapshot,
  snapshotFileName,
  validateSnapshot,
  type SnapshotCounts,
  type SnapshotValidation,
} from '../lib/snapshot'

interface Props {
  /** 当前案卷（导出内容来源） */
  state: AppState
  /** 确认应用：快照已通过全部校验，调用方负责整包替换当前案卷并持久化 */
  onApply: (next: AppState) => void
}

const FORMAT_EXAMPLE = `{
  "formatVersion": 1,
  "events": [
    { "id": "ev_1", "name": "碰撞发生", "note": "可选备注" },
    { "id": "ev_2", "name": "救护车到达" }
  ],
  "constraints": [
    { "id": "ct_1", "aId": "ev_1", "bId": "ev_2", "relation": "earlier", "min": 8, "max": 25, "enabled": true }
  ],
  "observations": [
    { "id": "obs_1", "eventId": "ev_2", "start": "2026-01-01T08:20", "end": "2026-01-01T08:35" }
  ],
  "desiredTimes": { "ev_2": "2026-01-01T08:30" },
  "desiredPriorities": { "ev_2": "high" }
}`

/** 记录数预览徽标行 */
function Counts({ counts }: { counts: SnapshotCounts }) {
  return (
    <span className="snapshot-counts">
      <span className="badge anchor">事件 {counts.events}</span>
      <span className="badge interval">约束 {counts.constraints}</span>
      <span className="badge observed">观测 {counts.observations}</span>
      <span className="badge prio-medium">期望时刻 {counts.desiredTimes}</span>
      <span className="badge prio-high">优先级 {counts.desiredPriorities}</span>
    </span>
  )
}

/**
 * 案卷快照面板：
 * - 导出：把当前事件、约束、观测、期望时刻与优先级下载为带格式版本的格式化 JSON；
 * - 导入：选择快照文件后先在内存中完整校验（字段类型、各类 ID 唯一、引用指向现存
 *   事件、分钟数为非负整数且 min ≤ max、时刻为有效 yyyy-MM-ddTHH:mm、观测起点不晚于
 *   终点、优先级仅高/中/低且映射键属于现存事件），逐项列出错误与记录数预览；
 *   任一错误都禁止应用（不静默丢弃任何记录），确认后整包替换当前案卷，
 *   取消或校验失败都不改动当前数据。格式合法但时序矛盾的快照允许导入，
 *   导入后由现有实时分析立即显示矛盾链。
 */
export default function SnapshotPanel({ state, onApply }: Props) {
  const [fileName, setFileName] = useState<string | null>(null)
  const [validation, setValidation] = useState<SnapshotValidation | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // —— 导出：当前案卷 → 带格式版本的格式化 JSON 文件 ——
  const download = () => {
    const blob = new Blob([serializeSnapshot(state)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = snapshotFileName()
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // —— 选择文件：读入内存并立即完整校验（只读校验，不改动任何现有数据）——
  const pick = async (file: File | null) => {
    setDoneMsg(null)
    if (!file) {
      setFileName(null)
      setValidation(null)
      return
    }
    const text = await file.text()
    setFileName(file.name)
    setValidation(validateSnapshot(text))
  }

  // 取消：仅丢弃内存中的快照与校验结果，当前案卷保持不变
  const cancel = () => {
    setFileName(null)
    setValidation(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  // 确认应用：仅在全部校验通过时可用；整包替换当前案卷（state 变更即实时重算并持久化）
  const confirm = () => {
    if (!validation?.state) return
    const counts = validation.counts
    onApply(validation.state)
    cancel()
    setDoneMsg(
      `已用快照整包替换当前案卷：${counts.events} 个事件、${counts.constraints} 条约束、` +
        `${counts.observations} 条观测、${counts.desiredTimes} 条期望时刻、${counts.desiredPriorities} 条优先级。`,
    )
  }

  const errors = validation?.errors ?? []
  const canApply = !!validation && errors.length === 0 && validation.state !== null

  return (
    <div className="panel snapshot-panel">
      <h3>
        案卷快照（导出 / 导入）
        <span className="count">带格式版本的 JSON · 导入先完整校验 · 确认后整包替换</span>
      </h3>

      {/* 导出 */}
      <div className="snapshot-row">
        <div className="snapshot-export-desc">
          导出当前案卷：
          <Counts
            counts={{
              events: state.events.length,
              constraints: state.constraints.length,
              observations: state.observations.length,
              desiredTimes: Object.keys(state.desiredTimes).length,
              desiredPriorities: Object.keys(state.desiredPriorities).length,
            }}
          />
        </div>
        <button onClick={download} title="下载带格式版本（formatVersion）的格式化 JSON 快照文件">
          下载快照 JSON
        </button>
      </div>

      {/* 导入 */}
      <div className="snapshot-import">
        <div className="snapshot-import-title">从快照文件导入（.json）</div>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => void pick(e.target.files?.[0] ?? null)}
          aria-label="选择快照 JSON 文件"
        />
        <div className="dsl-note">
          选择后先在内存中完整校验并给出记录数预览；确认后<strong>整包替换</strong>当前案卷并自动保存，
          取消或校验失败都不会改动当前数据。
        </div>
      </div>

      {doneMsg && <div className="dsl-done">✅ {doneMsg}</div>}

      {validation && (
        <div className="dsl-preview">
          <div className="dsl-summary">
            「{fileName}」 <Counts counts={validation.counts} />
            {errors.length > 0 ? (
              <span className="dsl-err-text">　⛔ {errors.length} 个错误，禁止应用</span>
            ) : (
              <span className="dsl-ok-text">　✅ 校验通过，可确认应用</span>
            )}
          </div>

          {errors.length > 0 && (
            <ul className="dsl-error-list">
              {errors.map((e, i) => (
                <li key={i}>
                  <code className="snapshot-err-path">{e.path}</code>：{e.message}
                </li>
              ))}
            </ul>
          )}

          {errors.length === 0 && (
            <div className="dsl-note" style={{ marginBottom: 8 }}>
              校验仅检查格式与引用完整性；若快照内观测与约束互相矛盾，导入后将立即显示现有的矛盾链分析与修复建议。
            </div>
          )}

          <div className="add-row">
            <button
              className="primary"
              onClick={confirm}
              disabled={!canApply}
              title={
                errors.length > 0
                  ? '存在错误，修正快照文件后才能应用（不会逐条丢弃后部分导入）'
                  : '整包替换当前案卷并写入本地存储'
              }
            >
              确认应用（整包替换当前案卷）
            </button>
            <button className="danger-ghost" onClick={cancel}>
              取消
            </button>
            {errors.length > 0 && (
              <span className="dsl-note">任一错误都会阻止应用；不会静默丢弃任何记录。</span>
            )}
          </div>
        </div>
      )}

      <details className="dsl-help" style={{ marginTop: 10 }}>
        <summary>快照 JSON 格式说明与示例</summary>
        <div className="dsl-grammar">
          <div>
            <code>formatVersion</code> —— 格式版本号（数值，当前为 1）；缺失或版本不符拒绝导入
          </div>
          <div>
            <code>events</code> —— 事件数组：id（非空、互不重复）、name（字符串）、note（可选字符串）
          </div>
          <div>
            <code>constraints</code> —— 约束数组：id 唯一；aId / bId 必须指向 events 中的事件；
            relation 为 "earlier" / "later"；min、max 为非负整数且 min ≤ max；enabled 为布尔值
          </div>
          <div>
            <code>observations</code> —— 观测数组：id 唯一；eventId 必须指向 events 中的事件；
            start / end 为有效 yyyy-MM-ddTHH:mm 且起点不晚于终点
          </div>
          <div>
            <code>desiredTimes</code> —— 对象：事件 id → 有效 yyyy-MM-ddTHH:mm 期望时刻
          </div>
          <div>
            <code>desiredPriorities</code> —— 对象：事件 id → "high" / "medium" / "low"
          </div>
          <div className="dsl-note">
            任一字段错误都会逐项列出并禁止应用；时序是否矛盾不属于格式校验，矛盾快照导入后直接显示矛盾分析。
          </div>
        </div>
        <pre className="dsl-example">{FORMAT_EXAMPLE}</pre>
      </details>
    </div>
  )
}
