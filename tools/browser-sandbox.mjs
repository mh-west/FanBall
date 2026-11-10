// Loads the browser game scripts (dist/app.js, dist/enhancements.js) in a Node vm with a no-op DOM,
// so tests and tools can use the same sample rosters and engine the site uses.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

// Any property access or call on this returns itself, so DOM rendering code runs without effect.
const inert = new Proxy(function () {}, {
  get: (_, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : inert),
  apply: () => inert,
  construct: () => inert,
  set: () => true,
});

export function loadBrowserEngine() {
  const store = new Map();
  const context = {
    console,
    document: inert,
    navigator: inert,
    history: inert,
    location: { search: '', pathname: '/', hash: '', href: 'http://localhost/' },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    confirm: () => true,
    alert: () => {},
    structuredClone,
    URLSearchParams,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['dist/app.js', 'dist/enhancements.js']) vm.runInContext(readFileSync(new URL(file, root), 'utf8'), context, { filename: file });
  // Script-scope bindings (let/const at top level) are reachable from later scripts in the same context.
  context.run = code => vm.runInContext(code, context);
  return context;
}

// Engine roster for two teams using the site's sample players and default batting order.
export function sampleRoster(browser, teamIds) {
  return JSON.parse(browser.run(`JSON.stringify(Object.fromEntries(${JSON.stringify(teamIds)}.map(id=>{const t=team(id);return [id,{players:t.players,pitcher:t.pitcher,order:t.players.map((_,i)=>i)}]})))`));
}
