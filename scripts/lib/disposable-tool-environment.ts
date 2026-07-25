import path from "node:path";

import {
  type DisposableIntegrationEnvironmentSource,
  minimalNodeTestEnvironment,
} from "./disposable-integration-environment";
import { disposableIntegrationFailure } from
  "./disposable-integration-error";

function validateTaskHomeDirectory(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw disposableIntegrationFailure("invalid_task_home_directory");
  }
  return path.normalize(value);
}

function windowsDisposableIdentityEnvironment(
  taskHome: string,
): Readonly<Record<string, string | undefined>> {
  if (process.platform !== "win32") return {};
  const root = path.win32.parse(taskHome).root;
  const homeDrive = root.endsWith(path.win32.sep)
    ? root.slice(0, -1)
    : root;
  const homePath = taskHome.slice(homeDrive.length) || path.win32.sep;
  return {
    ALLUSERSPROFILE: path.join(taskHome, "all-users-profile"),
    CLIENTNAME: "CODESTEAD-INTEGRATION",
    COMPUTERNAME: "CODESTEAD-INTEGRATION",
    HOMEDRIVE: homeDrive,
    HOMEPATH: homePath,
    HOMESHARE: "",
    LOGONSERVER: "\\\\CODESTEAD-INTEGRATION",
    ONEDRIVE: path.join(taskHome, "onedrive"),
    ONEDRIVECOMMERCIAL: path.join(taskHome, "onedrive-commercial"),
    ONEDRIVECONSUMER: path.join(taskHome, "onedrive-consumer"),
    PROGRAMDATA: path.join(taskHome, "program-data"),
    PUBLIC: path.join(taskHome, "public"),
    SESSIONNAME: "CODESTEAD-INTEGRATION",
    SYSTEMDRIVE: homeDrive,
    USERDNSDOMAIN: "CODESTEAD.INVALID",
    USERDOMAIN: "CODESTEAD",
    USERDOMAIN_ROAMINGPROFILE: "CODESTEAD",
    USERNAME: "codestead-integration",
  };
}

export function buildDisposableToolEnvironment(
  sourceEnvironment: DisposableIntegrationEnvironmentSource,
  taskHomeDirectory: string,
): NodeJS.ProcessEnv {
  const taskHome = validateTaskHomeDirectory(taskHomeDirectory);
  return {
    ...minimalNodeTestEnvironment(sourceEnvironment),
    ...windowsDisposableIdentityEnvironment(taskHome),
    FORCE_COLOR: undefined,
    NO_COLOR: "1",
    HOME: taskHome,
    USERPROFILE: taskHome,
    TEMP: path.join(taskHome, "tmp"),
    TMP: path.join(taskHome, "tmp"),
    TMPDIR: path.join(taskHome, "tmp"),
    APPDATA: path.join(taskHome, "appdata"),
    LOCALAPPDATA: path.join(taskHome, "local-appdata"),
    DOCKER_CONFIG: path.join(taskHome, "docker"),
    XDG_CONFIG_HOME: path.join(taskHome, "xdg-config"),
    XDG_CACHE_HOME: path.join(taskHome, "xdg-cache"),
    XDG_DATA_HOME: path.join(taskHome, "xdg-data"),
    NPM_CONFIG_GLOBALCONFIG: path.join(taskHome, "global-npmrc"),
    NPM_CONFIG_USERCONFIG: path.join(taskHome, ".npmrc"),
    NPM_CONFIG_CACHE: path.join(taskHome, "npm-cache"),
  };
}
