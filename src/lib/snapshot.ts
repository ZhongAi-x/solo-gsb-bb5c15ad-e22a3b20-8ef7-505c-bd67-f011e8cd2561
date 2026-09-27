/**
 * 案卷快照：导出 / 导入（整包替换）的序列化与完整校验
 *
 * 快照为带格式版本的 JSON（两个空格缩进，便于人工核对与版本管理）：
 *
 * ```json
 * {
 *   "app": "temporal-constraint-checker",
 *   "kind": "case-snapshot",
 *   "version": 1,
 *   "exportedAt": "2026-09-26T08:00:00.000Z",
 *   "data": {
 *     "events": [], "constraints": [], "observations": [],
 *     "desiredTimes": {}, "desiredPriorities": {}
 *   }
 * }
 * ```
 *
 * 导入前在内存中完整校验（纯函数，不触碰任何存储）：
 * - JSON 语法、格式标记 / 版本号与各字段类型；
 * - 事件 / 约束 / 观测各类 id 各自唯一；
 * - 约束与观测的事件引用、期望时刻与优先级映射的键都指向快照内现存事件；
 * - 约束分钟数为非负整数且下界不大于上界（min ≤ max）；
 * - 观测与期望时刻均为有效的 yyyy-MM-ddTHH:mm（含日历合法性，如拒绝 2 月 30 日）；
 * - 观测起点不晚于终点；
 * - 优先级仅允许 high / medium / low。
 *
 * 校验收集全部错误逐项报告，任一错误都禁止应用；绝不静默丢弃记录。
 * 时序是否矛盾不在校验范围内：格式合法但相互矛盾的快照允许导入，
 * 导入后由现有的实时矛盾分析展示。
 */
import type { AppState, Constraint, PriorityLevel, TimeObservation, TEvent } from '../types'
import { validDateTime } from './dsl'

export const SNAPSHOT_APP = 'temporal-constraint-checker'
export const SNAPSHOT_KIND = 'case-snapshot'
export const SNAPSHOT_VERSION = 1

/** 带格式版本的案卷快照文件结构 */
export interface CaseSnapshot {
  app: string
  kind: string
  version: number
  /** 导出时刻（UTC ISO，仅信息展示，不参与校验） */
  exportedAt: string
  data: AppState
}

/** 一条定位到 JSON 路径的校验错误 */
export interface SnapshotError {
  /** 出错位置（如 data.constraints[2].min） */
  path: string
  message: string
}

/** 记录数预览（根对象与 data 可解析时给出，与是否存在错误无关） */
export interface SnapshotCounts {
  events: number
  constraints: number
  /** 其中启用（enabled === true）的约束数 */
  enabledConstraints: number
  observations: number
  desiredTimes: number
  desiredPriorities: number
}

export interface SnapshotValidation {
  /** 全部校验通过（此时 state 非空，可整包替换） */
  ok: boolean
  /** 全部校验错误（按发现顺序，逐项展示） */
  errors: SnapshotError[]
  /** 校验通过时可直接整包替换的案卷状态；存在任何错误时为 null */
  state: AppState | null
  /** 记录数预览；JSON 根本无法解析或为非对象时为 null */
  counts: SnapshotCounts | null
}

// ==================== 导出 ====================

/** 由当前案卷状态构造带格式版本的快照对象 */
export function buildSnapshot(state: AppState, exportedAt: Date = new Date()): CaseSnapshot {
  return {
    app: SNAPSHOT_APP,
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    exportedAt: exportedAt.toISOString(),
    data: state,
  }
}

/** 序列化为带缩进的格式化 JSON 文本（下载内容） */
export function serializeSnapshot(state: AppState): string {
  return JSON.stringify(buildSnapshot(state), null, 2)
}

/** 下载文件名：case-snapshot-2026-09-26T08-30.json（本地时间，取整到分钟） */
export function snapshotFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `case-snapshot-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}.json`
}

// ==================== 校验 ====================

const PRIORITY_LEVELS: readonly PriorityLevel[] = ['high', 'medium', 'low']

