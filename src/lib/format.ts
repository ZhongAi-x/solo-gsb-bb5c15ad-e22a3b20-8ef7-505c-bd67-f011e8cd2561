/**
 * 时间与约束的展示辅助函数
 */

/** 把分钟偏移格式化为 “+12 分钟 / -5 分钟 / 0” */
export function formatOffset(min: number | null): string {
  if (min === null) return '—'
  if (min === 0) return '0（同时）'
  const sign = min > 0 ? '+' : '−'
  return `${sign}${Math.abs(min)} 分钟`
}

/** 偏移的自然语言描述（相对时间原点 / 最早观测） */
export function offsetRelation(min: number | null): string {
  if (min === null) return '无界'
  if (min === 0) return '与时间原点同时'
  return min > 0 ? `晚于基准 ${min} 分钟` : `早于基准 ${-min} 分钟`
}

/** 在给定基准时间上叠加分钟偏移，返回 “MM-DD HH:mm” 形式（基准/偏移无界时返回 —） */
export function formatAt(baseISO: string | null, offsetMin: number | null): string {
  if (baseISO === null || offsetMin === null) return '—'
  const t = new Date(baseISO)
  if (Number.isNaN(t.getTime())) return '—'
  t.setMinutes(t.getMinutes() + offsetMin)
  return formatDateTime(t)
}

/** 完整日期时间（基准时刻展示用） */
export function formatFullDateTime(baseISO: string | null): string {
  if (baseISO === null) return '（无观测）'
  const t = new Date(baseISO)
  if (Number.isNaN(t.getTime())) return '（无效时间）'
  return formatDateTime(t, true)
}

function formatDateTime(t: Date, withYear = false): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = withYear ? `${t.getFullYear()}-` : ''
  return `${y}${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** 约束的自然语言：事件 A 比事件 B 早/晚 x~y 分钟 */
export function describeConstraint(
  c: { aId: string; bId: string; relation: 'earlier' | 'later'; min: number; max: number },
  nameOf: (id: string) => string,
): string {
  const a = nameOf(c.aId) || '（已删除事件）'
  const b = nameOf(c.bId) || '（已删除事件）'
  const rel = c.relation === 'earlier' ? '早于' : '晚于'
  const range = c.min === c.max ? `${c.min}` : `${c.min}~${c.max}`
  return `「${a}」${rel}「${b}」 ${range} 分钟`
}

/** 观测区间的自然语言：事件 发生于 HH:mm ~ HH:mm（精确时刻只显示一个时刻） */
export function describeObservation(
  o: { eventId: string; start: string; end: string },
  nameOf: (id: string) => string,
): string {
  const name = nameOf(o.eventId) || '（已删除事件）'
  const s = formatFullDateTime(o.start)
  if (!o.end || o.end === o.start) return `「${name}」发生于 ${s}（精确时刻）`
  return `「${name}」发生于 ${s} ~ ${formatFullDateTime(o.end)}`
}
