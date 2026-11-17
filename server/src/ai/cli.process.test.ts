import { it, expect } from 'vitest';
import { runCliAgent, runCliText } from './cli.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { vi } from 'vitest';

it('rejects a provider JSON error even when the CLI exits zero', async () => {
  const inv = {command:process.execPath, displayName:'fixture', args:['-e', 'console.log(JSON.stringify({type:"result",is_error:true,result:"model unavailable"}))']};
  await expect(runCliAgent(inv, {cwd:tmpdir(), onLog:()=>{}, timeoutMs:5000})).rejects.toThrow('model unavailable');
  await expect(runCliText(inv, {cwd:tmpdir(), timeoutMs:5000, kind:'claude'})).rejects.toThrow('model unavailable');
});
it('reports the configured timeout instead of a fixed ten minutes', async () => {
  const inv = {command:process.execPath,displayName:'fixture',args:['-e','setTimeout(()=>{},10000)']};
  await expect(runCliAgent(inv,{cwd:tmpdir(),onLog:()=>{},timeoutMs:1000})).rejects.toThrow('1s');
});

it('delivers complete multiline input through a CLI launcher to text and agent calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli input '));
  try {
    const script = join(root, 'fixture.cjs');
    const marker = join(root, 'should-not-exist.txt');
    writeFileSync(script, `let input = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => console.log(JSON.stringify({ input })));`);
    const launcher = join(root, 'fixture.cmd');
    if (process.platform === 'win32') writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const input = `第一行\r\n完整任务与资料\n"引号" & echo BAD > "${marker}"\n末行`;
    const inv = { command: process.platform === 'win32' ? launcher : process.execPath,
      args: [...(process.platform === 'win32' ? [] : [script]), '-'], displayName: 'fixture', input };
    const agent = await runCliAgent(inv, { cwd: root, onLog: () => {}, timeoutMs: 5000 });
    expect(JSON.parse(agent.output)).toEqual({ input });
    expect(JSON.parse(await runCliText(inv, { cwd: root, kind: 'codex', timeoutMs: 5000 }))).toEqual({ input });
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('removes the Codex output directory after a timed-out process closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-timeout-'));
  const trace = join(root, 'output-path.txt');
  const script = join(root, 'fixture.cjs');
  writeFileSync(script, `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(trace)}, process.argv[process.argv.indexOf('--output-last-message') + 1]);
    setTimeout(() => {}, 30000);`);
  let outputDir: string | undefined;
  try {
    await expect(runCliText({ command: process.execPath, displayName: 'fixture', args: [script, 'P'] },
      { cwd: root, kind: 'codex', timeoutMs: 1000 })).rejects.toThrow('1s');
    outputDir = dirname(readFileSync(trace, 'utf8'));
    await vi.waitFor(() => expect(existsSync(outputDir!)).toBe(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
  }
});
