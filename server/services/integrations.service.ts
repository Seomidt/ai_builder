import { z } from "zod";
import { integrationsRepository } from "../repositories/integrations.repository.ts";
import type { Integration } from "@shared/schema";

export const upsertIntegrationSchema = z.object({
  organizationId: z.string().min(1),
  provider: z.enum(["github", "openai", "vercel", "supabase", "cloudflare"]),
  status: z.enum(["active", "inactive"]).default("inactive"),
  config: z.record(z.unknown()).optional(),
});

export type UpsertIntegrationInput = z.infer<typeof upsertIntegrationSchema>;

export const integrationsService = {
  async list(organizationId: string): Promise<Integration[]> {
    const existing = await integrationsRepository.list(organizationId);
    const allProviders: Integration["provider"][] = ["github", "openai", "vercel", "supabase", "cloudflare"];
    const existingMap = new Map(existing.map((i) => [i.provider, i]));

    return allProviders.map((provider) => existingMap.get(provider) ?? {
      id: "",
      organizationId,
      provider,
      status: "inactive" as const,
      config: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  },

  async getByProvider(organizationId: string, provider: Integration["provider"]): Promise<Integration | undefined> {
    return integrationsRepository.getByProvider(organizationId, provider);
  },

  async upsert(input: UpsertIntegrationInput): Promise<Integration> {
    const data = upsertIntegrationSchema.parse(input);
    return integrationsRepository.upsert(data);
  },
};
