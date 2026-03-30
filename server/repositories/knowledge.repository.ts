import { eq, and, desc } from "drizzle-orm";
import { db } from "../db.ts";
import {
  knowledgeDocuments,
  knowledgeBases,
  type KnowledgeDocument,
  type InsertKnowledgeDocument,
  type KnowledgeBase,
} from "@shared/schema";

export const knowledgeRepository = {
  async list(tenantId: string, knowledgeBaseId?: string): Promise<KnowledgeDocument[]> {
    const conditions = [eq(knowledgeDocuments.tenantId, tenantId)];
    if (knowledgeBaseId) conditions.push(eq(knowledgeDocuments.knowledgeBaseId, knowledgeBaseId));

    return db
      .select()
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.createdAt));
  },

  async getById(id: string, tenantId: string): Promise<KnowledgeDocument | undefined> {
    const [doc] = await db
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.id, id),
          eq(knowledgeDocuments.tenantId, tenantId),
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
    documentStatus: KnowledgeDocument["documentStatus"],
    tenantId: string,
  ): Promise<KnowledgeDocument | undefined> {
    const [updated] = await db
      .update(knowledgeDocuments)
      .set({ documentStatus, updatedAt: new Date() })
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.tenantId, tenantId)))
      .returning();
    return updated;
  },

  async listBases(tenantId: string): Promise<KnowledgeBase[]> {
    return db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.tenantId, tenantId))
      .orderBy(desc(knowledgeBases.createdAt));
  },
};
