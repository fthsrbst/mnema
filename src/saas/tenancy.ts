export type OrganizationRole = "owner" | "admin" | "member" | "viewer";

export type TenantAction =
  | "knowledge:read"
  | "knowledge:write"
  | "members:read"
  | "members:write"
  | "billing:read"
  | "billing:write"
  | "organization:delete";

export interface TenantPrincipal {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  /** Authenticator Assurance Level from the auth provider. */
  aal: "aal1" | "aal2";
}

const ROLE_ACTIONS: Record<OrganizationRole, ReadonlySet<TenantAction>> = {
  owner: new Set([
    "knowledge:read",
    "knowledge:write",
    "members:read",
    "members:write",
    "billing:read",
    "billing:write",
    "organization:delete",
  ]),
  admin: new Set([
    "knowledge:read",
    "knowledge:write",
    "members:read",
    "members:write",
    "billing:read",
    "billing:write",
  ]),
  member: new Set(["knowledge:read", "knowledge:write", "members:read"]),
  viewer: new Set(["knowledge:read", "members:read"]),
};

const MFA_REQUIRED = new Set<TenantAction>(["billing:write", "organization:delete"]);

export class TenantAccessError extends Error {
  readonly code: "tenant_mismatch" | "insufficient_role" | "mfa_required";

  constructor(code: TenantAccessError["code"], message: string) {
    super(message);
    this.name = "TenantAccessError";
    this.code = code;
  }
}

/**
 * Authorizes an operation against an explicit organization boundary.
 *
 * Never infer the requested organization from request data after this check:
 * downstream repositories must receive the returned organization id and bind it
 * to every query.
 */
export function requireTenantAccess(
  principal: TenantPrincipal,
  requestedOrganizationId: string,
  action: TenantAction
): string {
  if (principal.organizationId !== requestedOrganizationId) {
    throw new TenantAccessError("tenant_mismatch", "Organization access denied");
  }
  if (!ROLE_ACTIONS[principal.role].has(action)) {
    throw new TenantAccessError("insufficient_role", `Role ${principal.role} cannot perform ${action}`);
  }
  if (MFA_REQUIRED.has(action) && principal.aal !== "aal2") {
    throw new TenantAccessError("mfa_required", "Multi-factor authentication is required for this action");
  }
  return requestedOrganizationId;
}

export function canTenantAccess(
  principal: TenantPrincipal,
  requestedOrganizationId: string,
  action: TenantAction
): boolean {
  try {
    requireTenantAccess(principal, requestedOrganizationId, action);
    return true;
  } catch (error) {
    if (error instanceof TenantAccessError) return false;
    throw error;
  }
}
