/**
 * 批量证词导入 DSL 解析器
 *
 * 支持三类语句（每行一条；空行与以 # 开头的整行注释被忽略）：
 *
 *   EVENT "名称" | "备注"
 *   REL   "A" earlier|later "B" min..max
 *   OBS   "事件" start..end
 *
 * - 名称与备注均为 JSON 字符串（完整 JSON 转义：\n、中 等）；
 * - min/max 为非负整数且 min ≤ max；
 * - start/end 为 yyyy-MM-ddTHH:mm（也接受空格分隔的 yyyy-MM-dd HH:mm），end ≥ start；
 * - 事件名引用可指向现有事件或同批 EVENT 声明。
 *
 * 解析分两阶段：逐行语法解析 → 全局语义校验（重名/重复声明、引用不唯一/不存在、
 * REL 自引用、非法区间）。任何一行存在错误都禁止写入。
 */
import type { Constraint, Relation, TEvent, TimeObservation } from '../types'
import { uid } from './samples'

// ==================== 类型 ====================

export type DslStatementKind = 'event' | 'constraint' | 'observation'

export interface DslEventStmt {
  kind: 'event'
  name: string
  note: string
}

export interface DslConstraintStmt {
  kind: 'constraint'
  aName: string
  relation: Relation
  bName: string
  min: number
  max: number
}

export interface DslObservationStmt {
  kind: 'observation'
  eventName: string
  start: string
  end: string
}

export type DslStatement = DslEventStmt | DslConstraintStmt | DslObservationStmt

/** 一条定位到原始行号的解析/校验错误 */
export interface DslError {
  /** 原始行号（从 1 开始） */
  line: number
  message: string
}

/** 引用解析结果（语义阶段填写；存在错误时为空） */
export interface DslRefTarget {
  /** 命中的事件名（规范化后） */
  name: string
  /** 命中现有事件（否则由同批 EVENT 提供） */
  existing: boolean
}

/** 一条非空、非注释语句的解析结果（语法错误时 statement 为 null） */
export interface DslLineResult {
  line: number
  /** 原始文本（去首尾空白后），用于预览展示 */
  text: string
  kind: DslStatementKind | null
  statement: DslStatement | null
  /** 该语句上的错误（一般至多一条） */
  errors: DslError[]
  /** 引用目标（仅在无任何错误时才有意义） */
  targets: Partial<Record<'a' | 'b' | 'event', DslRefTarget>>
}

export interface DslParseResult {
  lines: DslLineResult[]
  errors: DslError[]
  /** 同批 EVENT 名称（保持声明顺序） */
  newEventNames: string[]
  /** 按语句顺序展开的事件声明 */
  events: DslEventStmt[]
  constraints: DslConstraintStmt[]
  observations: DslObservationStmt[]
}

/** 解析成功后可直接合并进 AppState 的实体（id 已生成） */
export interface DslImportEntities {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
  /** 事件名（现有事件或新增事件）-> id */
  eventIdByName: Map<string, string>
}

// ==================== JSON 字符串词法 ====================

/**
 * 从 s[start] === '"' 起读取一个 JSON 字符串字面量。
 * 返回解析后的值与结束引号后的下标；失败返回错误信息。
 */
function readJsonString(
  s: string,
  start: number,
): { value: string; next: number } | { error: string } {
  let i = start + 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"') {
      const token = s.slice(start, i + 1)
      try {
        const value = JSON.parse(token)
        if (typeof value !== 'string') return { error: '字符串解析结果不是字符串' }
        return { value, next: i + 1 }
      } catch (e) {
        return { error: `非法 JSON 字符串：${(e as Error).message}` }
      }
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    // 裸控制字符（含未转义换行，理论上按行拆分不会出现）在 JSON 中非法
    if (ch.charCodeAt(0) < 0x20) {
      return { error: '字符串中包含未转义的控制字符（换行需写成 \\n）' }
    }
    i++
  }
  return { error: '字符串缺少结束引号（"）' }
}

