import { spawn } from 'node:child_process';

// Shared CLI-spawn helper: execFile leaves the child's stdin an open pipe that
// never gets an EOF. claude tolerates that with a ~3s "no stdin" wait per call;
// codex blocks INDEFINITELY (live 2026-07-12: 80+ minute hangs, observed twice,
// because `codex exec` always reads stdin for extra context when it isn't a
// TTY). Both CLI engines spawn through here instead: stdin is closed
// immediately, so the child sees EOF up front.
export function runBin(
  bin: string,
  args: string[],
  needsShell: boolean,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: needsShell });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}
