/**
 * LLM08-F1: Rate limiter for MCP write operations.
 *
 * Enforces a per-user daily limit on write operations (create, update, categorize)
 * performed through MCP tools to prevent an external AI tool from making
 * excessive modifications to financial data.
 */

export interface WriteOperation {
  userId: string;
  tool: string;
  timestamp: number;
}

/**
 * Maximum number of write operations per user per day via MCP.
 */
export const MCP_DAILY_WRITE_LIMIT = 50;

export class McpWriteLimiter {
  private readonly operations: WriteOperation[] = [];

  /**
   * Check whether a user has remaining write quota for today.
   * Returns { allowed: true } if under the limit, or { allowed: false }
   * with the current count and limit if exceeded.
   */
  checkLimit(userId: string): {
    allowed: boolean;
    currentCount: number;
    limit: number;
  } {
    this.pruneExpired();
    const dayStart = this.getDayStart();
    const currentCount = this.operations.filter(
      (op) => op.userId === userId && op.timestamp >= dayStart,
    ).length;

    return {
      allowed: currentCount < MCP_DAILY_WRITE_LIMIT,
      currentCount,
      limit: MCP_DAILY_WRITE_LIMIT,
    };
  }

  /**
   * Record a write operation for rate limiting purposes.
   */
  record(userId: string, tool: string): void {
    this.operations.push({
      userId,
      tool,
      timestamp: Date.now(),
    });
  }

  /**
   * Remove operations older than 24 hours to prevent unbounded memory growth.
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let i = 0;
    while (
      i < this.operations.length &&
      this.operations[i].timestamp < cutoff
    ) {
      i++;
    }
    if (i > 0) {
      this.operations.splice(0, i);
    }
  }

  /**
   * Get the start of the current UTC day in milliseconds.
   */
  private getDayStart(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}
