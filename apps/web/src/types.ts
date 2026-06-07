export interface RunEvent {
  type: string;
  runId: string;
  ts: number;
  payload: Record<string, unknown>;
}
