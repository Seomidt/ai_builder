export async function recordUsageRecordedEvent(
  _tenantId:   string,
  _usageId:    string,
  _amountUsd?: number,
): Promise<void> {}

export async function recordRequestStartedEvent(
  _requestId: string,
  _tenantId:  string,
): Promise<void> {}

export async function recordProviderCallStartedEvent(
  _requestId: string,
  _provider:  string,
): Promise<void> {}

export async function recordRequestCompletedEvent(
  _requestId: string,
  _tenantId:  string,
  _tokens?:   number,
): Promise<void> {}

export async function recordRequestReplayedEvent(
  _requestId: string,
  _tenantId:  string,
): Promise<void> {}

export async function recordCacheHitReplayedEvent(
  _requestId: string,
  _cacheKey:  string,
): Promise<void> {}
