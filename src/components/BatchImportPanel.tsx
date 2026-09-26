import { useMemo, useState, type ReactNode } from 'react'
import type { TEvent } from '../types'
import {
  buildImportEntities,
  parseDsl,
  type DslImportEntities,
  type DslLineResult,
  type DslParseResult,
} from '../lib/dsl'
import { formatFullDateTime } from '../lib/format'

interface Props {
  events: TEvent[]
  /** 确认导入：实体已生成，调用方负责一次性合并并持久化 */
  onImport: (entities: DslImportEntities) => void
}

const DSL_EXAMPLE = `# 批量证词导入示例（# 开头为注释，空行忽略）
EVENT "碰撞发生" | "路口监控缺失，仅证人证词"
EVENT "救护车到达" | "调度台记录"
REL "碰撞发生" earlier "救护车到达" 8..25
OBS "救护车到达" 2026-01-01T08:20..2026-01-01T08:35`

const KIND_LABEL: Record<string, string> = {
  event: '事件',
  constraint: '约束',
  observation: '观测',
}

/** 引用目标徽标：现有事件 / 本批新增 */
function RefBadge({ target }: { target: { name: string; existing: boolean } | undefined }) {
  if (!target) return null
  return (
    <span className={`badge ${target.existing ? 'anchor' : 'observed'}`} title={target.name}>
      {target.existing ? '现有事件' : '本批新增'}
    </span>
  )
}

/** 单条语句的只读预览描述 */
function describeLine(ln: DslLineResult): ReactNode {
  const st = ln.statement
  if (!st) return <span className="dsl-err-text">无法解析</span>
  if (st.kind === 'event') {
    return (
      <>
        新增事件「{st.name}」
        {st.note && <span className="dsl-note">备注：{st.note}</span>}
      </>
    )
  }
  if (st.kind === 'constraint') {
    return (
      <>
        新增约束：「{st.aName}」<RefBadge target={ln.targets.a} /> {st.relation === 'earlier' ? '早于' : '晚于'}「
        {st.bName}」<RefBadge target={ln.targets.b} /> {st.min === st.max ? st.min : `${st.min}~${st.max}`} 分钟
      </>
    )
  }
  return (
    <>
      新增观测：「{st.eventName}」<RefBadge target={ln.targets.event} /> 发生于 {formatFullDateTime(st.start)}
      {st.end === st.start ? '（精确时刻）' : ` ~ ${formatFullDateTime(st.end)}`}
    </>
  )
}

/**
 * 批量证词导入面板：粘贴多行 DSL（EVENT / REL / OBS），实时解析为只读预览，
 * 逐行列出将新增的事件、约束与观测；任何一行存在错误都禁止写入，
 * 确认无误后一次性合并进现有数据并持久化（不覆盖现有数据）。
 */
export default function BatchImportPanel({ events, onImport }: Props) {
  const [text, setText] = useState('')
  const [doneMsg, setDoneMsg] = useState<string | null>(null)

  // 实时解析：任何编辑都重新完整解析（语法 + 语义两阶段）
  const parsed: DslParseResult | null = useMemo(
    () => (text.trim() === '' ? null : parseDsl(text, events)),
    [text, events],
  )

  const errorCount = parsed?.errors.length ?? 0
  const stmtCount = parsed?.lines.length ?? 0
  const canImport = !!parsed && errorCount === 0 && stmtCount > 0

  const confirm = () => {
    if (!parsed || !canImport) return
    const entities = buildImportEntities(parsed, events)
    onImport(entities)
    setText('')
    setDoneMsg(
      `已导入 ${entities.events.length} 个事件、${entities.constraints.length} 条约束、${entities.observations.length} 条观测（现有数据未被覆盖）。`,
    )
  }

  return (
    <div className="panel dsl-panel">
      <h3>
        批量证词导入
        <span className="count">
          每行一条 EVENT / REL / OBS · # 开头为注释 · 先解析为只读预览，确认后一次性合并
        </span>
      </h3>

      <details className="dsl-help">
        <summary>DSL 语法说明与示例</summary>
        <div className="dsl-grammar">
          <div>
            <code>EVENT "名称" | "备注"</code> —— 声明新事件（名称与备注均为 JSON 字符串，支持 \n、中 等转义）
          </div>
          <div>
            <code>REL "A" earlier|later "B" min..max</code> —— A 比 B 早/晚 min~max 分钟（非负整数，min ≤ max）
          </div>
          <div>
            <code>OBS "事件" start..end</code> —— 观测区间 yyyy-MM-ddTHH:mm..yyyy-MM-ddTHH:mm（两端相同即精确时刻）
          </div>
          <div className="dsl-note">
            事件名引用可指向现有事件或同批 EVENT 声明；重名 / 重复声明、引用不唯一、非法区间与时间格式都会定位到原始行。
          </div>
        </div>
        <pre className="dsl-example">{DSL_EXAMPLE}</pre>
      </details>

      <textarea
        className="dsl-textarea"
        rows={8}
        placeholder={DSL_EXAMPLE}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setDoneMsg(null)
        }}
        aria-label="批量导入 DSL 文本"
        spellCheck={false}
      />

      {doneMsg && <div className="dsl-done">✅ {doneMsg}</div>}

      {parsed && (
        <div className="dsl-preview">
          <div className="dsl-summary">
            共 {stmtCount} 条语句：将新增 {parsed.events.length} 个事件、{parsed.constraints.length} 条约束、
            {parsed.observations.length} 条观测
            {errorCount > 0 ? (
              <span className="dsl-err-text">　⛔ {errorCount} 个错误，禁止写入</span>
            ) : (
              <span className="dsl-ok-text">　✅ 解析通过，可确认导入</span>
            )}
          </div>

          {errorCount > 0 && (
            <ul className="dsl-error-list">
              {parsed.errors.map((e, i) => (
                <li key={i}>
                  第 {e.line} 行：{e.message}
                </li>
              ))}
            </ul>
          )}

          <table className="dsl-table">
            <thead>
              <tr>
                <th>行</th>
                <th>类型</th>
                <th>将新增的内容（只读预览）</th>
              </tr>
            </thead>
            <tbody>
              {parsed.lines.map((ln) => (
                <tr key={ln.line} className={ln.errors.length > 0 ? 'dsl-row-error' : ''}>
                  <td className="dsl-line-no">#{ln.line}</td>
                  <td>{ln.kind ? KIND_LABEL[ln.kind] : '—'}</td>
                  <td className="dsl-desc">
                    {describeLine(ln)}
                    {ln.errors.map((e, i) => (
                      <div className="dsl-err-text" key={i}>
                        ⛔ {e.message}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="add-row">
        <button
          className="primary"
          onClick={confirm}
          disabled={!canImport}
          title={
            !parsed || stmtCount === 0
              ? '请先粘贴 DSL 文本'
              : errorCount > 0
                ? '存在错误，修正后才能导入'
                : '一次性合并进现有数据并持久化'
          }
        >
          确认导入
        </button>
        <button className="danger-ghost" onClick={() => setText('')} disabled={text === ''}>
          清空文本
        </button>
        {parsed && errorCount > 0 && (
          <span className="dsl-note">任一错误都会阻止写入；修正后预览会实时更新。</span>
        )}
      </div>
    </div>
  )
}
