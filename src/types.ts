/**
 * 应用领域类型
 */

/** 事件（时间轴上的一个待定位的点） */
export interface TEvent {
  id: string
  name: string
  note?: string
}

/** 关系方向：A 早于 B，或 A 晚于 B */
export type Relation = 'earlier' | 'later'

/**
 * 一条“事件 A 比事件 B {早|晚} min..max 分钟”的相对时序约束。
 * min <= max，单位为分钟（整数）。
 */
export interface Constraint {
  id: string
  aId: string
  bId: string
  relation: Relation
  min: number
  max: number
  enabled: boolean
}

/**
 * 一条对某事件的绝对时间观测区间：
 * start ≤ 该事件发生时刻 ≤ end（本地时间，datetime-local ISO 字符串）。
 * start === end 时为精确时刻观测（零宽区间）。
 * 多条观测可分别落在不同事件上，与相对约束一起进入同一差分约束图。
 */
export interface TimeObservation {
  id: string
  /** 被观测的事件 id */
  eventId: string
  /** 观测到的最早可能时刻（本地时间 ISO，yyyy-MM-ddTHH:mm） */
  start: string
  /** 观测到的最晚可能时刻（本地时间 ISO）；精确时刻时等于 start */
  end: string
}

/** 期望时刻的优先级层级：高 / 中 / 低（按此顺序做字典序最小化） */
export type PriorityLevel = 'high' | 'medium' | 'low'

/** 应用持久化状态 */
export interface AppState {
  events: TEvent[]
  constraints: Constraint[]
  /**
   * 绝对时间观测区间列表（可为空；可为同一事件录入多条）。
   * 旧版本存档的单一「锚点事件 + 锚点绝对时间」在载入时自动迁移为一条
   * 精确（零宽）观测。
   */
  observations: TimeObservation[]
  /** 各事件的期望时刻（事件 id -> 本地时间 ISO）；仅与任一观测连通的事件参与最小偏差排程 */
  desiredTimes: Record<string, string>
  /**
   * 各事件期望时刻的优先级层级（事件 id -> 高/中/低）。
   * 仅对填写了期望时刻的事件有意义；缺省按「中」处理（兼容旧版存档）。
   */
  desiredPriorities: Record<string, PriorityLevel>
}

/**
 * 差分图中的一条有向边 u -> v，权重 w（分钟），表示 t_v - t_u <= w。
 * kind 区分边的来源：相对约束（constraint）还是绝对时间观测（observation）。
 * 两类边进入同一张图、同一次 Bellman-Ford，因此矛盾环可同时包含二者。
 */
export interface DiffEdge {
  u: number
  v: number
  w: number
  /** 边的来源类型 */
  kind: 'constraint' | 'observation'
  /** 产生该边的约束 id（kind === 'constraint'） */
  constraintId?: string
  /** 产生该边的观测 id（kind === 'observation'） */
  observationId?: string
  /** 该边是来源约束/观测的上界侧还是下界侧 */
  bound: 'upper' | 'lower'
}

/**
 * 统一的差分系统：事件节点 0..n-1，外加一个虚拟「时间原点」节点 t0（下标 n）。
 * t0 代表 baseISO 对应的绝对时刻；观测边把事件变量与 t0 相连。
 */
export interface DiffSystem {
  /** 事件节点数；时间原点下标为 originIdx = n */
  n: number
  edges: DiffEdge[]
  /** 事件 id -> 节点下标 */
  indexOf: Map<string, number>
  /** 时间原点节点下标 */
  originIdx: number
  /**
   * 时间原点对应的真实时刻（datetime-local ISO）：取全部有效观测起点的最小值。
   * 无有效观测时为 null（原点与任何事件不连通，仅作为相对矛盾检测的载体）。
   */
  baseISO: string | null
}

export interface AnalysisResult {
  /** 是否存在矛盾（负环） */
  satisfiable: boolean
  /** 命中的一条矛盾环（按沿环行走的顺序） */
  cycle?: CycleInfo
  /** 每个事件的绝对时间窗（仅可满足时计算） */
  windows: Map<number, WindowInfo>
  /** 时间原点对应的真实时刻；无任何有效观测时为 null（全部事件无法定时） */
  baseISO: string | null
}

export interface CycleInfo {
  /** 环上的节点，按环顺序，首尾不重复（可能包含时间原点下标 n） */
  nodes: number[]
  /** 环上的边，edges[i] 从 nodes[i] 指向 nodes[(i+1) % n] */
  edges: DiffEdge[]
  /** 环上权重之和（严格小于 0） */
  totalWeight: number
}

export type WindowStatus = 'bounded' | 'oneSided' | 'disconnected'

export interface WindowInfo {
  status: WindowStatus
  /**
   * 相对时间原点（baseISO）的最早偏移（分钟）；单边/不可达时为 null（-∞）。
   * 即最早绝对时刻 = baseISO + earliestOffset。
   */
  earliestOffset: number | null
  /** 相对时间原点的最晚偏移（分钟）；单边/不可达时为 null（+∞） */
  latestOffset: number | null
  /** 直接把该事件与时间原点连通（即直接夹出此事件绝对时间）的观测 id */
  directObservationIds: string[]
}

/**
 * 边界追溯中的一步：沿一条差分边把边界 from 事件推进到 to 事件。
 * edge 始终为原始图方向的差分边（u -> v，权 w 表示 t_v - t_u <= w）；
 * 最早边界在反向图上推导，此时行走方向 from -> to 与 edge.u -> edge.v 相反。
 */
export interface BoundTraceStep {
  /** 本步采用的原始差分边（含来源类型、来源 id 与上/下界侧） */
  edge: DiffEdge
  /** 推导方向上的起点（从时间原点出发） */
  from: number
  /** 推导方向上的终点 */
  to: number
  /** 走完该步后，to 相对时间原点的累计偏移（分钟） */
  cumulative: number
}

