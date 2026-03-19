function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env: ${name}`);
  return val;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const env = {
  SUPABASE_URL:              required("SUPABASE_URL"),
  SUPABASE_ANON_KEY:         required("SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
  OPENAI_API_KEY:            required("OPENAI_API_KEY"),
  APP_ENV:                   optional("APP_ENV", "development"),
};

function assertProductionSafe() {
  if (env.APP_ENV === "production") {
    if (!env.OPENAI_API_KEY.startsWith("sk-")) {
      throw new Error("Invalid OPENAI_API_KEY format");
    }
  }
}

assertProductionSafe();
