import { useMemo, useRef, useState } from 'react'
import type { AppState } from '../types'
import { analyze } from '../lib/graph'
import {
  serializeSnapshot,
  snapshotFileName,
  validateSnapshot,
  SNAPSHOT_VERSION,
  type SnapshotValidation,
} from '../lib/snapshot'

interface Props {
  /** 当前案卷（导出快照的内容来源） */
  state: AppState
  /** 校验通过并确认后整包替换当前案卷（调用方负责实时重算与本地持久化） */
  onApply: (next: AppState) => void
}

const FORMAT_EXAMPLE = `{
  "app": "temporal-constraint-checker",
  "kind": "case-snapshot",
  "version": ${SNAPSHOT_VERSION},
  "exportedAt": "2026-09-26T08:00:00.000Z",
  "data": {
    "events": [{ "id": "ev_1", "name": "碰撞发生", "note": "可选备注" }],
    "constraints": [
      { "id": "ct_1", "aId": "ev_1", "bId": "ev_2", "relation": "earlier", "min": 5, "max": 30, "enabled": true }
    ],
    "observations": [
      { "id": "obs_1", "eventId": "ev_1", "start": "2026-01-01T08:00", "end": "2026-01-01T08:00" }
    ],
    "desiredTimes": { "ev_1": "2026-01-01T08:10" },
    "desiredPriorities": { "ev_1": "high" }
  }
}`

/**
 * 案卷快照面板：
 * - 「下载快照」把当前事件、约束、观测、期望时刻与优先级导出为带格式版本的 JSON 文件；
 * - 「选择快照文件」后先在内存中完整校验（字段类型、各类 id 唯一、引用指向现存事件、
 *   非负整数分钟且 min ≤ max、yyyy-MM-ddTHH:mm 时刻、观测起点不晚于终点、
 *   优先级仅 高/中/低 且键属于现存事件），逐项列出错误并给出记录数预览；
 *   任一错误都禁止应用，绝不静默丢弃记录；
 * - 确认后整包替换当前案卷（接入现有实时分析与 localStorage 持久化）；
 *   取消或校验失败都不会改变当前数据；
 * - 格式合法但时序矛盾的快照允许导入，导入后由现有矛盾分析展示。
 */
