export async function maybeRecordAiBillingUsage(
  _tenantId: string,
  _tokens:   number,
  _costUsd:  number,
): Promise<void> {
  // Billing integration not configured
}