/**
 * 某事件最早/最晚边界的推导链：从时间原点出发的紧约束链。
 * steps 按推导顺序排列；事件被一条精确（零宽）观测直接钉住时可为零步证明。
 */
export interface BoundTrace {
  /** 目标事件下标 */
  eventIdx: number
  /** 追溯的是最早边界还是最晚边界 */
  kind: 'earliest' | 'latest'
  /** 推导出的边界值：相对时间原点的偏移（分钟） */
  offset: number
  /** 从时间原点出发按推导顺序排列的步骤 */
  steps: BoundTraceStep[]
  /** 零步证明时直接钉住该事件的精确观测 id；其余情况为 null */
  directObservationId: string | null
}

/** 分层最小偏差排程中单个事件的结果 */
export interface ScheduleEntry {
  eventIdx: number
  status: 'scheduled' | 'unscheduled'
  /** 实际排程时刻相对时间原点的偏移（分钟）；未定时为 null */
  offsetMin: number | null
  /** 期望时刻相对时间原点的偏移（分钟）；未填写或无效为 null */
  desiredOffset: number | null
  /** 实际 − 期望（分钟）；仅对已填写期望且已定时的事件 */
  deviation: number | null
  /** 期望因事件未与任何观测连通而被忽略 */
  desiredIgnored: boolean
  /** 该事件期望时刻的优先级层级；未填写期望为 null（未填写层级时按「中」） */
  priority: PriorityLevel | null
}

/** 分层最小偏差排程中单层（高/中/低）的结果 */
export interface LayerResult {
  /** 本层层级 */
  level: PriorityLevel
  /** 本层参与整体搜索的期望事件数量 */
  count: number
  /**
   * 本层的最优容差 D（分钟）：在全部更高层容差已固定的前提下，
   * 使本层全部期望 |实际 − 期望| ≤ D 同时可满足的最小非负整数；
   * 本层无参与事件时为 null
   */
  D: number | null
  /** 本层达到 |偏差| = D 的事件下标（按事件顺序） */
  tightEventIdx: number[]
  /** 本层期望事件在最终排程中的最大 |偏差|（整数输入下等于 D）；无参与事件为 null */
  maxDeviation: number | null
}

/**
 * 分层最小偏差排程结果。
 * 对当前有效差分系统（相对约束 + 全部绝对时间观测）按 高 → 中 → 低 做字典序最小化：
 * 先求高优先级的最小最大偏差 D_高，把 ±D_高 的钉住约束固定进边集后再求下一层；
 * 最终输出一份同时满足全部启用约束、全部观测与各层容差的确定性排程。
 */
export interface ScheduleResult {
  /** 各层结果，固定为高、中、低三层并按字典序优化顺序排列 */
  layers: LayerResult[]
  /** 每个事件的排程条目（按事件顺序） */
  entries: ScheduleEntry[]
  /** 参与整体搜索的期望事件总数（各层 count 之和） */
  desiredCount: number
}

/**
 * 最小修复方案：停用 disableConstraintIds 中的约束后，差分系统恢复可满足。
 * 观测是事实记录、不允许停用，因此修复只涉及相对约束。
 */
export interface RepairPlan {
  /** 建议停用的约束 id（按约束录入顺序升序排列） */
  disableConstraintIds: string[]
  /** 停用上述约束后，每个事件的绝对时间窗 */
  windows: Map<number, WindowInfo>
}

/** 冗余证词审计的结论：冗余（其余约束与全部观测已蕴含该证词）或必要（提供独立信息） */
export type AuditVerdict = 'redundant' | 'necessary'

/**
 * 冗余证词审计条目：系统可满足时，暂时排除一条已启用相对约束，
 * 基于其余约束与全部观测重新推导该证词两端事件的最紧时间差区间。
 * 差值方向与证词一致：d = t_to − t_from（earlier：to=B、from=A；later：to=A、from=B），
 * 证词声称 d ∈ [min, max]；推导区间完整落在 [min, max] 内 → 冗余，否则 → 必要。
 */
export interface AuditEntry {
  /** 被审计的约束 id */
  constraintId: string
  /** 排除该约束后推导出的差值下界（分钟）；下界不可达（按无界处理）为 null（−∞） */
  derivedMin: number | null
  /** 排除该约束后推导出的差值上界（分钟）；上界不可达（按无界处理）为 null（+∞） */
  derivedMax: number | null
  /** 审计结论 */
  verdict: AuditVerdict
}

/** 最小修复搜索结果 */
export interface RepairSearchResult {
  /** 是否找到至少一个可满足修复方案 */
  found: boolean
  /** 并列最优方案，最多 5 个，按需停用约束的录入顺序稳定排序 */
  plans: RepairPlan[]
  /** 已找到的并列最优方案总数（可能大于 plans.length；截断时为下界） */
  totalPlans: number
  /** 每个方案需停用的约束数量（found 为 true 时即已证明的最小停用数） */
  disableCount: number
  /** 是否因达到累计状态数上限而提前停止（结果可能不完备） */
  truncated: boolean
  /** 最小停用数是否已被证明（found 为 true 时恒为 true） */
  optimumProven: boolean
  /** 累计访问的搜索状态数 */
  statesVisited: number
  /** 状态数上限（默认 2000） */
  stateLimit: number
  /**
   * 当前矛盾无法仅靠停用相对约束消除（矛盾环完全由绝对时间观测与相对约束构成，
   * 且没有可停用的约束；或搜索在上限内未能找到方案）。此时矛盾链中至少包含一条
   * 观测，需要核对观测记录本身。
   */
  observationConflict: boolean
}
