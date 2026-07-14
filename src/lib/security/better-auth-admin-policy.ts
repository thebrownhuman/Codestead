import { defaultAc } from "better-auth/plugins/admin/access";

/**
 * Better Auth supplies the role/session schema used by this application, but
 * its generic admin mutation endpoints do not provide our required reason,
 * fresh-MFA, audit, and learner-notification contract. Keep those endpoints
 * fail-closed and use only application-owned administrator routes.
 */
export const restrictedAdminRole = defaultAc.newRole({ user: [], session: [] });
export const restrictedLearnerRole = defaultAc.newRole({ user: [], session: [] });
