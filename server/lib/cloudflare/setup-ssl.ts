import { updateZoneSetting, getZoneSetting, ZoneSetting } from "./client";

export interface SslVerification {
  ssl: boolean;
  alwaysHttps: boolean;
  hsts: boolean;
  details: { ssl: unknown; alwaysHttps: unknown; hsts: unknown };
}

export async function setupSSL(): Promise<SslVerification> {
  console.log("[CF:SSL] Applying SSL & transport hardening...");

  // 1. SSL mode: strict
  await updateZoneSetting("ssl", "strict");
  console.log("[CF:SSL] ssl = strict ✔");

  // 2. Always use HTTPS
  await updateZoneSetting("always_use_https", "on");
  console.log("[CF:SSL] always_use_https = on ✔");

  // 3. HSTS
  await updateZoneSetting("security_header", {
    strict_transport_security: {
      enabled: true,
      max_age: 15552000,
      include_subdomains: true,
      preload: false,
      nosniff: true,
    },
  });
  console.log("[CF:SSL] HSTS configured ✔");

  // 4. Min TLS 1.2
  try {
    await updateZoneSetting("min_tls_version", "1.2");
    console.log("[CF:SSL] min_tls_version = 1.2 ✔");
  } catch (err) {
    console.warn("[CF:SSL] min_tls_version skipped:", (err as Error).message);
  }

  // 5. TLS 1.3
  try {
    await updateZoneSetting("tls_1_3", "zrt");
    console.log("[CF:SSL] tls_1_3 = zrt ✔");
  } catch (err) {
    console.warn("[CF:SSL] tls_1_3 skipped:", (err as Error).message);
  }

  // Verify
  const [sslSetting, httpsSetting, hstsSetting] = await Promise.all([
    getZoneSetting("ssl"),
    getZoneSetting("always_use_https"),
    getZoneSetting("security_header"),
  ]);

  const sslOk = (sslSetting as ZoneSetting).value === "strict";
  const httpsOk = (httpsSetting as ZoneSetting).value === "on";
  const hstsValue = (hstsSetting as ZoneSetting).value as Record<string, unknown> | undefined;
  const hstsOk = !!(hstsValue?.strict_transport_security as Record<string, unknown> | undefined)?.enabled;

  if (!sslOk) throw new Error("[CF:SSL] Verification failed: ssl !== strict");
  if (!httpsOk) throw new Error("[CF:SSL] Verification failed: always_use_https !== on");
  if (!hstsOk) throw new Error("[CF:SSL] Verification failed: HSTS not enabled");

  console.log("[CF:SSL] All SSL settings verified ✔");
  return {
    ssl: sslOk,
    alwaysHttps: httpsOk,
    hsts: hstsOk,
    details: {
      ssl: sslSetting.value,
      alwaysHttps: httpsSetting.value,
      hsts: hstsValue,
    },
  };
}
