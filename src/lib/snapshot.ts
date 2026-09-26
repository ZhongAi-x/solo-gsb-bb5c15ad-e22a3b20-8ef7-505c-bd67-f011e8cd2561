/**
 * 案卷快照：把当前案卷（事件、约束、观测、期望时刻与优先级层级）整体导出为
 * 带格式版本的 JSON 文件，以及把快照文件读入内存完整校验后整包导入。
 *
 * 与 localStorage 迁移（逐条清洗、丢弃无效记录）不同，快照导入**不静默丢弃任何记录**：
 * 校验在内存中一次完成并逐项报告全部错误，存在任一错误时禁止应用；
 * 全部通过后才重建干净状态，由调用方整包替换当前案卷。
 *
 * 校验仅检查格式与引用完整性（字段类型、ID 唯一、引用存在、区间合法、
 * 时间格式、优先级取值），**不做时序可满足性判断**：格式合法但观测与约束
 * 互相矛盾的快照允许导入，导入后由现有实时分析立即给出矛盾链与修复建议。
 */
import type { AppState, Constraint, PriorityLevel, TimeObservation, TEvent } from '../types'

/** 当前支持的快照格式版本 */
export const SNAPSHOT_FORMAT_VERSION = 1

/** 快照文件顶层结构：AppState 五个字段 + 格式版本号 */
export interface SnapshotFile extends AppState {
  formatVersion: number
}

/** 一条定位到 JSON 路径的校验错误 */
export interface SnapshotError {
  /** 出错位置，如 events[2].name / constraints[0].min / desiredTimes["ev_1"] */
  path: string
  message: string
}

/** 快照内各类记录的数量预览（无论校验是否通过都尽量统计） */
export interface SnapshotCounts {
  events: number
  constraints: number
  observations: number
  desiredTimes: number
  desiredPriorities: number
}

export interface SnapshotValidation {
  /** 全部校验错误（逐项列出；为空表示校验通过） */
  errors: SnapshotError[]
  /** 记录数预览 */
  counts: SnapshotCounts
  /** 校验通过时可直接整包替换当前案卷的干净状态；存在任何错误时为 null */
  state: AppState | null
}

// ==================== 导出 ====================

/** 由当前案卷构造快照对象（拷贝，不共享内部数组/对象） */
export function buildSnapshot(state: AppState): SnapshotFile {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    events: state.events.map((e) =>
      e.note === undefined ? { id: e.id, name: e.name } : { id: e.id, name: e.name, note: e.note },
    ),
    constraints: state.constraints.map((c) => ({ ...c })),
    observations: state.observations.map((o) => ({ ...o })),
    desiredTimes: { ...state.desiredTimes },
    desiredPriorities: { ...state.desiredPriorities },
  }
}

/** 序列化为带缩进的格式化 JSON（下载内容） */
export function serializeSnapshot(state: AppState): string {
  return `${JSON.stringify(buildSnapshot(state), null, 2)}\n`
}

/** 下载文件名：case-snapshot-yyyyMMdd-HHmm.json（本地时间） */
export function snapshotFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `case-snapshot-${stamp}.json`
}

// ==================== 校验 ====================

const DATETIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** 严格校验 yyyy-MM-ddTHH:mm（含大小月与闰年；不接受空格分隔、秒或时区后缀） */
export function isValidDateTimeLocal(s: string): boolean {
  const m = DATETIME_LOCAL_RE.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  if (mo < 1 || mo > 12) return false
  if (h > 23 || mi > 59) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return d >= 1 && d <= days[mo - 1]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const PRIORITY_LEVELS: readonly PriorityLevel[] = ['high', 'medium', 'low']

/**
 * 完整校验快照文本（JSON 解析 → 结构 → 逐字段类型 → ID 唯一 → 引用存在 →
 * 区间与时间合法 → 优先级取值）。收集全部错误后一次性返回；
 * errors 非空时 state 为 null（禁止应用），调用方不得部分导入。
 */
export function validateSnapshot(text: string): SnapshotValidation {
  const errors: SnapshotError[] = []
  const counts: SnapshotCounts = {
    events: 0,
    constraints: 0,
    observations: 0,
    desiredTimes: 0,
    desiredPriorities: 0,
  }
  const fail = (path: string, message: string) => {
    errors.push({ path, message })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    fail('$', `JSON 解析失败：${(e as Error).message}`)
    return { errors, counts, state: null }
  }
  if (!isPlainObject(parsed)) {
    fail(
      '$',
      '快照必须是 JSON 对象（包含 formatVersion 与 events / constraints / observations / desiredTimes / desiredPriorities 字段）',
    )
    return { errors, counts, state: null }
  }

  // —— 格式版本 ——
  if (typeof parsed.formatVersion !== 'number') {
    fail('formatVersion', '缺少格式版本号 formatVersion（数值）；请使用本应用导出的快照文件')
  } else if (parsed.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    fail(
      'formatVersion',
      `不支持的格式版本 ${parsed.formatVersion}（当前应用支持版本 ${SNAPSHOT_FORMAT_VERSION}）`,
    )
  }

  // —— 事件：字段类型 + id 唯一 ——
  if (!Array.isArray(parsed.events)) {
    fail('events', 'events 必须是事件数组')
  }
  const eventList: unknown[] = Array.isArray(parsed.events) ? parsed.events : []
  counts.events = eventList.length
  const eventIds = new Set<string>()
  eventList.forEach((e, i) => {
    const path = `events[${i}]`
    if (!isPlainObject(e)) {
      fail(path, '事件必须是对象（含 id、name，可选 note）')
      return
    }
    if (typeof e.id !== 'string' || e.id === '') {
      fail(`${path}.id`, '事件 id 必须是非空字符串')
    } else {
      if (eventIds.has(e.id)) fail(`${path}.id`, `事件 id 重复："${e.id}"`)
      eventIds.add(e.id)
    }
    if (typeof e.name !== 'string') fail(`${path}.name`, '事件名称 name 必须是字符串')
    if (e.note !== undefined && typeof e.note !== 'string') {
      fail(`${path}.note`, '事件备注 note 必须是字符串（或省略该字段）')
    }
  })

  // —— 约束：字段类型 + id 唯一 + 引用存在 + 分钟数为非负整数且 min ≤ max ——
  if (!Array.isArray(parsed.constraints)) {
    fail('constraints', 'constraints 必须是约束数组')
  }
  const constraintList: unknown[] = Array.isArray(parsed.constraints) ? parsed.constraints : []
  counts.constraints = constraintList.length
  const constraintIds = new Set<string>()
  constraintList.forEach((c, i) => {
    const path = `constraints[${i}]`
    if (!isPlainObject(c)) {
      fail(path, '约束必须是对象（含 id、aId、bId、relation、min、max、enabled）')
      return
    }
    if (typeof c.id !== 'string' || c.id === '') {
      fail(`${path}.id`, '约束 id 必须是非空字符串')
    } else {
      if (constraintIds.has(c.id)) fail(`${path}.id`, `约束 id 重复："${c.id}"`)
      constraintIds.add(c.id)
    }
    for (const key of ['aId', 'bId'] as const) {
      const v = c[key]
      if (typeof v !== 'string' || v === '') {
        fail(`${path}.${key}`, `约束的 ${key} 必须是非空字符串（事件 id）`)
      } else if (!eventIds.has(v)) {
        fail(`${path}.${key}`, `引用了不存在的事件 id "${v}"`)
      }
    }
    if (c.relation !== 'earlier' && c.relation !== 'later') {
      fail(`${path}.relation`, 'relation 必须是 "earlier"（早于）或 "later"（晚于）')
    }
    const minOk = typeof c.min === 'number' && Number.isInteger(c.min) && c.min >= 0
    const maxOk = typeof c.max === 'number' && Number.isInteger(c.max) && c.max >= 0
    if (!minOk) fail(`${path}.min`, `分钟下界 min 必须是非负整数（当前为 ${JSON.stringify(c.min)}）`)
    if (!maxOk) fail(`${path}.max`, `分钟上界 max 必须是非负整数（当前为 ${JSON.stringify(c.max)}）`)
    if (minOk && maxOk && (c.min as number) > (c.max as number)) {
      fail(`${path}.min`, `分钟下界 ${c.min} 大于上界 ${c.max}`)
    }
    if (typeof c.enabled !== 'boolean') fail(`${path}.enabled`, 'enabled 必须是布尔值')
  })

  // —— 观测：字段类型 + id 唯一 + 引用存在 + 时刻为有效 yyyy-MM-ddTHH:mm 且 start ≤ end ——
  if (!Array.isArray(parsed.observations)) {
    fail('observations', 'observations 必须是观测数组')
  }
  const observationList: unknown[] = Array.isArray(parsed.observations) ? parsed.observations : []
  counts.observations = observationList.length
  const observationIds = new Set<string>()
  observationList.forEach((o, i) => {
    const path = `observations[${i}]`
    if (!isPlainObject(o)) {
      fail(path, '观测必须是对象（含 id、eventId、start、end）')
      return
    }
    if (typeof o.id !== 'string' || o.id === '') {
      fail(`${path}.id`, '观测 id 必须是非空字符串')
    } else {
      if (observationIds.has(o.id)) fail(`${path}.id`, `观测 id 重复："${o.id}"`)
      observationIds.add(o.id)
    }
    if (typeof o.eventId !== 'string' || o.eventId === '') {
      fail(`${path}.eventId`, '观测的 eventId 必须是非空字符串（事件 id）')
    } else if (!eventIds.has(o.eventId)) {
      fail(`${path}.eventId`, `引用了不存在的事件 id "${o.eventId}"`)
    }
    const startOk = typeof o.start === 'string' && isValidDateTimeLocal(o.start)
    const endOk = typeof o.end === 'string' && isValidDateTimeLocal(o.end)
    if (!startOk) {
      fail(`${path}.start`, `观测起点必须是有效的 yyyy-MM-ddTHH:mm 时刻（当前为 ${JSON.stringify(o.start)}）`)
    }
    if (!endOk) {
      fail(`${path}.end`, `观测终点必须是有效的 yyyy-MM-ddTHH:mm 时刻（当前为 ${JSON.stringify(o.end)}）`)
    }
    if (startOk && endOk && new Date(o.end as string).getTime() < new Date(o.start as string).getTime()) {
      fail(`${path}.end`, `观测终点 ${o.end} 早于起点 ${o.start}`)
    }
  })

  // —— 期望时刻：映射键属于现存事件，值为有效 yyyy-MM-ddTHH:mm ——
  if (!isPlainObject(parsed.desiredTimes)) {
    fail('desiredTimes', 'desiredTimes 必须是对象（事件 id -> yyyy-MM-ddTHH:mm）')
  }
  const desiredEntries: [string, unknown][] = isPlainObject(parsed.desiredTimes)
    ? Object.entries(parsed.desiredTimes)
    : []
  counts.desiredTimes = desiredEntries.length
  for (const [id, v] of desiredEntries) {
    const path = `desiredTimes[${JSON.stringify(id)}]`
    if (!eventIds.has(id)) fail(path, `期望时刻的映射键引用了不存在的事件 id "${id}"`)
    if (typeof v !== 'string' || !isValidDateTimeLocal(v)) {
      fail(path, `期望时刻必须是有效的 yyyy-MM-ddTHH:mm（当前为 ${JSON.stringify(v)}）`)
    }
  }

  // —— 优先级：映射键属于现存事件，值仅 高/中/低 ——
  if (!isPlainObject(parsed.desiredPriorities)) {
    fail('desiredPriorities', 'desiredPriorities 必须是对象（事件 id -> "high" / "medium" / "low"）')
  }
  const priorityEntries: [string, unknown][] = isPlainObject(parsed.desiredPriorities)
    ? Object.entries(parsed.desiredPriorities)
    : []
  counts.desiredPriorities = priorityEntries.length
  for (const [id, v] of priorityEntries) {
    const path = `desiredPriorities[${JSON.stringify(id)}]`
    if (!eventIds.has(id)) fail(path, `优先级的映射键引用了不存在的事件 id "${id}"`)
    if (typeof v !== 'string' || !PRIORITY_LEVELS.includes(v as PriorityLevel)) {
      fail(path, `优先级必须是 "high" / "medium" / "low" 之一（当前为 ${JSON.stringify(v)}）`)
    }
  }

  if (errors.length > 0) return { errors, counts, state: null }

  // 全部校验通过：重建只含已知字段的干净状态（整包替换用，不共享快照内部对象）
  const state: AppState = {
    events: eventList.map((e) => {
      const o = e as { id: string; name: string; note?: string }
      const ev: TEvent = { id: o.id, name: o.name }
      if (o.note !== undefined) ev.note = o.note
      return ev
    }),
    constraints: constraintList.map((c) => {
      const o = c as Constraint
      return {
        id: o.id,
        aId: o.aId,
        bId: o.bId,
        relation: o.relation,
        min: o.min,
        max: o.max,
        enabled: o.enabled,
      }
    }),
    observations: observationList.map((o) => {
      const v = o as TimeObservation
      return { id: v.id, eventId: v.eventId, start: v.start, end: v.end }
    }),
    desiredTimes: { ...(parsed.desiredTimes as Record<string, string>) },
    desiredPriorities: { ...(parsed.desiredPriorities as Record<string, PriorityLevel>) },
  }
  return { errors, counts, state }
}
