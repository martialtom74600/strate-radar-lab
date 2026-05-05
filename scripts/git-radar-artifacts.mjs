/**
 * Marque (ou dé-marque) les sorties du radar comme "skip-worktree" pour que
 * les runs locaux (`npm run dev`) ne polluent pas `git status` et ne partent
 * pas en conflit avec les commits du bot Actions.
 *
 * Usage :
 *   node scripts/git-radar-artifacts.mjs --skip | --track | --show
 *
 * Chemins alignés sur .github/workflows/nightly-radar.yml (étape commit).
 */
import { spawnSync } from 'node:child_process';

const ARTIFACTS = [
  'rapport_matinal.md',
  'data/shadow-sites-export.json',
  'data/heartbeat.json',
  'data/strate-radar.sqlite',
];

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '');
    process.exit(r.status ?? 1);
  }
  return r.stdout?.trimEnd() ?? '';
}

function tryUpdateIndex(flag, path) {
  const r = spawnSync('git', ['update-index', flag, '--', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status === 0) return true;
  if (/not in the index/i.test(r.stderr || '')) {
    console.warn(`Ignoré (fichier non suivi par git) : ${path}`);
    return false;
  }
  process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 1);
}

const mode = process.argv[2];
if (mode !== '--skip' && mode !== '--track' && mode !== '--show') {
  console.error(
    'Usage: node scripts/git-radar-artifacts.mjs --skip | --track | --show\n',
  );
  process.exit(1);
}

if (mode === '--show') {
  const out = git('ls-files', '-v', '--', ...ARTIFACTS);
  const lines = out ? out.split('\n') : [];
  const skipped = lines.filter((l) => l.startsWith('S '));
  for (const line of skipped) {
    console.log(line);
  }
  if (skipped.length === 0) {
    console.log('(aucun de ces fichiers n’est en skip-worktree)');
  }
  process.exit(0);
}

const flag = mode === '--skip' ? '--skip-worktree' : '--no-skip-worktree';
for (const p of ARTIFACTS) {
  tryUpdateIndex(flag, p);
}
console.log(
  mode === '--skip'
    ? 'Artefacts radar en skip-worktree — les modifs locales ne seront plus listées par git status.'
    : 'skip-worktree levé — git suivra à nouveau ces fichiers.',
);
