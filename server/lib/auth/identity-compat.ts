import type { ResolvedActor } from "./actor-resolution";

interface AuthUser {
  id:             string;
  email?:         string;
  organizationId: string;
  role:           string;
}

export function mapCurrentUserToCanonicalActor(user: AuthUser): ResolvedActor {
  return {
    actorId:        user.id,
    actorType:      user.id.startsWith("demo-") ? "demo" : "user",
    organizationId: user.organizationId,
    role:           user.role,
    email:          user.email,
    isDemoUser:     user.id.startsWith("demo-"),
    isSuperAdmin:   user.role === "superadmin",
  };
}
