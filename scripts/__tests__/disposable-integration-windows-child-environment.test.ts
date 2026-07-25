import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDisposableToolEnvironment } from
  "../lib/disposable-tool-environment";

const hostileParentEnvironment = Object.freeze({
  ALLUSERSPROFILE: "Q:\\host-all-users-profile-canary",
  APPDATA: "Q:\\host-appdata-canary",
  CLIENTNAME: "host-client-name-canary",
  COMPUTERNAME: "host-computer-name-canary",
  HOMEDRIVE: "Q:",
  HOMEPATH: "\\Users\\host-home-path-canary",
  HOMESHARE: "\\\\host-share-canary\\profile",
  LOCALAPPDATA: "Q:\\host-local-appdata-canary",
  LOGONSERVER: "\\\\host-logon-server-canary",
  OneDrive: "Q:\\host-onedrive-canary",
  PUBLIC: "Q:\\host-public-profile-canary",
  SESSIONNAME: "host-session-name-canary",
  SYSTEMDRIVE: "Q:",
  TEMP: "Q:\\host-temp-canary",
  TMP: "Q:\\host-tmp-canary",
  USERDNSDOMAIN: "host-dns-domain-canary.invalid",
  USERDOMAIN: "host-user-domain-canary",
  USERDOMAIN_ROAMINGPROFILE: "host-roaming-domain-canary",
  USERNAME: "host-username-canary",
  USERPROFILE: "Q:\\Users\\host-profile-canary",
});

describe("disposable integration Windows child environment", () => {
  it.skipIf(process.platform !== "win32")(
    "prevents Windows from re-injecting host profile and identity variables",
    () => {
      const originalValues = new Map<string, string | undefined>();
      for (const [name, value] of Object.entries(hostileParentEnvironment)) {
        originalValues.set(name, process.env[name]);
        process.env[name] = value;
      }

      try {
        const taskHomeDirectory = path.resolve(
          "test-results",
          "disposable-child-home",
        );
        const environment = buildDisposableToolEnvironment(
          process.env,
          taskHomeDirectory,
        );
        const result = spawnSync(process.execPath, [
          "--input-type=module",
          "--eval",
          "process.stdout.write(JSON.stringify(process.env));",
        ], {
          encoding: "utf8",
          env: environment,
          windowsHide: true,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        const childEnvironment = JSON.parse(result.stdout) as
          Record<string, string | undefined>;
        expect(childEnvironment).toMatchObject({
          COMPUTERNAME: "CODESTEAD-INTEGRATION",
          HOME: taskHomeDirectory,
          LOGONSERVER: "\\\\CODESTEAD-INTEGRATION",
          USERDOMAIN: "CODESTEAD",
          USERDOMAIN_ROAMINGPROFILE: "CODESTEAD",
          USERNAME: "codestead-integration",
          USERPROFILE: taskHomeDirectory,
        });
        expect(path.win32.normalize(
          `${childEnvironment.HOMEDRIVE ?? ""}`
          + `${childEnvironment.HOMEPATH ?? ""}`,
        )).toBe(path.win32.normalize(taskHomeDirectory));

        const rendered = JSON.stringify(childEnvironment);
        for (const canary of Object.values(hostileParentEnvironment)) {
          expect(rendered).not.toContain(canary);
        }
      } finally {
        for (const [name, value] of originalValues) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    },
  );
});
