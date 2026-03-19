export interface CachedResponse {
  cacheKey: string;
  response: unknown;
  model:    string;
  cachedAt: Date;
}

export async function lookupCachedResponse(
  _cacheKey: string,
): Promise<CachedResponse | null> {
  return null;
}

export async function storeCachedResponse(
  _cacheKey: string,
  _model: string,
  _response: unknown,
): Promise<void> {
  return;
}