/** 跳过空白；返回新下标 */
function skipSpaces(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

// ==================== 数值与时间 ====================

/** 解析非负整数分钟区间 "min..max"（".." 两侧空白自由）；返回 { min, max, next } 或错误 */
function readRange(s: string, from: number): { min: number; max: number; next: number } | { error: string } {
  const m = /^(\d+)\s*\.\.\s*(\d+)/.exec(s.slice(from))
  if (!m) {
    return { error: '分钟区间格式应为 非负整数..非负整数，例如 5..30' }
  }
  const min = Number(m[1])
  const max = Number(m[2])
  if (min > max) {
    return { error: `非法区间：最小值 ${min} 大于最大值 ${max}` }
  }
  return { min, max, next: from + m[0].length }
}

/**
 * 解析观测时间区间 "start..end"。
 * 接受 yyyy-MM-ddTHH:mm 与 yyyy-MM-dd HH:mm，内部统一为 T 分隔；
 * 同时严格校验日历合法性（如 2026-02-30 拒绝）与 end ≥ start。
 */
function readTimeRange(s: string, from: number): { start: string; end: string; next: number } | { error: string } {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})\s*\.\.\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(
      s.slice(from),
    )
  if (!m) {
    return { error: '时间区间格式应为 yyyy-MM-ddTHH:mm..yyyy-MM-ddTHH:mm（日期与时间之间也可用空格）' }
  }
  const norm = (p: number) => `${m[p]}-${m[p + 1]}-${m[p + 2]}T${m[p + 3]}:${m[p + 4]}`
  const start = norm(1)
  const end = norm(6)
  const startValid = validDateTime(m[1], m[2], m[3], m[4], m[5])
  const endValid = validDateTime(m[6], m[7], m[8], m[9], m[10])
  if (!startValid) return { error: `时间格式非法：${start} 不是有效的日期时间` }
  if (!endValid) return { error: `时间格式非法：${end} 不是有效的日期时间` }
  if (new Date(end).getTime() < new Date(start).getTime()) {
    return { error: `非法区间：观测终点 ${end} 早于起点 ${start}` }
  }
  return { start, end, next: from + m[0].length }
}

/** 严格校验年月日时分（含大小月与闰年） */
function validDateTime(yStr: string, moStr: string, dStr: string, hStr: string, miStr: string): boolean {
  const y = Number(yStr)
  const mo = Number(moStr)
  const d = Number(dStr)
  const h = Number(hStr)
  const mi = Number(miStr)
  if (mo < 1 || mo > 12) return false
  if (h > 23 || mi > 59) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return d >= 1 && d <= days[mo - 1]
}

// ==================== 逐行语法解析 ====================

/** 读取一个 JSON 字符串参数：要求当前位置（跳过空白后）紧接引号 */
function readStringParam(
  s: string,
  from: number,
  label: string,
): { value: string; next: number } | { error: string } {
  const i = skipSpaces(s, from)
  if (i >= s.length) return { error: `缺少${label}（JSON 字符串，需用双引号包裹）` }
  if (s[i] !== '"') return { error: `${label}必须是以双引号包裹的 JSON 字符串` }
  return readJsonString(s, i)
}

/** 要求下一个非空白片段为期望值（如 "|"、"earlier"） */
function expectToken(s: string, from: number, token: string): { next: number } | { error: string } {
  const i = skipSpaces(s, from)
  if (s.startsWith(token, i)) {
    // 关键字型 token 需避免关键字前缀匹配（如 earlierx）；符号型（|）无妨
    const after = i + token.length
    if (/[A-Za-z]/.test(token[0]) && after < s.length && /[A-Za-z]/.test(s[after])) {
      return { error: `无法识别的内容：${restSnippet(s, i)}` }
    }
    return { next: after }
  }
  return { error: `此处应为 "${token}"` }
}

/** 要求读到关键字 earlier/later */
function readRelation(s: string, from: number): { relation: Relation; next: number } | { error: string } {
  const i = skipSpaces(s, from)
  if (s.startsWith('earlier', i) && !/[A-Za-z]/.test(s[i + 7] ?? '')) {
    return { relation: 'earlier', next: i + 7 }
  }
  if (s.startsWith('later', i) && !/[A-Za-z]/.test(s[i + 5] ?? '')) {
    return { relation: 'later', next: i + 5 }
  }
  return { error: '关系方向必须为 earlier（早于）或 later（晚于）' }
}

/** 确保行尾（除空白外）没有多余内容 */
function expectEnd(s: string, from: number): { next: number } | { error: string } {
  const i = skipSpaces(s, from)
  if (i < s.length) return { error: `无法识别的尾部内容：${restSnippet(s, i)}` }
  return { next: i }
}

