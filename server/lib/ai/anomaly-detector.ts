export interface AnomalyDetectionResult {
  anomalyDetected: boolean;
  score:           number;
  reason?:         string;
}

export async function runAnomalyDetection(
  _tenantId: string,
  _periodId: string,
): Promise<AnomalyDetectionResult> {
  return { anomalyDetected: false, score: 0 };
}
