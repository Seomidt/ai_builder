export interface AiLatencyRecord {
  model:       string;
  tenantId:    string;
  durationMs:  number;
  tokens?:     number;
  success:     boolean;
}

export function collectAiLatency(record: AiLatencyRecord): void {
  if (process.env.NODE_ENV === "development") {
    console.log("[metrics]", JSON.stringify(record));
  }
}
