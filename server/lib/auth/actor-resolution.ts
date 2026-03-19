export interface ResolvedActor {
  actorId:        string;
  actorType:      "user" | "service" | "demo";
  organizationId: string;
  role:           string;
  email?:         string;
  isDemoUser:     boolean;
  isSuperAdmin:   boolean;
}
