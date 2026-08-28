/**
 * Ambient types for optionalDependency `node-pty`.
 * Present so `tsc` succeeds when the package is not installed.
 */

declare module "node-pty" {
  export interface IPty {
    readonly pid: number;
    write(data: string): void;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(
      listener: (e: { exitCode: number; signal?: number }) => void,
    ): { dispose(): void };
    kill(signal?: string): void;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): IPty;
}
