import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_NOTICE_CAPABILITIES,
  createTemplateAuthorityRegistry,
  DELETION_CAPABILITY_TEMPLATE_AUTHORITIES,
  PRODUCTION_EMAIL_TEMPLATES,
  SYSTEM_EMAIL_PRODUCERS,
  SYSTEM_EMAIL_TEMPLATE_AUTHORITIES,
  TEMPLATE_AUTHORITY_POLICIES,
} from "../template-authority-policy";

type MutableAccountState = {
  role: string;
  status: string;
  emailVerified: boolean;
};

type MutableAccountPolicy = {
  banned: boolean[];
  states: MutableAccountState[];
};

type MutableTemplatePolicy = {
  scope: string;
  versions: string[];
  account: MutableAccountPolicy | null;
  producer?: string;
  capability?: string;
};

type MutableRegistryInput = {
  productionTemplates: string[];
  policies: Record<string, MutableTemplatePolicy>;
};

function mutableCanonicalInput(): MutableRegistryInput {
  return structuredClone({
    productionTemplates: PRODUCTION_EMAIL_TEMPLATES,
    policies: TEMPLATE_AUTHORITY_POLICIES,
  }) as unknown as MutableRegistryInput;
}

function policy(
  input: MutableRegistryInput,
  template: string,
): MutableTemplatePolicy {
  const value = input.policies[template];
  if (!value) throw new Error(`Missing test policy for ${template}.`);
  return value;
}

