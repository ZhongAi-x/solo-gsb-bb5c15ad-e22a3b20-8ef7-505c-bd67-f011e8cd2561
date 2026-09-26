import type {
  AnalysisResult,
  BoundTrace,
  BoundTraceStep,
  Constraint,
  DiffEdge,
  DiffSystem,
  TimeObservation,
  TEvent,
  WindowInfo,
} from '../types'

const MINUTE_MS = 60_000

/**
 * 把一条“事件 A 比事件 B 早/晚 min..max 分钟”的约束转换为两条差分不等式。
 *
 * 约定有向边 u -> v，权重 w 表示  t_v - t_u <= w
 *
 * earlier:  min <= t_B - t_A <= max
 *   上界  t_B - t_A <= max   =>  A -> B, max
 *   下界  t_B - t_A >= min   =>  t_A - t_B <= -min  =>  B -> A, -min
 *
 * later:    min <= t_A - t_B <= max
 *   上界  t_A - t_B <= max   =>  B -> A, max
 *   下界  t_A - t_B >= min   =>  t_B - t_A <= -min  =>  A -> B, -min
 */
export function constraintToEdges(c: Constraint, index: (id: string) => number): DiffEdge[] {
  const a = index(c.aId)
  const b = index(c.bId)
  if (c.relation === 'earlier') {
    return [
      { u: a, v: b, w: c.max, kind: 'constraint', constraintId: c.id, bound: 'upper' },
      { u: b, v: a, w: -c.min, kind: 'constraint', constraintId: c.id, bound: 'lower' },
    ]
  }
  return [
    { u: b, v: a, w: c.max, kind: 'constraint', constraintId: c.id, bound: 'upper' },
    { u: a, v: b, w: -c.min, kind: 'constraint', constraintId: c.id, bound: 'lower' },
  ]
}

/** datetime-local 字符串解析为毫秒时间戳；无效返回 NaN */
function parseISO(iso: string): number {
  return new Date(iso).getTime()
}

