#!/usr/bin/env node
import { runProjectCommand } from '../lib/generate.mjs';
import { initProject, installCore } from '../lib/system.mjs';
import { runBriefCommand } from '../lib/brief.mjs';
import { runReplayCommand } from '../lib/replay.mjs';

const usage = 'Usage : agent-policy init [--upgrade] | build | check [--codex] | brief <brief.json> | replay <dossier-historique> | install [--target-root <dir>]';
try {
  const [command, ...options] = process.argv.slice(2);
  if (command === '--help' && options.length === 0) console.log(usage);
  else if (command === 'init' && (options.length === 0 || (options.length === 1 && options[0] === '--upgrade'))) {
    console.log(initProject(process.cwd(), { upgrade: options.includes('--upgrade') }));
  } else if (command === 'build' || command === 'check') runProjectCommand([command, ...options]);
  else if (command === 'brief') runBriefCommand(options);
  else if (command === 'replay') await runReplayCommand(options);
  else if (command === 'install' && options.length === 0) await installCore();
  else if (command === 'install' && options.length === 2 && options[0] === '--target-root' && options[1].trim().length > 0 && options[1].startsWith('--') === false) await installCore({ targetRoot: options[1] });
  else throw new Error(usage);
} catch (error) {
  console.error(`agent-policy : ${error.message}`);
  process.exitCode = 1;
}