describe("template authority registry construction", () => {
  it("deep-clones and deep-freezes every accepted authority value", () => {
    const input = mutableCanonicalInput();
    const registry = createTemplateAuthorityRegistry(input);
    const sourcePolicy = policy(input, "weekly-summary");
    const canonicalPolicy = registry.policies["weekly-summary"];

    sourcePolicy.versions.push("future");
    sourcePolicy.account!.states[0]!.status = "suspended";
    input.productionTemplates.push("future-template");

    expect(canonicalPolicy?.versions).toEqual(["1"]);
    expect(canonicalPolicy?.account?.states[0]?.status).toBe("active");
    expect(registry.productionTemplates).not.toContain("future-template");

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.productionTemplates)).toBe(true);
    expect(Object.isFrozen(registry.policies)).toBe(true);
    expect(Object.isFrozen(canonicalPolicy)).toBe(true);
    expect(Object.isFrozen(canonicalPolicy?.versions)).toBe(true);
    expect(Object.isFrozen(canonicalPolicy?.account)).toBe(true);
    expect(Object.isFrozen(canonicalPolicy?.account?.banned)).toBe(true);
    expect(Object.isFrozen(canonicalPolicy?.account?.states)).toBe(true);
    expect(Object.isFrozen(canonicalPolicy?.account?.states[0])).toBe(true);

    expect(() => {
      (canonicalPolicy?.versions as unknown as string[]).push("future");
    }).toThrow(TypeError);
  });

  it.each([
    ["account", "weekly-summary"],
    ["system", "invitation"],
    ["deletion", "account-deleted"],
  ])("rejects an empty %s template version set", (_scope, template) => {
    const input = mutableCanonicalInput();
    policy(input, template).versions = [];

    expect(() => createTemplateAuthorityRegistry(input))
      .toThrow(/version.*at least one/i);
  });

  it.each([
    ["account", "weekly-summary"],
    ["system", "invitation"],
    ["deletion", "account-deleted"],
  ])("rejects duplicate %s template versions", (_scope, template) => {
    const input = mutableCanonicalInput();
    policy(input, template).versions = ["1", "1"];

    expect(() => createTemplateAuthorityRegistry(input))
      .toThrow(/duplicate.*version/i);
  });

  it("rejects empty and duplicate banned tuples", () => {
    const empty = mutableCanonicalInput();
    policy(empty, "weekly-summary").account!.banned = [];
    expect(() => createTemplateAuthorityRegistry(empty))
      .toThrow(/banned.*at least one/i);

    const duplicate = mutableCanonicalInput();
    policy(duplicate, "weekly-summary").account!.banned = [false, false];
    expect(() => createTemplateAuthorityRegistry(duplicate))
      .toThrow(/duplicate.*banned/i);
  });

  it("rejects empty and duplicate account-state tuples", () => {
    const empty = mutableCanonicalInput();
    policy(empty, "weekly-summary").account!.states = [];
    expect(() => createTemplateAuthorityRegistry(empty))
      .toThrow(/state.*at least one/i);

    const duplicate = mutableCanonicalInput();
    const state = policy(duplicate, "weekly-summary").account!.states[0]!;
    policy(duplicate, "weekly-summary").account!.states.push({ ...state });
    expect(() => createTemplateAuthorityRegistry(duplicate))
      .toThrow(/duplicate.*state/i);
  });

  it("rejects duplicate production templates and inconsistent policy keys", () => {
    const duplicate = mutableCanonicalInput();
    duplicate.productionTemplates.push("weekly-summary");
    expect(() => createTemplateAuthorityRegistry(duplicate))
      .toThrow(/duplicate.*template/i);

    const missing = mutableCanonicalInput();
    delete missing.policies["weekly-summary"];
    expect(() => createTemplateAuthorityRegistry(missing))
      .toThrow(/template.*policy.*weekly-summary/i);

    const extra = mutableCanonicalInput();
    extra.policies["future-template"] = structuredClone(
      policy(extra, "weekly-summary"),
    );
    expect(() => createTemplateAuthorityRegistry(extra))
      .toThrow(/policy.*not.*production template.*future-template/i);
  });

  it("rejects duplicate system producers and deletion capabilities", () => {
    const producer = mutableCanonicalInput();
    policy(producer, "access-rejected").producer =
      policy(producer, "invitation").producer;
    expect(() => createTemplateAuthorityRegistry(producer))
      .toThrow(/producer.*exactly one template/i);

    const capability = mutableCanonicalInput();
    capability.productionTemplates.push("second-deletion-notice");
    capability.policies["second-deletion-notice"] = {
      scope: "deletion-capability",
      versions: ["1"],
      capability: policy(capability, "account-deleted").capability,
      account: structuredClone(policy(capability, "account-deleted").account),
    };
    expect(() => createTemplateAuthorityRegistry(capability))
      .toThrow(/capabilit.*exactly one template/i);
  });

  it("requires every declared system producer when its template is omitted too", () => {
    const input = mutableCanonicalInput();
    input.productionTemplates = input.productionTemplates.filter(
      (template) => template !== "access-rejected",
    );
    delete input.policies["access-rejected"];

    expect(() => createTemplateAuthorityRegistry(input))
      .toThrow(/system email producer.*missing.*access-request-rejected/i);
  });

  it("rejects an undeclared system producer as extra coverage", () => {
    const input = mutableCanonicalInput();
    input.productionTemplates.push("future-system-notice");
    input.policies["future-system-notice"] = {
      scope: "system",
      versions: ["1"],
      producer: "future-system-producer",
      account: null,
    };

    expect(() => createTemplateAuthorityRegistry(input))
      .toThrow(/undeclared system email producer.*future-system-producer/i);
  });

  it("requires every declared deletion capability when its template is omitted too", () => {
    const input = mutableCanonicalInput();
    input.productionTemplates = input.productionTemplates.filter(
      (template) => template !== "account-deleted",
    );
    delete input.policies["account-deleted"];

    expect(() => createTemplateAuthorityRegistry(input))
      .toThrow(/deletion capability.*missing.*account-deletion-notice-v1/i);
  });

  it("rejects an undeclared deletion capability as extra coverage", () => {
    const input = mutableCanonicalInput();
    input.productionTemplates.push("future-deletion-notice");
    input.policies["future-deletion-notice"] = {
      scope: "deletion-capability",
      versions: ["1"],
      capability: "future-deletion-capability",
      account: structuredClone(policy(input, "account-deleted").account),
    };

    expect(() => createTemplateAuthorityRegistry(input))
      .toThrow(/undeclared deletion capability.*future-deletion-capability/i);
  });

  it("rejects a deletion capability duplicated before its canonical mapping", () => {
    const input = mutableCanonicalInput();
    const canonicalIndex = input.productionTemplates.indexOf("account-deleted");
    input.productionTemplates.splice(
      canonicalIndex,
      0,
      "second-deletion-notice",
    );
    input.policies["second-deletion-notice"] = {
      scope: "deletion-capability",
      versions: ["1"],
      capability: policy(input, "account-deleted").capability,
      account: structuredClone(policy(input, "account-deleted").account),
    };

    expect(() => createTemplateAuthorityRegistry(input))
      .toThrow(/deletion capability.*exactly one template/i);
  });

  it("derives specialized projections from the complete declared sets", () => {
    expect(SYSTEM_EMAIL_TEMPLATE_AUTHORITIES.map(
      (authority) => authority.producer,
    )).toEqual(SYSTEM_EMAIL_PRODUCERS);
    expect(DELETION_CAPABILITY_TEMPLATE_AUTHORITIES.map(
      (authority) => authority.capability,
    )).toEqual(ACCOUNT_DELETION_NOTICE_CAPABILITIES);
  });

  it("rejects missing, malformed, and inconsistent account shapes", () => {
    const missing = mutableCanonicalInput();
    policy(missing, "weekly-summary").account = null;
    expect(() => createTemplateAuthorityRegistry(missing))
      .toThrow(/weekly-summary.*account policy/i);

    const malformedState = mutableCanonicalInput();
    policy(malformedState, "weekly-summary").account!.states = [{
      role: "learner",
      status: "active",
    } as MutableAccountState];
    expect(() => createTemplateAuthorityRegistry(malformedState))
      .toThrow(/state.*emailVerified/i);

    const extraField = mutableCanonicalInput();
    const account = policy(extraField, "weekly-summary").account!;
    (account as MutableAccountPolicy & { unexpected?: boolean }).unexpected = true;
    expect(() => createTemplateAuthorityRegistry(extraField))
      .toThrow(/account policy.*unexpected/i);
  });

  it("rejects an empty registry or a registry missing an authority scope", () => {
    expect(() => createTemplateAuthorityRegistry({
      productionTemplates: [],
      policies: {},
    })).toThrow(/at least one production email template/i);

    const noDeletion = mutableCanonicalInput();
    noDeletion.productionTemplates = noDeletion.productionTemplates.filter(
      (template) => template !== "account-deleted",
    );
    delete noDeletion.policies["account-deleted"];
    expect(() => createTemplateAuthorityRegistry(noDeletion))
      .toThrow(/deletion capability.*missing.*account-deletion-notice-v1/i);
  });
});
