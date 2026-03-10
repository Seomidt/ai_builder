import { z } from "zod";
import { projectsRepository } from "../repositories/projects.repository";
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
    if (!project) throw new Error(`Project not found: ${id}`);
    return project;
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const data = createProjectSchema.parse(input);
    return projectsRepository.create({ ...data, status: "active" });
  },

  async update(id: string, organizationId: string, input: UpdateProjectInput): Promise<Project> {
    const data = updateProjectSchema.parse(input);
    const updated = await projectsRepository.update(id, organizationId, data);
    if (!updated) throw new Error(`Project not found: ${id}`);
    return updated;
  },

  async archive(id: string, organizationId: string): Promise<Project> {
    const archived = await projectsRepository.archive(id, organizationId);
    if (!archived) throw new Error(`Project not found: ${id}`);
    return archived;
  },
};
