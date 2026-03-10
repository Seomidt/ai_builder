import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  knowledgeDocuments,
  type KnowledgeDocument,
  type InsertKnowledgeDocument,
} from "@shared/schema";

export const knowledgeRepository = {
  async list(organizationId: string, projectId?: string): Promise<KnowledgeDocument[]> {
    const conditions = [eq(knowledgeDocuments.organizationId, organizationId)];
    if (projectId) conditions.push(eq(knowledgeDocuments.projectId, projectId));

    return db
      .select()
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.createdAt));
  },

  async getById(id: string, organizationId: string): Promise<KnowledgeDocument | undefined> {
    const [doc] = await db
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.id, id),
          eq(knowledgeDocuments.organizationId, organizationId),
        ),
      );
    return doc;
  },

  async create(data: InsertKnowledgeDocument): Promise<KnowledgeDocument> {
    const [doc] = await db.insert(knowledgeDocuments).values(data).returning();
    return doc;
  },

  async updateStatus(
    id: string,
    status: KnowledgeDocument["status"],
    contentHash?: string,
  ): Promise<KnowledgeDocument | undefined> {
    const [updated] = await db
      .update(knowledgeDocuments)
      .set({ status, contentHash, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, id))
      .returning();
    return updated;
  },
};
