import { Buffer } from "node:buffer";
import path from "node:path";

import { disposableIntegrationFailure } from
  "./disposable-integration-error";

const CHILD_COMMAND_ENVIRONMENT_KEY =
  "CODESTEAD_INTEGRATION_CHILD_COMMAND";
const CHILD_ARGUMENTS_ENVIRONMENT_KEY =
  "CODESTEAD_INTEGRATION_CHILD_ARGUMENTS";
const WINDOWS_TREE_SUPERVISOR_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$encoding = [System.Text.Encoding]::UTF8",
  `$command = $encoding.GetString([System.Convert]::FromBase64String($env:${CHILD_COMMAND_ENVIRONMENT_KEY}))`,
  `$arguments = $encoding.GetString([System.Convert]::FromBase64String($env:${CHILD_ARGUMENTS_ENVIRONMENT_KEY}))`,
  `Remove-Item Env:${CHILD_COMMAND_ENVIRONMENT_KEY} -ErrorAction SilentlyContinue`,
  `Remove-Item Env:${CHILD_ARGUMENTS_ENVIRONMENT_KEY} -ErrorAction SilentlyContinue`,
  "if ([string]::IsNullOrEmpty($arguments)) { "
    + "$process = Start-Process -FilePath $command -NoNewWindow "
    + "-PassThru -Wait } else { "
    + "$process = Start-Process -FilePath $command "
    + "-ArgumentList $arguments -NoNewWindow -PassThru -Wait }",
  "exit $process.ExitCode",
].join("; ");

export type DisposableIntegrationChildLaunch = Readonly<{
  args: readonly string[];
  command: string;
  environment: NodeJS.ProcessEnv;
  treeSupervised: boolean;
}>;

function validValue(value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw disposableIntegrationFailure("invalid_child_launch");
  }
  return value;
}

function quoteWindowsCommandLineArgument(value: string): string {
  if (value.includes("\0")) {
    throw disposableIntegrationFailure("invalid_child_launch");
  }
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let output = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat(backslashes * 2 + 1);
      output += '"';
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes);
    output += character;
    backslashes = 0;
  }
  output += "\\".repeat(backslashes * 2);
  return `${output}"`;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function buildDisposableIntegrationChildLaunch(
  input: Readonly<{
    args: readonly string[];
    command: string;
    environment: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }>,
): DisposableIntegrationChildLaunch {
  const command = validValue(input.command);
  const args = input.args.map(quoteWindowsCommandLineArgument);
  if ((input.platform ?? process.platform) !== "win32") {
    return {
      command,
      args: [...input.args],
      environment: input.environment,
      treeSupervised: false,
    };
  }

  const systemRoot = input.environment.SYSTEMROOT;
  if (
    systemRoot === undefined
    || systemRoot.includes("\0")
    || !path.win32.isAbsolute(systemRoot)
  ) {
    throw disposableIntegrationFailure(
      "windows_tree_supervisor_unavailable",
    );
  }
  return {
    command: path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_TREE_SUPERVISOR_SCRIPT,
    ],
    environment: {
      ...input.environment,
      [CHILD_COMMAND_ENVIRONMENT_KEY]: encode(command),
      [CHILD_ARGUMENTS_ENVIRONMENT_KEY]: encode(args.join(" ")),
    },
    treeSupervised: true,
  };
}
