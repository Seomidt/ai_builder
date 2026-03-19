import { listDnsRecords, updateDnsRecord, DnsRecord } from "./client";

export interface DnsVerificationResult {
  checked: number;
  updated: number;
  allProxied: boolean;
  records: { name: string; type: string; proxied: boolean; updated: boolean }[];
}

export async function verifyProxyEnabled(): Promise<DnsVerificationResult> {
  console.log("[CF:DNS] Verifying proxy status on A/CNAME records...");

  const all = await listDnsRecords();
  const candidates = all.filter(
    (r) => (r.type === "A" || r.type === "AAAA" || r.type === "CNAME") &&
      (r.name === "@" ||
       r.name.startsWith("www.") ||
       !r.name.includes(".") ||
       r.name.split(".").length <= 3)
  );

  const result: DnsVerificationResult["records"] = [];
  let updated = 0;

  for (const rec of candidates) {
    if (!rec.proxied) {
      console.log(`[CF:DNS] ${rec.type} ${rec.name} — proxied=false, enabling...`);
      try {
        await updateDnsRecord(rec.id, { proxied: true });
        result.push({ name: rec.name, type: rec.type, proxied: true, updated: true });
        updated++;
        console.log(`[CF:DNS] ${rec.name} proxied=true ✔`);
      } catch (err) {
        console.error(`[CF:DNS] Failed to proxy ${rec.name}: ${(err as Error).message}`);
        result.push({ name: rec.name, type: rec.type, proxied: false, updated: false });
      }
    } else {
      result.push({ name: rec.name, type: rec.type, proxied: true, updated: false });
      console.log(`[CF:DNS] ${rec.type} ${rec.name} — proxied=true ✔`);
    }
  }

  const allProxied = result.every((r) => r.proxied);
  if (!allProxied) {
    const failed = result.filter((r) => !r.proxied).map((r) => r.name);
    console.warn(`[CF:DNS] Some records could not be proxied: ${failed.join(", ")}`);
  }

  return { checked: candidates.length, updated, allProxied, records: result };
}