/** 严格的 yyyy-MM-ddTHH:mm（datetime-local）格式 + 日历合法性 */
function isValidDateTimeLocal(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s)
  if (!m) return false
  return validDateTime(m[1], m[2], m[3], m[4], m[5])
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 完整校验一段快照文本。返回全部错误与记录数预览；
 * 仅当零错误时给出可整包替换的 AppState。
 */
export function validateSnapshot(text: string): SnapshotValidation {
  const errors: SnapshotError[] = []
  const fail = (path: string, message: string) => errors.push({ path, message })

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: '$', message: `JSON 解析失败：${(e as Error).message}` }],
      state: null,
      counts: null,
    }
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      errors: [{ path: '$', message: '快照根节点必须是 JSON 对象' }],
      state: null,
      counts: null,
    }
  }

  // —— 格式标记与版本号 ——
  if (parsed.app !== undefined && parsed.app !== SNAPSHOT_APP) {
    fail('$.app', `格式标记 app 应为 "${SNAPSHOT_APP}"，实际为 ${JSON.stringify(parsed.app)}`)
  }
  if (parsed.kind !== undefined && parsed.kind !== SNAPSHOT_KIND) {
    fail('$.kind', `格式标记 kind 应为 "${SNAPSHOT_KIND}"，实际为 ${JSON.stringify(parsed.kind)}`)
  }
  if (parsed.version === undefined) {
    fail('$.version', `缺少格式版本号 version（当前支持 version: ${SNAPSHOT_VERSION}）`)
  } else if (parsed.version !== SNAPSHOT_VERSION) {
    fail('$.version', `不支持的格式版本 ${JSON.stringify(parsed.version)}（当前支持 version: ${SNAPSHOT_VERSION}）`)
  }

  const data = parsed.data
  if (!isPlainObject(data)) {
    fail('$.data', '缺少案卷数据对象 data（应包含 events / constraints / observations / desiredTimes / desiredPriorities）')
    return { ok: false, errors, state: null, counts: null }
  }

  // —— 事件：字段类型 + id 唯一 ——
  const eventIds = new Set<string>()
  const rawEvents = data.events
  let events: TEvent[] = []
  if (!Array.isArray(rawEvents)) {
    fail('data.events', 'events 必须是数组')
  } else {
    rawEvents.forEach((raw, i) => {
      const path = `data.events[${i}]`
      if (!isPlainObject(raw)) {
        fail(path, '事件必须是对象')
        return
      }
      if (typeof raw.id !== 'string' || raw.id === '') {
        fail(`${path}.id`, '事件 id 必须是非空字符串')
      } else if (eventIds.has(raw.id)) {
        fail(`${path}.id`, `事件 id "${raw.id}" 重复`)
      } else {
        eventIds.add(raw.id)
      }
      if (typeof raw.name !== 'string') {
        fail(`${path}.name`, '事件名称 name 必须是字符串')
      }
      if (raw.note !== undefined && typeof raw.note !== 'string') {
        fail(`${path}.note`, '事件备注 note 必须是字符串（或省略该字段）')
      }
      if (
        typeof raw.id === 'string' && raw.id !== '' &&
        typeof raw.name === 'string' &&
        (raw.note === undefined || typeof raw.note === 'string')
      ) {
        const ev: TEvent = { id: raw.id, name: raw.name }
        if (raw.note !== undefined) ev.note = raw.note
        events.push(ev)
      }
    })
  }

  // —— 约束：字段类型 + id 唯一 + 引用现存事件 + 非负整数分钟且 min ≤ max ——
  const constraintIds = new Set<string>()
  const rawConstraints = data.constraints
  let constraints: Constraint[] = []
  if (!Array.isArray(rawConstraints)) {
    fail('data.constraints', 'constraints 必须是数组')
  } else {
    rawConstraints.forEach((raw, i) => {
      const path = `data.constraints[${i}]`
      if (!isPlainObject(raw)) {
        fail(path, '约束必须是对象')
        return
      }
      if (typeof raw.id !== 'string' || raw.id === '') {
        fail(`${path}.id`, '约束 id 必须是非空字符串')
      } else if (constraintIds.has(raw.id)) {
        fail(`${path}.id`, `约束 id "${raw.id}" 重复`)
      } else {
        constraintIds.add(raw.id)
      }
      if (typeof raw.aId !== 'string') {
        fail(`${path}.aId`, '约束的事件 aId 必须是字符串')
      } else if (!eventIds.has(raw.aId)) {
        fail(`${path}.aId`, `约束引用了不存在的事件 "${raw.aId}"`)
      }
      if (typeof raw.bId !== 'string') {
        fail(`${path}.bId`, '约束的事件 bId 必须是字符串')
      } else if (!eventIds.has(raw.bId)) {
        fail(`${path}.bId`, `约束引用了不存在的事件 "${raw.bId}"`)
      }
      if (raw.relation !== 'earlier' && raw.relation !== 'later') {
        fail(`${path}.relation`, `关系方向 relation 必须是 "earlier" 或 "later"，实际为 ${JSON.stringify(raw.relation)}`)
      }
      for (const key of ['min', 'max'] as const) {
        const v = raw[key]
        if (typeof v !== 'number' || Number.isNaN(v)) {
          fail(`${path}.${key}`, `约束分钟数 ${key} 必须是数字`)
        } else if (!Number.isInteger(v)) {
          fail(`${path}.${key}`, `约束分钟数 ${key} 必须是整数，实际为 ${v}`)
        } else if (v < 0) {
          fail(`${path}.${key}`, `约束分钟数 ${key} 必须是非负整数，实际为 ${v}`)
        }
      }
      if (
        typeof raw.min === 'number' && Number.isInteger(raw.min) && raw.min >= 0 &&
        typeof raw.max === 'number' && Number.isInteger(raw.max) && raw.max >= 0 &&
        raw.min > raw.max
      ) {
        fail(`${path}.min`, `约束分钟数下界 min（${raw.min}）不能大于上界 max（${raw.max}）`)
      }
      if (typeof raw.enabled !== 'boolean') {
        fail(`${path}.enabled`, '约束启用标记 enabled 必须是布尔值')
      }
      if (
        typeof raw.id === 'string' && raw.id !== '' &&
        typeof raw.aId === 'string' && eventIds.has(raw.aId) &&
        typeof raw.bId === 'string' && eventIds.has(raw.bId) &&
        (raw.relation === 'earlier' || raw.relation === 'later') &&
        typeof raw.min === 'number' && Number.isInteger(raw.min) && raw.min >= 0 &&
        typeof raw.max === 'number' && Number.isInteger(raw.max) && raw.max >= raw.min &&
        typeof raw.enabled === 'boolean'
      ) {
        constraints.push({
          id: raw.id,
          aId: raw.aId,
          bId: raw.bId,
          relation: raw.relation,
          min: raw.min,
          max: raw.max,
          enabled: raw.enabled,
        })
      }
    })
  }

  // —— 观测：字段类型 + id 唯一 + 引用现存事件 + 有效时刻 + 起点不晚于终点 ——
  const observationIds = new Set<string>()
  const rawObservations = data.observations
  let observations: TimeObservation[] = []
  if (!Array.isArray(rawObservations)) {
    fail('data.observations', 'observations 必须是数组')
  } else {
    rawObservations.forEach((raw, i) => {
      const path = `data.observations[${i}]`
      if (!isPlainObject(raw)) {
        fail(path, '观测必须是对象')
        return
      }
      if (typeof raw.id !== 'string' || raw.id === '') {
        fail(`${path}.id`, '观测 id 必须是非空字符串')
      } else if (observationIds.has(raw.id)) {
        fail(`${path}.id`, `观测 id "${raw.id}" 重复`)
      } else {
        observationIds.add(raw.id)
      }
      if (typeof raw.eventId !== 'string') {
        fail(`${path}.eventId`, '观测的事件 eventId 必须是字符串')
      } else if (!eventIds.has(raw.eventId)) {
        fail(`${path}.eventId`, `观测引用了不存在的事件 "${raw.eventId}"`)
      }
      for (const key of ['start', 'end'] as const) {
        const v = raw[key]
        if (typeof v !== 'string') {
          fail(`${path}.${key}`, `观测${key === 'start' ? '起点' : '终点'} ${key} 必须是字符串`)
        } else if (!isValidDateTimeLocal(v)) {
          fail(`${path}.${key}`, `观测时刻 "${v}" 不是有效的 yyyy-MM-ddTHH:mm`)
        }
      }
      if (
        typeof raw.start === 'string' && isValidDateTimeLocal(raw.start) &&
        typeof raw.end === 'string' && isValidDateTimeLocal(raw.end) &&
        new Date(raw.end).getTime() < new Date(raw.start).getTime()
      ) {
        fail(`${path}.end`, `观测终点 ${raw.end} 早于起点 ${raw.start}`)
      }
      if (
        typeof raw.id === 'string' && raw.id !== '' &&
        typeof raw.eventId === 'string' && eventIds.has(raw.eventId) &&
        typeof raw.start === 'string' && isValidDateTimeLocal(raw.start) &&
        typeof raw.end === 'string' && isValidDateTimeLocal(raw.end) &&
        new Date(raw.end).getTime() >= new Date(raw.start).getTime()
      ) {
        observations.push({ id: raw.id, eventId: raw.eventId, start: raw.start, end: raw.end })
      }
    })
  }

  // —— 期望时刻：映射表 + 键指向现存事件 + 值为有效 yyyy-MM-ddTHH:mm ——
  const rawDesiredTimes = data.desiredTimes
  let desiredTimes: Record<string, string> = {}
  if (!isPlainObject(rawDesiredTimes)) {
    fail('data.desiredTimes', 'desiredTimes 必须是对象（事件 id -> 期望时刻）')
  } else {
    for (const [id, v] of Object.entries(rawDesiredTimes)) {
      const path = `data.desiredTimes[${JSON.stringify(id)}]`
      if (!eventIds.has(id)) {
        fail(path, `期望时刻指向了不存在的事件 "${id}"`)
        continue
      }
      if (typeof v !== 'string') {
        fail(path, '期望时刻必须是字符串')
        continue
      }
      if (!isValidDateTimeLocal(v)) {
        fail(path, `期望时刻 "${v}" 不是有效的 yyyy-MM-ddTHH:mm`)
        continue
      }
      desiredTimes[id] = v
    }
  }

  // —— 优先级：映射表 + 键指向现存事件 + 值仅 高/中/低 ——
  const rawPriorities = data.desiredPriorities
  let desiredPriorities: Record<string, PriorityLevel> = {}
  if (!isPlainObject(rawPriorities)) {
    fail('data.desiredPriorities', 'desiredPriorities 必须是对象（事件 id -> high/medium/low）')
  } else {
    for (const [id, v] of Object.entries(rawPriorities)) {
      const path = `data.desiredPriorities[${JSON.stringify(id)}]`
      if (!eventIds.has(id)) {
        fail(path, `优先级指向了不存在的事件 "${id}"`)
        continue
      }
      if (typeof v !== 'string' || !PRIORITY_LEVELS.includes(v as PriorityLevel)) {
        fail(path, `优先级必须是 "high" / "medium" / "low" 之一，实际为 ${JSON.stringify(v)}`)
        continue
      }
      desiredPriorities[id] = v as PriorityLevel
    }
  }

  // —— 记录数预览：只要对应字段可解析就给出（与是否存在错误无关）——
  const counts: SnapshotCounts = {
    events: Array.isArray(rawEvents) ? rawEvents.length : 0,
    constraints: Array.isArray(rawConstraints) ? rawConstraints.length : 0,
    enabledConstraints: Array.isArray(rawConstraints)
      ? rawConstraints.filter((c) => isPlainObject(c) && c.enabled === true).length
      : 0,
    observations: Array.isArray(rawObservations) ? rawObservations.length : 0,
    desiredTimes: isPlainObject(rawDesiredTimes) ? Object.keys(rawDesiredTimes).length : 0,
    desiredPriorities: isPlainObject(rawPriorities) ? Object.keys(rawPriorities).length : 0,
  }

  if (errors.length > 0) {
    // 任一错误都禁止应用；上面收集的局部实体一律作废，绝不静默丢弃记录后放行
    return { ok: false, errors, state: null, counts }
  }

  return {
    ok: true,
    errors,
    state: { events, constraints, observations, desiredTimes, desiredPriorities },
    counts,
  }
}
