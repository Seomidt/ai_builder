import { eq, and } from "drizzle-orm";
import { db } from "../db.ts";
import {
  integrations,
  type Integration,
  type InsertIntegration,
} from "@shared/schema";

export const integrationsRepository = {
  async list(organizationId: string): Promise<Integration[]> {
    return db
      .select()
      .from(integrations)
      .where(eq(integrations.organizationId, organizationId));
  },

  async getByProvider(
    organizationId: string,
    provider: Integration["provider"],
  ): Promise<Integration | undefined> {
    const [integration] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.organizationId, organizationId),
          eq(integrations.provider, provider),
        ),
      );
    return integration;
  },

  async upsert(data: InsertIntegration): Promise<Integration> {
    const [integration] = await db
      .insert(integrations)
      .values(data)
      .onConflictDoUpdate({
        target: [integrations.organizationId, integrations.provider],
        set: {
          status: data.status,
          config: data.config,
          updatedAt: new Date(),
        },
      })
      .returning();
    return integration;
  },
};
