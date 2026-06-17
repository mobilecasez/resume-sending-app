// Store for per-employer job-DETAIL extraction recipes. When the generic ATS parser
// can't pull required fields (salary/skills/responsibilities…) for an employer, the
// agent learns the page structure from 1-2 samples and saves a recipe here; future
// searches apply it deterministically (no AI) to every job of that employer.
'use strict';

const dbConfig = require('../../db-config');

function normDomain(input) {
  try {
    let u = String(input || '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return String(input || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

async function getRecipe(domain) {
  const row = await dbConfig.get(`SELECT * FROM employer_detail_recipes WHERE domain = ?`, [normDomain(domain)]);
  return row || null;
}

async function saveRecipe({ domain, recipe, verified, fieldsRecovered, sampleUrl, createdBy }) {
  const dom = normDomain(domain);
  await dbConfig.run(
    `INSERT INTO employer_detail_recipes (domain, recipe, verified, fields_recovered, sample_url, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (domain) DO UPDATE SET
        recipe = EXCLUDED.recipe, verified = EXCLUDED.verified,
        fields_recovered = EXCLUDED.fields_recovered, sample_url = EXCLUDED.sample_url,
        created_by = EXCLUDED.created_by, updated_at = CURRENT_TIMESTAMP`,
    [dom, JSON.stringify(recipe || {}), !!verified, (fieldsRecovered || []).join(','), sampleUrl || null, createdBy || 'agent']
  );
}

async function listRecipes() {
  return (await dbConfig.query(`SELECT * FROM employer_detail_recipes ORDER BY updated_at DESC LIMIT 300`)) || [];
}

async function deleteRecipe(domain) {
  await dbConfig.run(`DELETE FROM employer_detail_recipes WHERE domain = ?`, [normDomain(domain)]);
}

module.exports = { normDomain, getRecipe, saveRecipe, listRecipes, deleteRecipe };
