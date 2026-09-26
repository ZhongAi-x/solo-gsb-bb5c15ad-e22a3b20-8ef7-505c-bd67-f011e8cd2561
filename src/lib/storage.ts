import type { AppState, TimeObservation } from '../types'

const STORAGE_KEY = 'temporal-constraint-checker:v1'

/** 生成简短唯一 id（迁移产生的观测用） */
function migrateId(): string {
  return `obs_migrated_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把任意历史形态的存档规范化为当前 AppState：
 * - 旧版本只有「锚点事件 anchorId + 锚点绝对时间 anchorTime」：迁移为一条
 *   锚点事件上的**精确（零宽）观测** [anchorTime, anchorTime]；
 * - 已有 observations 字段：过滤引用缺失事件 / 时间无效的观测，补齐 end 字段；
 * - 期望时刻与优先级字段缺失时按旧逻辑补空。
 */
export function migrateState(parsed: Partial<AppState> & { anchorId?: string | null; anchorTime?: string }): AppState {
  const events = Array.isArray(parsed.events) ? parsed.events : []
  const constraints = Array.isArray(parsed.constraints) ? parsed.constraints : []
  const eventIds = new Set(events.map((e) => e.id))

  let observations: TimeObservation[] = []
  if (Array.isArray(parsed.observations)) {
    for (const o of parsed.observations) {
      if (!o || typeof o.id !== 'string' || !eventIds.has(o.eventId)) continue
      const startMs = new Date(o.start).getTime()
      if (Number.isNaN(startMs)) continue
      let end = typeof o.end === 'string' ? o.end : o.start
      if (Number.isNaN(new Date(end).getTime()) || new Date(end).getTime() < startMs) end = o.start
      observations.push({ id: o.id, eventId: o.eventId, start: o.start, end })
    }
  } else if (parsed.anchorId && typeof parsed.anchorTime === 'string' && eventIds.has(parsed.anchorId)) {
    // 旧版单锚点数据：锚点的绝对时间即对锚点事件的一次精确时刻观测
    const t = parsed.anchorTime
    if (!Number.isNaN(new Date(t).getTime())) {
      observations = [{ id: migrateId(), eventId: parsed.anchorId, start: t, end: t }]
    }
  }

  // 旧版本存档没有期望时刻字段：规范化为空表
  let desiredTimes: Record<string, string> = {}
  if (parsed.desiredTimes && typeof parsed.desiredTimes === 'object') {
    desiredTimes = parsed.desiredTimes as Record<string, string>
  }
  // 旧版本存档没有优先级层级字段：规范化为空表（缺省按「中」参与排程），
  // 并过滤手工篡改等原因产生的非法层级值
  let desiredPriorities: Record<string, string> = {}
  if (parsed.desiredPriorities && typeof parsed.desiredPriorities === 'object') {
    desiredPriorities = { ...parsed.desiredPriorities }
    for (const [id, lv] of Object.entries(desiredPriorities)) {
      if (lv !== 'high' && lv !== 'medium' && lv !== 'low') {
        delete desiredPriorities[id]
      }
    }
  }

  return {
    events,
    constraints,
    observations,
    desiredTimes,
    desiredPriorities: desiredPriorities as AppState['desiredPriorities'],
  }
}

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.constraints)) return null
    return migrateState(parsed)
  } catch {
    return null
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式 / 配额不足时静默失败，不影响使用
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
