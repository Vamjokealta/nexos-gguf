/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { NexusDb } from './db.ts';
import { QueueItem } from './types.ts';

export class QueueManager {
  private db: NexusDb;
  private isProcessing = false;
  private isPaused = false;
  private activeTask: QueueItem | null = null;
  private userCooldowns: Map<number, number> = new Map(); // userId -> lastRequestTimeMs

  constructor(db: NexusDb) {
    this.db = db;
    // Auto-recover any tasks left in PROCESSING from prior crash
    const recovered = this.db.recoverPendingQueue();
    if (recovered > 0) {
      this.db.logAudit('QUEUE_RECOVERY', 'INFO', `Restored ${recovered} interrupted tasks back to QUEUED status.`);
    }
  }

  public enqueue(
    rawText: string,
    source: 'telegram_bot' | 'telegram_user' | 'web_dashboard',
    chatId = 0,
    userId = 0,
    messageId = 0,
    priority = 5
  ): { success: boolean; taskId?: string; reason?: string } {
    // Check cooldown for non-dashboard sources (e.g., 2 seconds cooldown between messages per user)
    if (userId > 0) {
      const lastTime = this.userCooldowns.get(userId) || 0;
      const now = Date.now();
      if (now - lastTime < 1500) {
        return { success: false, reason: 'Rate limit: Cooldown in effect. Please wait a moment.' };
      }
      this.userCooldowns.set(userId, now);
    }

    const taskId = 'task_' + Math.random().toString(36).substring(2, 10);
    const deduplicationHash = `${rawText.trim().toLowerCase()}_${source}_${chatId}`;

    const res = this.db.enqueueTask({
      taskId,
      source,
      chatId,
      userId,
      messageId,
      rawText,
      priority,
      status: 'QUEUED',
      retryCount: 0,
      maxRetries: 3,
      errorLog: null,
      deduplicationHash,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    if (res.success) {
      this.db.logAudit('TASK_ENQUEUED', 'INFO', `Task ${taskId} added to queue (priority=${priority}, source=${source}).`);
      // Trigger processor loop if idle
      this.processNext();
      return { success: true, taskId };
    } else {
      return { success: false, reason: res.reason };
    }
  }

  public pause(): void {
    this.isPaused = true;
    this.db.logAudit('QUEUE_PAUSE', 'INFO', 'Queue processing paused by user.');
  }

  public resume(): void {
    this.isPaused = false;
    this.db.logAudit('QUEUE_RESUME', 'INFO', 'Queue processing resumed.');
    this.processNext();
  }

  public isQueuePaused(): boolean {
    return this.isPaused;
  }

  public getActiveTask(): QueueItem | null {
    return this.activeTask;
  }

  public clearFinished(): void {
    this.db.db.exec(`DELETE FROM queue_items WHERE status IN ('COMPLETED', 'FAILED', 'CANCELLED');`);
    this.db.logAudit('QUEUE_CLEARED', 'INFO', 'Cleared completed and failed items from queue.');
  }

  public retryTask(taskId: string): boolean {
    const row = this.db.db.prepare(`SELECT * FROM queue_items WHERE task_id = ?`).get(taskId) as any;
    if (!row) return false;

    this.db.db.prepare(`
      UPDATE queue_items
      SET status = 'QUEUED', retry_count = 0, error_log = NULL, started_at = NULL
      WHERE task_id = ?
    `).run(taskId);

    this.db.logAudit('TASK_MANUAL_RETRY', 'INFO', `Task ${taskId} manually reset to QUEUED.`);
    this.processNext();
    return true;
  }

  public cancelTask(taskId: string): boolean {
    const info = this.db.db.prepare(`
      UPDATE queue_items
      SET status = 'CANCELLED', completed_at = ?
      WHERE task_id = ? AND status = 'QUEUED'
    `).run(Date.now(), taskId);

    if (info.changes > 0) {
      this.db.logAudit('TASK_CANCELLED', 'INFO', `Task ${taskId} cancelled.`);
      return true;
    }
    return false;
  }

  public getQueueStats(): {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    isPaused: boolean;
    activeTask: QueueItem | null;
  } {
    const rows = this.db.db.prepare(`
      SELECT status, count(*) as count FROM queue_items GROUP BY status
    `).all() as { status: string; count: number }[];

    let pending = 0;
    let processing = 0;
    let completed = 0;
    let failed = 0;

    for (const r of rows) {
      if (r.status === 'QUEUED') pending = r.count;
      else if (r.status === 'PROCESSING') processing = r.count;
      else if (r.status === 'COMPLETED') completed = r.count;
      else if (r.status === 'FAILED') failed = r.count;
    }

    return {
      pending,
      processing,
      completed,
      failed,
      isPaused: this.isPaused,
      activeTask: this.activeTask,
    };
  }

  /**
   * Sequential worker loop: ensures strictly ONE AI task executes at a time
   */
  public async processNext(): Promise<void> {
    if (this.isProcessing || this.isPaused) return;

    const task = this.db.pollNextTask();
    if (!task) return;

    this.isProcessing = true;
    this.activeTask = task;

    try {
      // In Phase 1: Verify the task and complete or delegate
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!this.db.db.open) return;
      this.db.completeTask(task.taskId, true);
    } catch (err: any) {
      if (!this.db.db.open) return;
      this.db.completeTask(task.taskId, false, err?.message || 'Processing failed');
    } finally {
      this.activeTask = null;
      this.isProcessing = false;
      if (this.db.db.open && !this.isPaused) {
        setImmediate(() => this.processNext());
      }
    }
  }

  public stop(): void {
    this.isPaused = true;
  }
}
