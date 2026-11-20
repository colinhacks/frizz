// WHERE A PROJECT'S FRIZZ FOLDER IS, as the worker hooks see it — the copy of
// packages/server/src/project-root.ts `projectFrizzDir` for code that runs inside a worker.
//
// `<project>/.frizz`, except for the home directory. The home project's folder cannot be `~/.frizz`,
// because that path is Frizz's legacy state root and its mere existence moves every Frizz process on
// the machine onto it. Its folder is `<data root>/home/.frizz` instead, and a hook finds the data root
// the way the frizz command line does: two levels up from this project's state dir
// (`<data root>/projects/<project id>`), which every worker is handed as FRIZZ_STATE_DIR, or which older
// workers can derive from FRIZZ_PERM_DIR (`<state dir>/perm-requests`).
//
// A home project whose data root cannot be told gets NULL, never a guess: a hook that falls back to
// `~/.frizz` is the one mistake this file exists to make impossible.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** @param {string} path @returns {string} */
function canonical(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** @param {string} dir @returns {boolean} */
export function isHomeDirectory(dir) {
  return canonical(dir) === canonical(homedir());
}

/** @param {NodeJS.ProcessEnv} env @returns {string | undefined} */
function stateDirFrom(env) {
  if (env.FRIZZ_STATE_DIR) return env.FRIZZ_STATE_DIR;
  const perm = env.FRIZZ_PERM_DIR;
  return perm && basename(perm) === 'perm-requests' ? dirname(perm) : undefined;
}

/**
 * The project's Frizz folder, or null for a home project whose data root this process cannot tell.
 * @param {string} projectDir @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export function projectFrizzDir(projectDir, env = process.env) {
  if (!isHomeDirectory(projectDir)) return join(projectDir, '.frizz');
  const stateDir = stateDirFrom(env);
  if (!stateDir || basename(dirname(stateDir)) !== 'projects') return null;
  return join(dirname(dirname(stateDir)), 'home', '.frizz');
}

/**
 * How a worker is told its scratch directory: relative to the project it runs in, or absolute in the
 * home project, whose folder is not under it. Null exactly when projectFrizzDir is.
 * @param {string} projectDir @param {string} sessionId @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export function scratchDirLabel(projectDir, sessionId, env = process.env) {
  if (!isHomeDirectory(projectDir)) return '.frizz/threads/' + sessionId + '/';
  const frizzDir = projectFrizzDir(projectDir, env);
  return frizzDir ? join(frizzDir, 'threads', sessionId) + '/' : null;
}
