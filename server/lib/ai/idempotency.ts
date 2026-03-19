export interface AiRequestRecord {
  requestId:  string;
  tenantId:   string;
  status:     "pending" | "completed" | "failed";
  ownedBy?:   string;
  createdAt:  Date;
}

export async function beginAiRequest(
  _requestId: string,
  _tenantId:  string,
  _ownedBy:   string,
): Promise<AiRequestRecord> {
  return { requestId: _requestId, tenantId: _tenantId, status: "pending", createdAt: new Date() };
}

export async function markAiRequestCompleted(_requestId: string): Promise<void> {}
export async function markAiRequestFailed(_requestId: string, _reason?: string): Promise<void> {}
export async function releaseAiRequestOwnership(_requestId: string): Promise<void> {}
