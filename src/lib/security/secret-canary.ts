import {
  CREDENTIAL_VALUE_PATTERNS,
  findCredentialAssignmentDetectors,
} from "./credential-patterns";

export interface SecretFinding {
  readonly detector: string;
  readonly line: number;
}

/** Returns location and detector only; callers must never print the match. */
export function findSecretCanaries(text: string, filePath?: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    let foundExplicitCredential = false;
    for (const { detector, expression, scanExpression } of CREDENTIAL_VALUE_PATTERNS) {
      if (scanExpression === null) continue;
      const scanner = scanExpression ?? expression;
      const flags = scanner.flags.replaceAll("g", "").replaceAll("y", "");
      const lineExpression = new RegExp(scanner.source, flags);
      if (lineExpression.test(line)) {
        findings.push({ detector, line: index + 1 });
        foundExplicitCredential = true;
      }
    }
    if (!foundExplicitCredential) {
      for (const detector of findCredentialAssignmentDetectors(line, filePath)) {
        findings.push({ detector, line: index + 1 });
      }
    }
  }
  return findings;
}