export default function SnapshotPanel({ state, onApply }: Props) {
  const [fileName, setFileName] = useState<string | null>(null)
  const [validation, setValidation] = useState<SnapshotValidation | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  // 变更 key 以重置文件输入框（取消 / 应用后允许再次选择同一文件）
  const [fileKey, setFileKey] = useState(0)
  // 读取序号：防止连续选择 / 取消时，后完成的异步读取覆盖最新选择
  const readSeq = useRef(0)

  // 快照格式合法时顺带做一次现有矛盾分析：仅作提示，不阻止导入
  const contradiction = useMemo(() => {
    if (!validation?.ok || !validation.state) return false
    const s = validation.state
    return !analyze(s.events, s.constraints, s.observations).satisfiable
  }, [validation])

  const resetSelection = () => {
    readSeq.current += 1
    setFileName(null)
    setValidation(null)
    setFileKey((k) => k + 1)
  }

  /** 下载当前案卷为带格式版本的 JSON 快照 */
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

  /** 选择快照文件：读入文本后立即在内存中完整校验（不改动任何现有数据） */
  const pickFile = (files: FileList | null) => {
    const file = files?.[0]
    setDoneMsg(null)
    if (!file) {
      resetSelection()
      return
    }
    setFileName(file.name)
    const seq = ++readSeq.current
    file.text().then(
      (text) => {
        if (seq === readSeq.current) setValidation(validateSnapshot(text))
      },
      () => {
        if (seq !== readSeq.current) return
        setValidation({
          ok: false,
          errors: [{ path: '$', message: '文件读取失败，请重试' }],
          state: null,
          counts: null,
        })
      },
    )
  }

  /** 确认应用：整包替换当前案卷（state 变更即触发实时重算并写入 localStorage） */
  const confirm = () => {
    if (!validation?.ok || !validation.state) return
    const c = validation.counts
    onApply(validation.state)
    resetSelection()
    setDoneMsg(
      `已用快照整包替换当前案卷：${c?.events ?? 0} 个事件、${c?.constraints ?? 0} 条约束、` +
        `${c?.observations ?? 0} 条观测、${c?.desiredTimes ?? 0} 条期望时刻、${c?.desiredPriorities ?? 0} 条优先级。`,
    )
  }

  const counts = validation?.counts ?? null
  const errorCount = validation?.errors.length ?? 0

  return (
    <div className="panel snapshot-panel">
      <h3>
        案卷快照
        <span className="count">
          下载 / 导入带格式版本的 JSON · 导入前完整校验，确认后整包替换当前案卷
        </span>
      </h3>

      <details className="dsl-help">
        <summary>快照格式说明与示例</summary>
        <div className="dsl-grammar">
          <div>
            快照为带格式版本（<code>version: {SNAPSHOT_VERSION}</code>）的 JSON 文件，<code>data</code>{' '}
            内含事件、约束、观测、期望时刻与优先级五部分。
          </div>
          <div className="dsl-note">
            导入校验：各类 id 唯一；约束 / 观测 / 期望 / 优先级的引用与映射键必须指向快照内现存事件；
            约束分钟数为非负整数且 min ≤ max；观测与期望时刻为有效 yyyy-MM-ddTHH:mm；观测起点不晚于终点；
            优先级仅 high / medium / low。任一错误都禁止应用；时序矛盾不属于格式错误，可正常导入。
          </div>
        </div>
        <pre className="dsl-example">{FORMAT_EXAMPLE}</pre>
      </details>

      <div className="snapshot-actions">
        <button className="primary" onClick={download} title="把当前案卷导出为带格式版本的 JSON 文件">
          下载快照
        </button>
        <input
          key={fileKey}
          type="file"
          accept="application/json,.json"
          aria-label="选择快照文件"
          onChange={(e) => pickFile(e.target.files)}
        />
        {fileName && (
          <button
            className="danger-ghost"
            onClick={() => {
              resetSelection()
              setDoneMsg(null)
            }}
          >
            取消
          </button>
        )}
      </div>

      {doneMsg && <div className="dsl-done">✅ {doneMsg}</div>}

      {validation && (
        <div className="dsl-preview">
          <div className="dsl-summary">
            已选择快照文件「{fileName}」
            {counts && (
              <>
                ：共 {counts.events} 个事件、{counts.constraints} 条约束（启用 {counts.enabledConstraints} 条）、
                {counts.observations} 条观测、{counts.desiredTimes} 条期望时刻、{counts.desiredPriorities} 条优先级
              </>
            )}
            {errorCount > 0 ? (
              <span className="dsl-err-text">　⛔ {errorCount} 个错误，禁止应用</span>
            ) : (
              <span className="dsl-ok-text">　✅ 校验通过，可确认应用</span>
            )}
          </div>

          {errorCount > 0 && (
            <ul className="dsl-error-list">
              {validation.errors.map((e, i) => (
                <li key={i}>
                  <span className="snapshot-err-path">{e.path}</span>：{e.message}
                </li>
              ))}
            </ul>
          )}

          {validation.ok && contradiction && (
            <div className="snapshot-warn">
              ⚠️ 该快照格式合法，但观测与约束存在时序矛盾；仍可导入，导入后将展示现有的矛盾链与修复建议。
            </div>
          )}

          <div className="add-row">
            <button
              className="primary"
              onClick={confirm}
              disabled={!validation.ok}
              title={
                validation.ok
                  ? '整包替换当前案卷并保存到本地存储'
                  : '存在校验错误，修正快照文件后才能应用'
              }
            >
              确认应用（整包替换当前案卷）
            </button>
            <button className="danger-ghost" onClick={resetSelection}>
              取消
            </button>
            {!validation.ok && (
              <span className="dsl-note">任一错误都会阻止应用；当前案卷数据保持不变。</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