function restSnippet(s: string, i: number): string {
  const t = s.slice(i).trim()
  return t.length > 20 ? `${t.slice(0, 20)}…` : t
}

function parseLine(text: string): { kind: DslStatementKind; statement: DslStatement } | { error: string } {
  let i = 0
  const kwMatch = /^(EVENT|REL|OBS)\b/.exec(text)
  if (!kwMatch) {
    return { error: '语句必须以 EVENT、REL 或 OBS 开头' }
  }
  const kw = kwMatch[1]
  i = kw.length

  if (kw === 'EVENT') {
    // EVENT "名称" | "备注"（备注允许为空字符串；整条竖线与备注可省略？——按 DSL 定义要求提供）
    const nameR = readStringParam(text, i, '事件名称')
    if ('error' in nameR) return nameR
    i = nameR.next
    const barR = expectToken(text, i, '|')
    if ('error' in barR) return barR
    i = barR.next
    const noteR = readStringParam(text, i, '备注')
    if ('error' in noteR) return noteR
    i = noteR.next
    const endR = expectEnd(text, i)
    if ('error' in endR) return endR
    if (!nameR.value.trim()) return { error: '事件名称不能为空（JSON 字符串需包含非空白字符）' }
    return { kind: 'event', statement: { kind: 'event', name: nameR.value, note: noteR.value } }
  }

  if (kw === 'REL') {
    // REL "A" earlier|later "B" min..max
    const aR = readStringParam(text, i, '事件 A 名称')
    if ('error' in aR) return aR
    i = aR.next
    const relR = readRelation(text, i)
    if ('error' in relR) return relR
    i = relR.next
    const bR = readStringParam(text, i, '事件 B 名称')
    if ('error' in bR) return bR
    i = bR.next
    const rangeR = readRange(text, skipSpaces(text, i))
    if ('error' in rangeR) return rangeR
    i = rangeR.next
    const endR = expectEnd(text, i)
    if ('error' in endR) return endR
    if (!aR.value.trim()) return { error: '事件 A 名称不能为空' }
    if (!bR.value.trim()) return { error: '事件 B 名称不能为空' }
    return {
      kind: 'constraint',
      statement: {
        kind: 'constraint',
        aName: aR.value,
        relation: relR.relation,
        bName: bR.value,
        min: rangeR.min,
        max: rangeR.max,
      },
    }
  }

  // OBS "事件" start..end
  const evR = readStringParam(text, i, '事件名称')
  if ('error' in evR) return evR
  i = evR.next
  const tr = readTimeRange(text, skipSpaces(text, i))
  if ('error' in tr) return tr
  i = tr.next
  const endR = expectEnd(text, i)
  if ('error' in endR) return endR
  if (!evR.value.trim()) return { error: '事件名称不能为空' }
  return {
    kind: 'observation',
    statement: { kind: 'observation', eventName: evR.value, start: tr.start, end: tr.end },
  }
}

// ==================== 语义校验与总入口 ====================

/**
 * 解析整段 DSL 文本。
 * @param text     用户粘贴的多行文本
 * @param existing 现有事件（用于重名检测与引用解析）
 */
