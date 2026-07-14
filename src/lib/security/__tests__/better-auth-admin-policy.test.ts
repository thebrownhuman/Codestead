import { describe, expect, it } from "vitest";
import { defaultStatements } from "better-auth/plugins/admin/access";

import {
  restrictedAdminRole,
  restrictedLearnerRole,
} from "../better-auth-admin-policy";

describe("generic Better Auth administrator endpoint policy", () => {
  it("does not grant impersonation or any mutation that bypasses application audit gates", () => {
    expect(restrictedAdminRole.statements).toEqual({ user: [], session: [] });
    expect(restrictedAdminRole.statements.user).not.toContain("impersonate");
    expect(restrictedAdminRole.statements.session).not.toContain("revoke");
  });

  it("does not grant learner access to generic administrator endpoints", () => {
    expect(restrictedLearnerRole.statements).toEqual({ user: [], session: [] });
  });

  it("executable access-control checks deny every generic Better Auth administrator permission", () => {
    for (const [resource, actions] of Object.entries(defaultStatements)) {
      for (const action of actions) {
        const permission = { [resource]: [action] } as Parameters<typeof restrictedAdminRole.authorize>[0];
        expect(restrictedAdminRole.authorize(permission), `admin ${resource}.${action}`).toMatchObject({ success: false });
        expect(restrictedLearnerRole.authorize(permission), `learner ${resource}.${action}`).toMatchObject({ success: false });
      }
    }
  });
});