/** 毫秒时间戳转回 datetime-local 所需的 yyyy-MM-ddTHH:mm（本地时间） */
function toLocalISO(ms: number): string {
  const d = new Date(ms)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 构造统一差分系统：事件节点 0..n-1 + 虚拟时间原点节点 t0（下标 n）。
 *
 * 观测「事件 e 发生在 [start, end]」相对基准 baseISO（= 全部观测起点最小值）记为
 *
 *     lo ≤ t_e − t0 ≤ hi （分钟整数）
 *
 * 转换为两条边：
 *   上界  t_e − t0 ≤ hi  =>  t0 -> e, hi
 *   下界  t0 − t_e ≤ −lo =>  e -> t0, −lo
 *
 * 观测边与相对约束边放在同一张图里：一次 Bellman-Ford 即可同时发现
 * 「约束之间」「观测之间」「观测与约束之间」的全部矛盾，抽出的负环
 * 天然是同时包含观测边与约束边的完整矛盾链（不按锚点独立判断）。
 *
 * 引用已删除事件或时间无效的观测被跳过；end < start 时按精确时刻归一。
 */
export function buildSystem(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
): DiffSystem {
  const n = events.length
  const originIdx = n
  const indexOf = new Map<string, number>()
  events.forEach((e, i) => indexOf.set(e.id, i))
  const idx = (id: string) => indexOf.get(id)!

  // —— 相对约束边（保持录入顺序，保证 Bellman-Ford 结果确定）——
  const edges: DiffEdge[] = []
  for (const c of constraints) {
    if (!c.enabled) continue
    if (!indexOf.has(c.aId) || !indexOf.has(c.bId)) continue
    edges.push(...constraintToEdges(c, idx))
  }

  // —— 有效观测（顺序归一，保证基准与边序确定）——
  const valid: { obs: TimeObservation; startMs: number; endMs: number }[] = []
  for (const obs of observations) {
    if (!indexOf.has(obs.eventId)) continue
    const s = parseISO(obs.start)
    const rawEnd = obs.end ? parseISO(obs.end) : s
    if (Number.isNaN(s) || Number.isNaN(rawEnd)) continue
    const e = rawEnd < s ? s : rawEnd
    valid.push({ obs, startMs: s, endMs: e })
  }
  valid.sort((a, b) => (a.obs.id < b.obs.id ? -1 : a.obs.id > b.obs.id ? 1 : 0))

  let baseISO: string | null = null
  if (valid.length > 0) {
    const baseMs = Math.min(...valid.map((v) => v.startMs))
    baseISO = toLocalISO(baseMs)
    const base = parseISO(baseISO)
    for (const { obs, startMs, endMs } of valid) {
      const lo = Math.round((startMs - base) / MINUTE_MS)
      const hi = Math.round((endMs - base) / MINUTE_MS)
      const e = idx(obs.eventId)
      edges.push(
        { u: originIdx, v: e, w: hi, kind: 'observation', observationId: obs.id, bound: 'upper' },
        { u: e, v: originIdx, w: -lo, kind: 'observation', observationId: obs.id, bound: 'lower' },
      )
    }
  }

  return { n, edges, indexOf, originIdx, baseISO }
}

/**
 * 仅构造相对约束边（不含时间原点与观测边）。保留供旧调用点/测试使用。
 */
export function buildEdges(
  events: TEvent[],
  constraints: Constraint[],
): { edges: DiffEdge[]; indexOf: Map<string, number> } {
  const indexOf = new Map<string, number>()
  events.forEach((e, i) => indexOf.set(e.id, i))
  const idx = (id: string) => indexOf.get(id)!
  const edges: DiffEdge[] = []
  for (const c of constraints) {
    if (!c.enabled) continue
    // 跳过引用了已删除事件的约束
    if (!indexOf.has(c.aId) || !indexOf.has(c.bId)) continue
    edges.push(...constraintToEdges(c, idx))
  }
  return { edges, indexOf }
}

const INF = Number.POSITIVE_INFINITY

interface BFResult {
  dist: number[]
  predEdge: (DiffEdge | null)[]
  /** 第 m 轮仍被松弛的一条边（存在即说明有负环） */
  lastRelaxed: DiffEdge | null
}

/**
 * 通用 Bellman-Ford 松弛。
 * @param m      节点数（含时间原点）
 * @param edges  边集
 * @param init   初始距离（长度为 m 的数组）
 */
function bellmanFord(m: number, edges: DiffEdge[], init: number[]): BFResult {
  const dist = init.slice()
  const predEdge: (DiffEdge | null)[] = new Array(m).fill(null)
  let lastRelaxed: DiffEdge | null = null

  for (let round = 0; round < m; round++) {
    lastRelaxed = null
    let changed = false
    for (const e of edges) {
      const nd = dist[e.u] + e.w
      if (nd < dist[e.v]) {
        dist[e.v] = nd
        predEdge[e.v] = e
        changed = true
        lastRelaxed = e
      }
    }
    if (!changed) break
  }
  return { dist, predEdge, lastRelaxed }
}

/**
 * 从最后被松弛的边出发，沿前驱指针回溯，抽取一条负环。
 * 返回的 edges[i] 从 nodes[i] 指向 nodes[(i+1) % len]。
 */
function extractCycle(lastEdge: DiffEdge, predEdge: (DiffEdge | null)[]): {
  nodes: number[]
  edges: DiffEdge[]
} | null {
  const m = predEdge.length
  // 回溯到环上：最后松弛边的终点一定可达某个负环；先走 m 步入环
  let cur = lastEdge.v
  for (let i = 0; i < m; i++) {
    const pe = predEdge[cur]
    if (!pe) return null
    cur = pe.u
  }

  const cycleNodes: number[] = []
  const cycleEdges: DiffEdge[] = []
  const seenAt = new Map<number, number>()
  const start = cur
  // 从环上某点沿前驱方向收集（方向是反向环绕），直到再次遇到该点
  let guard = 0
  while (!seenAt.has(cur) && guard <= m) {
    seenAt.set(cur, cycleNodes.length)
    cycleNodes.push(cur)
    const pe = predEdge[cur]
    if (!pe) return null
    cycleEdges.push(pe)
    cur = pe.u
    guard++
  }
  if (cur !== start) {
    // 回溯路径中先经过了一段“环外尾巴”，裁掉尾巴
    const cut = seenAt.get(cur)!
    cycleNodes.splice(0, cut)
    cycleEdges.splice(0, cut)
  }
  // 当前 cycleEdges[i] 进入 cycleNodes[i]（来自 cycleNodes[i+1]，反向环绕）。
  // 反转节点与边的顺序，再把边数组循环左移一位，
  // 使最终 edges[i] 从 nodes[i] 指向 nodes[(i+1) % len]。
  cycleNodes.reverse()
  cycleEdges.reverse()
  if (cycleEdges.length > 1) {
    cycleEdges.push(cycleEdges.shift()!)
  }
  return { nodes: cycleNodes, edges: cycleEdges }
}

/** 从单个源点求最短路距离；不可达为 +∞（冗余证词审计复用同一差分图上的最短路） */
export function shortestFrom(source: number, m: number, edges: DiffEdge[]): number[] {
  const init = new Array(m).fill(INF)
  init[source] = 0
  const { dist } = bellmanFord(m, edges, init)
  return dist
}

/**
 * 超级源点 Bellman-Ford 检测负环：等价于加入一个指向所有节点、权重 0 的超级源点，
 * 即所有节点初始距离为 0（差分约束经典做法）。找到时抽取一条负环。
 */
export function findNegativeCycle(
  m: number,
  edges: DiffEdge[],
): { nodes: number[]; edges: DiffEdge[]; totalWeight: number } | null {
  if (m === 0) return null
  const { predEdge, lastRelaxed } = bellmanFord(m, edges, new Array(m).fill(0))
  if (!lastRelaxed) return null
  const cyc = extractCycle(lastRelaxed, predEdge)
  if (!cyc) return null
  return { nodes: cyc.nodes, edges: cyc.edges, totalWeight: cyc.edges.reduce((s, e) => s + e.w, 0) }
}

/**
 * 超级源点 Bellman-Ford 求一组可行势：返回值 h 满足对每条边 h[v] − h[u] ≤ w
 * （全部节点初始距离为 0，等价于引入指向所有节点、权重 0 的超级源点）。
 * 系统可满足时返回势数组（确定性：结果只取决于边集与边顺序），存在负环时返回 null。
 */
export function feasiblePotentials(m: number, edges: DiffEdge[]): number[] | null {
  if (m === 0) return []
  const { dist, lastRelaxed } = bellmanFord(m, edges, new Array(m).fill(0))
  return lastRelaxed ? null : dist
}

/**
 * 对当前全部启用的相对约束与绝对时间观测做统一分析：
 * 1) 在「相对约束边 + 观测边」的同一张图上用超级源点 Bellman-Ford 检测负环
 *    （矛盾可能完全来自相对约束，也可能由观测与约束共同构成）；
 * 2) 有负环时抽取一条矛盾环——环上的观测边与约束边即为完整矛盾链；
 * 3) 可满足时，以时间原点 t0 为源求各事件的最早/最晚绝对时间偏移。
 *    与 t0 正/反向均不可达（即未被任何观测连通）的事件标记为「无法定时」。
 */
export function analyze(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[] = [],
): AnalysisResult {
  const sys = buildSystem(events, constraints, observations)
  const { n, edges, originIdx, baseISO } = sys
  const windows = new Map<number, WindowInfo>()

  if (n === 0) {
    return { satisfiable: true, windows, baseISO }
  }

  // 节点总数 = 事件 + 时间原点
  const m = n + 1
  const cyc = findNegativeCycle(m, edges)
  if (cyc) {
    return { satisfiable: false, cycle: cyc, windows, baseISO }
  }

  if (baseISO === null) {
    // 没有任何有效观测：相对系统可能一致，但无法给出绝对时间窗
    for (let i = 0; i < n; i++) {
      windows.set(i, { status: 'disconnected', earliestOffset: null, latestOffset: null, directObservationIds: [] })
    }
    return { satisfiable: true, windows, baseISO }
  }

  // 最晚绝对偏移：t_i − t0 的最小上界（正向最短路）
  const upper = shortestFrom(originIdx, m, edges)
  // 最早绝对偏移：t0 − t_i 的最小上界取负（反向图最短路）
  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const back = shortestFrom(originIdx, m, reversed)

  // 直接夹在该事件上的观测（用于标注与零步证明）
  const direct = new Map<number, string[]>()
  for (const e of edges) {
    if (e.kind !== 'observation') continue
    if (e.v === originIdx) {
      // 下界边 e_event -> t0：事件端为 e.u
      const list = direct.get(e.u)
      if (list) list.push(e.observationId!)
      else direct.set(e.u, [e.observationId!])
    }
  }

  for (let i = 0; i < n; i++) {
    const hasUpper = Number.isFinite(upper[i])
    const hasLower = Number.isFinite(back[i])
    const earliest = hasLower ? -back[i] : null
    const latest = hasUpper ? upper[i] : null

    let status: WindowInfo['status']
    if (hasLower && hasUpper) status = 'bounded'
    else if (hasLower || hasUpper) status = 'oneSided'
    else status = 'disconnected'

    windows.set(i, {
      status,
      earliestOffset: earliest,
      latestOffset: latest,
      directObservationIds: direct.get(i) ?? [],
    })
  }

  return { satisfiable: true, cycle: undefined, windows, baseISO }
}

/**
 * 沿前驱指针从 target 回溯到 source，返回从 source 出发按行走顺序排列的边。
 * 系统可满足时前驱子图无环，必然在 m 步内到达 source；guard 仅为防御。
 */
function reconstructPath(
  predEdge: (DiffEdge | null)[],
  source: number,
  target: number,
): DiffEdge[] | null {
  const path: DiffEdge[] = []
  let cur = target
  let guard = 0
  while (cur !== source) {
    const pe = predEdge[cur]
    if (!pe) return null
    path.push(pe)
    cur = pe.u
    if (++guard > predEdge.length) return null
  }
  path.reverse()
  return path
}

/**
 * 边界依据追溯：还原“从时间原点推出某事件最早/最晚边界”的紧约束链。
 *
 * 前提：差分系统可满足（调用方保证，否则最短路无意义）且至少存在一条有效观测。
 * - 最晚边界：正向图上 t0 到目标的最短路，路径边依次为观测/约束的上界侧，
 *   累计偏移 = 路径权重前缀和（t_to − t0 的上界）；
 * - 最早边界：反向图上的最短路给出 t0 − t_to 的最小上界；
 *   反向路径上的每条边都还原为原始边（方向相反、权重与上/下界侧不变），
 *   累计偏移 = 路径权重前缀和取负（t_to − t0 的下界）。
 *
 * 事件被一条精确（零宽）观测直接钉住时返回零步证明（steps 为空，
 * directObservationId 指向该观测）；该侧无界 / 事件不可达 / 无观测时返回 null。
 */
export function traceBound(
  events: TEvent[],
  constraints: Constraint[],
  observations: TimeObservation[],
  eventIdx: number,
  kind: 'earliest' | 'latest',
): BoundTrace | null {
  const sys = buildSystem(events, constraints, observations)
  const { n, edges, originIdx, baseISO } = sys
  if (baseISO === null || eventIdx < 0 || eventIdx >= n) return null
  const m = n + 1

  const init = new Array(m).fill(INF)
  init[originIdx] = 0

  /** 在给定边集上求到 eventIdx 的最短路并构造追溯 */
  const run = (es: DiffEdge[], reverseWalk: boolean): BoundTrace | null => {
    const { dist, predEdge } = bellmanFord(m, es, init)
    if (!Number.isFinite(dist[eventIdx])) return null
    const chain = reconstructPath(predEdge, originIdx, eventIdx)
    if (!chain) return null
    let cum = 0
    const steps: BoundTraceStep[] = chain.map((re) => {
      cum += re.w
      if (!reverseWalk) {
        return { edge: re, from: re.u, to: re.v, cumulative: cum }
      }
      // re 是原始边 (u -> v, w) 的反向拷贝；本步从 v 走到 u，展示时还原为原始边
      const orig: DiffEdge = { ...re, u: re.v, v: re.u }
      return { edge: orig, from: re.u, to: re.v, cumulative: -cum }
    })
    return {
      eventIdx,
      kind,
      offset: reverseWalk ? -dist[eventIdx] : dist[eventIdx],
      steps,
      directObservationId: null,
    }
  }

  if (kind === 'latest') {
    const trace = run(edges, false)
    if (trace) return finalizeDirect(trace, observations, originIdx)
    return null
  }

  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const trace = run(reversed, true)
  if (trace) return finalizeDirect(trace, observations, originIdx)
  return null
}

/**
 * 零步证明归一：当追溯链只有一条「时间原点 → 事件」的精确观测边（lo = hi）时，
 * 退化为零步证明，记录直接钉住该事件的观测 id。
 */
function finalizeDirect(
  trace: BoundTrace,
  observations: TimeObservation[],
  originIdx: number,
): BoundTrace {
  if (trace.steps.length !== 1) return trace
  const st = trace.steps[0]
  if (st.edge.kind !== 'observation') return trace
  if (st.from !== originIdx && st.to !== originIdx) return trace
  const obs = observations.find((o) => o.id === st.edge.observationId)
  if (!obs || obs.start !== obs.end) return trace
  // 精确观测：最早与最晚为同一时刻，零步证明
  return { ...trace, steps: [], directObservationId: obs.id }
}
