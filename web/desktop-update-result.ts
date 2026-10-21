export type DesktopUpdateFailureReason =
  | "browserCleanup"
  | "installerLaunch"
  | "installationUnconfirmed"
  | "startupMismatch";

export type DesktopUpdateResult =
  | { state: "succeeded"; fromVersion: string; version: string }
  | { state: "installedRelaunchUnconfirmed"; version: string }
  | {
      state: "failedOrInterrupted";
      fromVersion: string;
      expectedVersion: string;
      reason: DesktopUpdateFailureReason;
    };

export interface DesktopUpdateResultSummary {
  tone: "success" | "warning" | "error";
  title: string;
  detail: string;
}

const FAILURE_REASONS = new Set<DesktopUpdateFailureReason>([
  "browserCleanup",
  "installerLaunch",
  "installationUnconfirmed",
  "startupMismatch",
]);

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

export function parseDesktopUpdateResult(value: unknown): DesktopUpdateResult | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") {
    throw new Error("GhosterAnti returned an invalid update result.");
  }
  const result = value as Record<string, unknown>;
  if (
    result.state === "succeeded" &&
    isVersion(result.fromVersion) &&
    isVersion(result.version)
  ) {
    return {
      state: "succeeded",
      fromVersion: result.fromVersion,
      version: result.version,
    };
  }
  if (result.state === "installedRelaunchUnconfirmed" && isVersion(result.version)) {
    return { state: "installedRelaunchUnconfirmed", version: result.version };
  }
  if (
    result.state === "failedOrInterrupted" &&
    isVersion(result.fromVersion) &&
    isVersion(result.expectedVersion) &&
    typeof result.reason === "string" &&
    FAILURE_REASONS.has(result.reason as DesktopUpdateFailureReason)
  ) {
    return {
      state: "failedOrInterrupted",
      fromVersion: result.fromVersion,
      expectedVersion: result.expectedVersion,
      reason: result.reason as DesktopUpdateFailureReason,
    };
  }
  throw new Error("GhosterAnti returned an invalid update result.");
}

// The recovery hints name what each system offers: the Start menu and offline installer, or Applications and the install command.
const MAC = typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent);
const REOPEN = MAC ? "open it from the Applications folder" : "launch it from Windows Start";
const REINSTALL = MAC ? "run the install command again" : "run the full offline installer without uninstalling";

export function describeDesktopUpdateResult(result: DesktopUpdateResult, t: (key: string, values?: Record<string, string>) => string): DesktopUpdateResultSummary {
  if (result.state === "succeeded") {
    return {
      tone: "success",
      title: t("GhosterAnti {version} installed successfully.", { version: result.version }),
      detail: t("Updated from {fromVersion} and verified the installed app after restart.", { fromVersion: result.fromVersion }),
    };
  }
  if (result.state === "installedRelaunchUnconfirmed") {
    return {
      tone: "warning",
      title: t("GhosterAnti {version} is installed.", { version: result.version }),
      detail: t("The automatic restart was not confirmed. Close GhosterAnti, then {reopen}.", { reopen: REOPEN }),
    };
  }

  const detail = result.reason === "browserCleanup"
    ? t("GhosterAnti {fromVersion} remains installed because browser services could not close safely.", { fromVersion: result.fromVersion })
    : result.reason === "installerLaunch"
      ? t("GhosterAnti {expectedVersion} could not start. GhosterAnti {fromVersion} remains installed.", { expectedVersion: result.expectedVersion, fromVersion: result.fromVersion })
      : result.reason === "startupMismatch"
        ? t("GhosterAnti could not verify {expectedVersion} at the expected install location. Close GhosterAnti, then {reopen}.", { expectedVersion: result.expectedVersion, reopen: REOPEN })
        : t("GhosterAnti could not confirm {expectedVersion}. If the installed version did not change, {reinstall}.", { expectedVersion: result.expectedVersion, reinstall: REINSTALL });
  return {
    tone: "error",
    title: t("The last update did not finish."),
    detail,
  };
}