export function parseDsl(text: string, existing: TEvent[] = []): DslParseResult {
  const rawLines = text.split(/\r\n|\r|\n/)
  const lines: DslLineResult[] = []
  const errors: DslError[] = []

  // —— 第一阶段：逐行语法解析（空行与整行注释忽略）——
  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    const r = parseLine(trimmed)
    if ('error' in r) {
      const le: DslError = { line: lineNo, message: r.error }
      errors.push(le)
      lines.push({ line: lineNo, text: trimmed, kind: null, statement: null, errors: [le], targets: {} })
      return
    }
    lines.push({ line: lineNo, text: trimmed, kind: r.kind, statement: r.statement, errors: [], targets: {} })
  })

  // —— 第二阶段：语义校验 ——
  // 2a) 现有事件按名称分组：重名的现有事件会让引用「不唯一」
  const existingByName = new Map<string, TEvent[]>()
  for (const e of existing) {
    const list = existingByName.get(e.name)
    if (list) list.push(e)
    else existingByName.set(e.name, [e])
  }

  // 同批 EVENT：重名（含与现有事件同名）一律按「重复声明」拒绝，避免覆盖现有数据
  const newEventNames: string[] = []
  const declaredLine = new Map<string, number>()
  for (const ln of lines) {
    if (ln.kind !== 'event' || !ln.statement) continue
    const st = ln.statement as DslEventStmt
    if (declaredLine.has(st.name)) {
      pushLineError(errors, ln, `事件「${st.name}」在本批中重复声明（首次声明于第 ${declaredLine.get(st.name)} 行）`)
      continue
    }
    if (existingByName.has(st.name)) {
      pushLineError(errors, ln, `事件「${st.name}」与现有事件重名；批量导入不会覆盖现有事件，如需引用请直接使用现有名称`)
      continue
    }
    declaredLine.set(st.name, ln.line)
    newEventNames.push(st.name)
  }

  /** 把一个引用名称解析为唯一目标；失败时在对应行登记错误 */
  const resolveName = (ln: DslLineResult, slot: 'a' | 'b' | 'event', name: string): boolean => {
    const ex = existingByName.get(name)
    if (ex && ex.length > 1) {
      pushLineError(errors, ln, `引用不唯一：现有事件中存在 ${ex.length} 个名为「${name}」的事件，请先在事件列表中消除重名`)
      return false
    }
    if (ex) {
      ln.targets[slot] = { name, existing: true }
      return true
    }
    if (declaredLine.has(name)) {
      ln.targets[slot] = { name, existing: false }
      return true
    }
    pushLineError(errors, ln, `引用不存在：事件「${name}」既不在现有事件中，也未在本批使用 EVENT 声明`)
    return false
  }

  for (const ln of lines) {
    if (!ln.statement) continue
    const st = ln.statement
    if (st.kind === 'constraint') {
      const okA = resolveName(ln, 'a', st.aName)
      const okB = resolveName(ln, 'b', st.bName)
      if (okA && okB && st.aName === st.bName) {
        pushLineError(errors, ln, '时序约束的事件 A 与事件 B 不能指向同一事件')
      }
    } else if (st.kind === 'observation') {
      resolveName(ln, 'event', st.eventName)
    }
  }

  // 错误统一按原始行号排序（同一行内保持登记顺序）
  errors.sort((x, y) => x.line - y.line)

  const events: DslEventStmt[] = []
  const constraints: DslConstraintStmt[] = []
  const observations: DslObservationStmt[] = []
  for (const ln of lines) {
    if (!ln.statement || ln.errors.length > 0) continue
    const st = ln.statement
    if (st.kind === 'event') events.push(st)
    else if (st.kind === 'constraint') constraints.push(st)
    else observations.push(st)
  }

  return { lines, errors, newEventNames, events, constraints, observations }
}

function pushLineError(errors: DslError[], ln: DslLineResult, message: string) {
  const e: DslError = { line: ln.line, message }
  ln.errors.push(e)
  errors.push(e)
}

// ==================== 实体构建（确认后调用） ====================

/**
 * 把解析成功（无任何错误）的 DSL 结果转为可持久化实体。
 * 新事件、约束与观测均生成新 id；引用到的现有事件复用其 id。
 */
export function buildImportEntities(
  parsed: DslParseResult,
  existing: TEvent[] = [],
): DslImportEntities {
  const eventIdByName = new Map<string, string>()
  for (const e of existing) eventIdByName.set(e.name, e.id)

  const events: TEvent[] = []
  for (const st of parsed.events) {
    const ev: TEvent = { id: uid('ev'), name: st.name, note: st.note || undefined }
    events.push(ev)
    eventIdByName.set(st.name, ev.id)
  }

  const constraints: Constraint[] = parsed.constraints.map((st) => ({
    id: uid('ct'),
    aId: eventIdByName.get(st.aName)!,
    bId: eventIdByName.get(st.bName)!,
    relation: st.relation,
    min: st.min,
    max: st.max,
    enabled: true,
  }))

  const observations: TimeObservation[] = parsed.observations.map((st) => ({
    id: uid('obs'),
    eventId: eventIdByName.get(st.eventName)!,
    start: st.start,
    end: st.end,
  }))

  return { events, constraints, observations, eventIdByName }
}
