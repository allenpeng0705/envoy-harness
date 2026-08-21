/**
 * Ambient types for the optional landlock-run dependency.
 * The package is an optionalDependency; this keeps `tsc`
 * happy when the binary package is absent (e.g. on macOS).
 */
declare module "@deepseek-ai/node-addon-landlock-run" {
  export function launcherPath(): string;
  export function grantArgs(grants: {
    readOnly?: readonly string[];
    readWrite?: readonly string[];
  }): string[];
  export function probe(
    launcher?: string,
  ): "full" | "partial" | "unusable";
  export const LAUNCHER_FAILURE_EXIT: number;
  export const LAUNCHER_BIN: string;
}
