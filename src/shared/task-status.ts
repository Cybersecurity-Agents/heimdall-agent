/** Task outcome is separate from the result of an individual attempt. */
export type TaskStatus = {
  state: "pending" | "running" | "retry_wait" | "succeeded" | "unfinished" | "idle";
  reason: string;
  job_kind: string;
  loop_n: number;
  retry_kind: "loop" | "regular";
};
