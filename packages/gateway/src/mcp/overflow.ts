// 受控 MCP 超长输出溢出缓存（第 2.3-R 步）：
// - 全部仅保存在内存中，使用随机短 ID（out_xxxxxxxxxxxx），绝不暴露任何本机文件路径；
// - 严格按 taskId 隔离，任务删除或 TTL 到期自动清除；
// - 单条与总容量双封顶，所有切片均做 UTF-16 代理对安全对齐，不劈断表情与生僻汉字。
import { randomBytes } from 'node:crypto';

export const MCP_OVERFLOW_MAX_ENTRY_CHARS = 512 * 1024;
export const MCP_OVERFLOW_MAX_TOTAL_CHARS = 4 * 1024 * 1024;
export const MCP_OVERFLOW_TTL_MS = 30 * 60_000;
export const MCP_OVERFLOW_MAX_READ_CHARS = 8_000;

export interface McpOverflowEntry {
  id: string;
  taskId: string;
  serverName: string;
  toolName: string;
  content: string;
  originalChars: number;
  clipped: boolean;
  createdAt: number;
  lastReadAt: number;
}

export interface McpOverflowReadResult {
  id: string;
  serverName: string;
  toolName: string;
  slice: string;
  offset: number;
  endOffset: number;
  nextOffset: number | null;
  storedChars: number;
  originalChars: number;
  clipped: boolean;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-16 代理对安全前切：不劈断 emoji 或扩展区汉字。 */
export function safeSliceHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end -= 1;
  }
  return text.slice(0, end);
}

/** UTF-16 代理对安全后切：不劈断 emoji 或扩展区汉字。 */
export function safeSliceTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start += 1;
  }
  return text.slice(start);
}

/** UTF-16 代理对安全区间切分：返回对齐后的起止下标与文本片段。 */
export function safeSliceRange(text: string, rawStart: number, rawLimit: number): { start: number; end: number; slice: string } {
  const len = text.length;
  let start = Math.max(0, Math.min(len, Math.floor(rawStart)));
  if (start > 0 && start < len && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start += 1;
  }
  const limit = Math.max(1, Math.floor(rawLimit));
  let end = Math.min(len, start + limit);
  if (end > start && end < len && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end -= 1;
  }
  return { start, end, slice: text.slice(start, end) };
}

export class McpOverflowStore {
  private entries = new Map<string, McpOverflowEntry>();
  private totalChars = 0;

  constructor(
    private opts: {
      maxEntryChars?: number;
      maxTotalChars?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private ttlMs(): number {
    return this.opts.ttlMs ?? MCP_OVERFLOW_TTL_MS;
  }

  private maxEntryChars(): number {
    return this.opts.maxEntryChars ?? MCP_OVERFLOW_MAX_ENTRY_CHARS;
  }

  private maxTotalChars(): number {
    return this.opts.maxTotalChars ?? MCP_OVERFLOW_MAX_TOTAL_CHARS;
  }

  private pruneExpired(): void {
    const cutoff = this.clock() - this.ttlMs();
    for (const [id, entry] of this.entries) {
      if (entry.lastReadAt < cutoff) {
        this.entries.delete(id);
        this.totalChars = Math.max(0, this.totalChars - entry.content.length);
      }
    }
  }

  /** 将已脱敏的超长 MCP 返回暂存到任务级沙盒缓存，返回不透明短 ID。 */
  put(input: { taskId: string; serverName: string; toolName: string; content: string }): {
    id: string;
    storedChars: number;
    originalChars: number;
    clipped: boolean;
  } {
    this.pruneExpired();
    const originalChars = input.content.length;
    const maxEntry = this.maxEntryChars();
    const clipped = originalChars > maxEntry;
    const content = clipped ? safeSliceHead(input.content, maxEntry) : input.content;

    // LRU 淘汰最久未读记录，确保总内存严格封顶
    const maxTotal = this.maxTotalChars();
    while (this.entries.size > 0 && this.totalChars + content.length > maxTotal) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      const old = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (old) this.totalChars = Math.max(0, this.totalChars - old.content.length);
    }

    const id = `out_${randomBytes(6).toString('hex')}`;
    const ts = this.clock();
    this.entries.set(id, {
      id,
      taskId: input.taskId,
      serverName: input.serverName,
      toolName: input.toolName,
      content,
      originalChars,
      clipped,
      createdAt: ts,
      lastReadAt: ts,
    });
    this.totalChars += content.length;
    return { id, storedChars: content.length, originalChars, clipped };
  }

  /** 按任务隔离读取溢出内容的分页切片（每次上限 8,000 字符）。 */
  read(taskId: string, outputId: string, offset = 0, limit = MCP_OVERFLOW_MAX_READ_CHARS): McpOverflowReadResult | null {
    this.pruneExpired();
    const entry = this.entries.get(outputId);
    if (!entry || entry.taskId !== taskId) return null;

    // 刷新 LRU 顺序
    entry.lastReadAt = this.clock();
    this.entries.delete(outputId);
    this.entries.set(outputId, entry);

    const safeLimit = Math.max(1, Math.min(MCP_OVERFLOW_MAX_READ_CHARS, Number.isFinite(limit) ? Math.floor(limit) : MCP_OVERFLOW_MAX_READ_CHARS));
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const { start, end, slice } = safeSliceRange(entry.content, safeOffset, safeLimit);

    return {
      id: entry.id,
      serverName: entry.serverName,
      toolName: entry.toolName,
      slice,
      offset: start,
      endOffset: end,
      nextOffset: end < entry.content.length ? end : null,
      storedChars: entry.content.length,
      originalChars: entry.originalChars,
      clipped: entry.clipped,
    };
  }

  hasForTask(taskId: string): boolean {
    this.pruneExpired();
    for (const entry of this.entries.values()) {
      if (entry.taskId === taskId) return true;
    }
    return false;
  }

  clearTask(taskId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.taskId === taskId) {
        this.entries.delete(id);
        this.totalChars = Math.max(0, this.totalChars - entry.content.length);
      }
    }
  }

  clearAll(): void {
    this.entries.clear();
    this.totalChars = 0;
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }
}
