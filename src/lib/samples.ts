import type { AppState, Constraint, TEvent, TimeObservation } from '../types'

/** 生成简短唯一 id（无需 crypto 也可运行） */
export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function mkEvent(name: string, note?: string): TEvent {
  return { id: uid('ev'), name, note }
}

/**
 * 可满足示例：事故复盘时间线（对“值班告警触发”有一条精确时刻观测）。
 * 其中“媒体报道”与主体事件没有任何约束连接，用于演示“无法定时”。
 */
export function buildConsistentSample(): AppState {
  const alert = mkEvent('值班告警触发', '监控系统 P1 告警')
  const onCall = mkEvent('值班工程师介入')
  const fault = mkEvent('定位到故障节点')
  const failover = mkEvent('完成流量切换')
  const recovered = mkEvent('服务恢复')
  const postmortem = mkEvent('复盘会议')
  const press = mkEvent('媒体报道', '未与内部时间线建立任何约束')

  const events = [alert, onCall, fault, failover, recovered, postmortem, press]
  const E: Omit<Constraint, 'id'>[] = [
    // 介入比告警晚 2~5 分钟
    { aId: onCall.id, bId: alert.id, relation: 'later', min: 2, max: 5, enabled: true },
    // 定位故障比介入晚 3~10 分钟
    { aId: fault.id, bId: onCall.id, relation: 'later', min: 3, max: 10, enabled: true },
    // 流量切换比定位晚 1~6 分钟
    { aId: failover.id, bId: fault.id, relation: 'later', min: 1, max: 6, enabled: true },
    // 服务恢复比切换晚 1~4 分钟
    { aId: recovered.id, bId: failover.id, relation: 'later', min: 1, max: 4, enabled: true },
    // 恢复比告警晚 8~20 分钟（对全链路的整体约束）
    { aId: recovered.id, bId: alert.id, relation: 'later', min: 8, max: 20, enabled: true },
    // 复盘会议比恢复晚 60~180 分钟
    { aId: postmortem.id, bId: recovered.id, relation: 'later', min: 60, max: 180, enabled: true },
    // 定位故障早于恢复 5~15 分钟（等价的另一种表述，用于形成更多路径）
    { aId: fault.id, bId: recovered.id, relation: 'earlier', min: 5, max: 15, enabled: true },
  ]
  const constraints = E.map((e) => ({ ...e, id: uid('ct') }))

  // 绝对时间观测：值班告警 08:00 触发（精确时刻，零宽区间）；
  // 另对复盘会议有一条较宽的现场记录区间，用于演示多条观测共同定时。
  const anchorTime = defaultAnchorTime()
  const observations: TimeObservation[] = [
    { id: uid('obs'), eventId: alert.id, start: anchorTime, end: anchorTime },
  ]

  // 期望时刻演示：期望恢复 +25 分钟（窗口 [10,20] 之外，高优先级层最优容差 D=5）、
  // 期望复盘 +120 分钟（低优先级，在高层容差固定后仍可达，D=0）
  return {
    events,
    constraints,
    observations,
    desiredTimes: {
      [recovered.id]: plusMinutes(anchorTime, 25),
      [postmortem.id]: plusMinutes(anchorTime, 120),
    },
    desiredPriorities: {
      [recovered.id]: 'high',
      [postmortem.id]: 'low',
    },
  }
}

/**
 * 矛盾示例：采访证词互相冲突。
 * 证人一：B 比 A 晚 10~20 分钟；
 * 证人二：C 比 B 晚 5~10 分钟；
 * 证人三：A 比 C 晚 10~30 分钟。
 * 三个“晚于”沿环相加要求 t_A - t_A <= -25，构成负环。
 * 同时对 A 有一条精确观测，使矛盾环连接到绝对时间轴（修复建议停用 1 条证词即可）。
 */
export function buildContradictionSample(): AppState {
  const A = mkEvent('A：车辆驶入路口')
  const B = mkEvent('B：目击者听到刹车声')
  const C = mkEvent('C：碰撞发生')
  const D = mkEvent('D：救护车到达')
  const events = [A, B, C, D]
  const E: Omit<Constraint, 'id'>[] = [
    { aId: B.id, bId: A.id, relation: 'later', min: 10, max: 20, enabled: true },
    { aId: C.id, bId: B.id, relation: 'later', min: 5, max: 10, enabled: true },
    { aId: A.id, bId: C.id, relation: 'later', min: 10, max: 30, enabled: true },
    // 一条与矛盾无关的正常约束
    { aId: D.id, bId: C.id, relation: 'later', min: 8, max: 25, enabled: true },
  ]
  const constraints = E.map((e) => ({ ...e, id: uid('ct') }))
  const t = defaultAnchorTime()
  return {
    events,
    constraints,
    observations: [{ id: uid('obs'), eventId: A.id, start: t, end: t }],
    desiredTimes: {},
    desiredPriorities: {},
  }
}

/** 空状态 */
export function emptyState(): AppState {
  return {
    events: [],
    constraints: [],
    observations: [],
    desiredTimes: {},
    desiredPriorities: {},
  }
}

/** 当前时间取整到分钟，用于 datetime-local 输入框 */
export function defaultAnchorTime(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  return toLocalISO(d)
}

/** 在 ISO 本地时间上叠加分钟偏移，返回 datetime-local 格式 */
export function plusMinutes(iso: string, min: number): string {
  const d = new Date(iso)
  d.setMinutes(d.getMinutes() + min)
  return toLocalISO(d)
}

/** 格式化为 datetime-local 所需的 yyyy-MM-ddTHH:mm（本地时间） */
function toLocalISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
