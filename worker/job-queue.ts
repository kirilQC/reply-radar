export type JobName = "hydrate_conversation" | "reconcile_workspace" | "score_conversation" | "send_message";
export type DurableJob = { id: string; name: JobName; workspaceId: string; payload: Record<string, unknown>; attempts: number; runAt: string; status: "pending" | "running" | "complete" | "failed" };

/** Queue adapter contract. Implement with pg-boss or BullMQ in the worker deployment. */
export interface DurableQueue { enqueue(job: Omit<DurableJob, "id" | "attempts" | "status">): Promise<string>; acknowledge(jobId: string): Promise<void>; fail(jobId: string, error: string, retryAt: string): Promise<void>; }

export function eventKey(input: { conversationId?: string; messageId?: string; timestamp?: string }) { return [input.conversationId ?? "unknown", input.messageId ?? "unknown", input.timestamp ?? "unknown"].join(":"); }

export function shouldRetry(attempts: number, statusCode?: number) { return attempts < 5 && (statusCode === undefined || statusCode === 429 || statusCode >= 500); }
