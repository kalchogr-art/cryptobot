// src/ml/shadow-learning.ts
// BASE V0.1 — safe module test. No trading, no schema assumptions.
export interface Env { DB: D1Database; }

export async function updateMLShadowLearning(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ml_module_health (
    module TEXT PRIMARY KEY,
    runs INTEGER NOT NULL DEFAULT 0,
    last_run TEXT,
    status TEXT NOT NULL DEFAULT 'NEW'
  )`).run();

  await env.DB.prepare(`
    INSERT INTO ml_module_health(module,runs,last_run,status)
    VALUES('shadow-learning',1,CURRENT_TIMESTAMP,'OK')
    ON CONFLICT(module) DO UPDATE SET
      runs=runs+1,last_run=CURRENT_TIMESTAMP,status='OK'
  `).run();
}

export async function getMLShadowStatus(env: Env) {
  return await env.DB.prepare(
    `SELECT * FROM ml_module_health WHERE module='shadow-learning'`
  ).first();
}
