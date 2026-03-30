import { z } from "zod";
import { projectsRepository } from "../repositories/projects.repository";
import { NotFoundError, ConflictError } from "../lib/errors.ts";
import type { Project } from "@shared/schema";

export const createProjectSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers and hyphens only"),
  description: z.string().max(500).optional(),
  createdBy: z.string().min(1),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectsService = {
  async list(organizationId: string): Promise<Project[]> {
    return projectsRepository.listActive(organizationId);
  },

  async getById(id: string, organizationId: string): Promise<Project> {
    const project = await projectsRepository.getById(id, organizationId);
    if (!project) throw new NotFoundError("Project not found.");
    return project;
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const data = createProjectSchema.parse(input);
    try {
      return await projectsRepository.create({ ...data, status: "active" });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "23505") {
        throw new ConflictError("DUPLICATE_SLUG", "A project with this slug already exists in your organization. Choose a different slug.");
      }
      throw err;
    }
  },

  async update(id: string, organizationId: string, input: UpdateProjectInput): Promise<Project> {
    const data = updateProjectSchema.parse(input);
    try {
      const updated = await projectsRepository.update(id, organizationId, data);
      if (!updated) throw new NotFoundError("Project not found.");
      return updated;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "23505") {
        throw new ConflictError("DUPLICATE_SLUG", "A project with this slug already exists in your organization. Choose a different slug.");
      }
      throw err;
    }
  },

  async archive(id: string, organizationId: string): Promise<Project> {
    const archived = await projectsRepository.archive(id, organizationId);
    if (!archived) throw new NotFoundError("Project not found.");
    return archived;
  },
};
