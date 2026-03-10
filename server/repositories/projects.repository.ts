import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { projects, type Project, type InsertProject } from "@shared/schema";

export const projectsRepository = {
  async list(organizationId: string): Promise<Project[]> {
    return db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, organizationId))
      .orderBy(desc(projects.createdAt));
  },

  async listActive(organizationId: string): Promise<Project[]> {
    return db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.status, "active")))
      .orderBy(desc(projects.createdAt));
  },

  async getById(id: string, organizationId: string): Promise<Project | undefined> {
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.organizationId, organizationId)));
    return project;
  },

  async create(data: InsertProject): Promise<Project> {
    const [project] = await db.insert(projects).values(data).returning();
    return project;
  },

  async update(id: string, organizationId: string, data: Partial<Pick<Project, "name" | "slug" | "description">>): Promise<Project | undefined> {
    const [updated] = await db
      .update(projects)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.organizationId, organizationId)))
      .returning();
    return updated;
  },

  async archive(id: string, organizationId: string): Promise<Project | undefined> {
    const [updated] = await db
      .update(projects)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.organizationId, organizationId)))
      .returning();
    return updated;
  },
};
