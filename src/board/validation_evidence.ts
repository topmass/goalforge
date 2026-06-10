export interface ValidationEvidence {
  implementationStatus: string | null;
  testStatus: string | null;
  verificationGates: string[];
  verificationVerdict: string | null;
  verificationProofDetails: string[];
  commit: string | null;
  reviewVerdict: string | null;
  finalGitStatus: string | null;
  commitCreated: boolean;
  reviewApproved: boolean;
  implementationCompleted: boolean;
  testCompleted: boolean;
  verificationGatesRecorded: boolean;
  verificationPassed: boolean;
  verificationHasProofDetails: boolean;
  finalGitClean: boolean;
  gaps: string[];
}

export function parseValidationEvidence(validation: string): ValidationEvidence {
  const implementationStatus = lineValue(validation, "Turn status");
  const testStatus = lineValue(validation, "Test turn status");
  const verificationGates = sectionLines(validation, "Discovered verification gates")
    .filter((line) => line && !/^-\s*No verification gates discovered\./i.test(line));
  const verificationLines = sectionLines(validation, "Verification verdict");
  const verificationVerdict = verificationLines[0] ?? null;
  const sameLineVerificationProof = verificationVerdict
    ?.replace(/^VERIFICATION_PASSED/i, "")
    .replace(/^[-:\s]+/, "")
    .trim();
  const verificationProofDetails = [
    ...(sameLineVerificationProof && sameLineVerificationProof.length >= 8
      ? [sameLineVerificationProof]
      : []),
    ...verificationLines.slice(1).filter((line) => line.replace(/^[-*]\s*/, "").trim().length >= 8),
  ];
  const commit = lineValue(validation, "Commit");
  const reviewVerdict = lineValue(validation, "GoalForge review");
  const finalGitStatus = sectionFirstLine(validation, "Git status");
  const commitCreated = Boolean(commit && !/not created|failed/i.test(commit));
  const reviewApproved = reviewVerdict ? /^approved$/i.test(reviewVerdict.trim()) : false;
  const implementationCompleted = implementationStatus
    ? /^completed$/i.test(implementationStatus.trim())
    : false;
  const testCompleted = testStatus ? /^completed$/i.test(testStatus.trim()) : false;
  const verificationGatesRecorded = verificationGates.length > 0;
  const verificationPassed = verificationVerdict
    ? /^VERIFICATION_PASSED/i.test(verificationVerdict.trim())
    : false;
  const verificationHasProofDetails = verificationProofDetails.length > 0;
  const finalGitClean = finalGitStatus ? /^clean$/i.test(finalGitStatus.trim()) : false;
  const gaps: string[] = [];
  if (!implementationCompleted) {
    gaps.push(
      implementationStatus
        ? `implementation turn ${implementationStatus}`
        : "missing implementation turn status",
    );
  }
  if (!testCompleted) {
    gaps.push(testStatus ? `test turn ${testStatus}` : "missing test turn status");
  }
  if (!verificationGatesRecorded) {
    gaps.push("missing discovered verification gates");
  }
  if (!verificationPassed) {
    gaps.push(
      verificationVerdict
        ? `verification verdict ${verificationVerdict}`
        : "missing verification verdict",
    );
  }
  if (verificationPassed && !verificationHasProofDetails) {
    gaps.push("verification verdict missing proof details");
  }
  if (!commitCreated) {
    gaps.push(commit ? `commit not created: ${commit}` : "missing commit");
  }
  if (!reviewApproved) {
    gaps.push(reviewVerdict ? `review ${reviewVerdict}` : "missing approved review");
  }
  if (!finalGitClean) {
    gaps.push(finalGitStatus ? `git status ${finalGitStatus}` : "missing final git status");
  }
  return {
    implementationStatus,
    testStatus,
    verificationGates,
    verificationVerdict,
    verificationProofDetails,
    commit,
    reviewVerdict,
    finalGitStatus,
    commitCreated,
    reviewApproved,
    implementationCompleted,
    testCompleted,
    verificationGatesRecorded,
    verificationPassed,
    verificationHasProofDetails,
    finalGitClean,
    gaps,
  };
}

function sectionLines(text: string, label: string): string[] {
  const lines = text.split(/\r?\n/);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim().toLowerCase() !== `${label.toLowerCase()}:`) {
      continue;
    }
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next].trim();
      if (!line) {
        if (values.length) break;
        continue;
      }
      if (isValidationSectionBoundary(line)) {
        break;
      }
      values.push(line);
    }
    break;
  }
  return values;
}

function isValidationSectionBoundary(line: string): boolean {
  return /^(Turn|Turn status|Test turn|Test turn status|Discovered verification gates|Verification verdict|Commit|Pre-commit git status|Pre-commit diff stat|Git status|Diff stat|GoalForge review):/i
    .test(line);
}

function lineValue(text: string, label: string): string | null {
  const pattern = new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, "im");
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function sectionFirstLine(text: string, label: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim().toLowerCase() !== `${label.toLowerCase()}:`) {
      continue;
    }
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next].trim();
      if (!line) {
        continue;
      }
      return line;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
