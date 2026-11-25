import test from 'node:test';
import assert from 'node:assert/strict';
import { annualSalaryUpper, cleanPrefs, selectOffers, searchLink, workplaceMode } from '../server/veille/core.js';

const now = Date.parse('2026-11-25T12:00:00Z');
const job = (id, fields = {}) => ({
  id, title: 'IT Manager', company: id, url: 'https://example.com/' + id,
  location: 'Paris, France', posted: new Date(now - 3600000).toISOString(),
  source: 'startups', type: 'CDI', ...fields
});
const prefs = (fields = {}) => cleanPrefs({ roles: ['IT Manager'], locations: ['R:IDF'], remote: 'onsite', contract: 'cdi', max: '10', ...fields });
const ids = (jobs, p) => selectOffers(jobs, p, new Set(), now).map(j => j.id);

test('fully remote excludes hybrid, onsite, unknown and negated remote', () => {
  const jobs = [
    job('remote', { workplace: 'Remote' }), job('hybrid', { workplace: 'Hybrid', remote: true }),
    job('onsite', { workplace: 'On-site' }), job('unknown'), job('negated', { location: 'Paris, France – no remote' }),
    job('support', { title: 'Remote IT Manager support' }), job('partial', { location: 'Paris, France – télétravail possible' }),
    job('full', { location: 'Paris, France – 100% télétravail' })
  ];
  assert.deepEqual(ids(jobs, prefs({ remote: 'remote' })), ['remote', 'full']);
  assert.deepEqual(ids(jobs, prefs({ remote: 'hybrid' })), ['remote', 'hybrid', 'full']);
  assert.equal(ids(jobs, prefs()).length, jobs.length);
});
test('structured workplace takes precedence over ambiguous text', () => {
  assert.equal(workplaceMode(job('x', { workplace: 'Hybrid', location: 'Remote, France' })), 'hybrid');
  assert.equal(workplaceMode(job('ashby:x:1', { remote: true })), 'remote');
  assert.equal(workplaceMode(job('sr:x:1', { remote: true })), 'unknown');
});
test('remote location does not match a hybrid France Travail job outside selected geography', () => {
  const jobs = [
    job('lyon', { source: 'francetravail', workplace: 'hybrid', location: 'Lyon, France' }),
    job('paris', { source: 'francetravail', workplace: 'hybrid' }),
    job('remote', { source: 'francetravail', workplace: 'remote', location: 'Lyon, France' })
  ];
  assert.deepEqual(ids(jobs, prefs({ locations: ['R:IDF', 'REMOTE'], remote: 'hybrid' })), ['paris', 'remote']);
  assert.deepEqual(ids(jobs, prefs({ locations: ['REMOTE'] })), ['remote']);
});
test('annual and monthly EUR salary upper bounds', () => {
  for (const [value, expected] of [
    ['Annuel de 45 000,00 Euros à 55 000,00 Euros sur 12 mois', 55000],
    ['40–50 k€ brut/an', 50000], ['55,000 EUR annually', 55000],
    ['Mensuel de 3 500 Euros à 4 000 Euros', 48000], ['4.000 € par mois', 48000],
    ['À partir de 40 000 € par an', null], ['40 k€ et plus par an', null],
    ['35 000 USD per year', null], ['20 € par heure', null], ['45 000 €', null],
    ['Salaire selon profil', null], ['', null]
  ]) assert.equal(annualSalaryUpper(value), expected, value);
});
test('salary minimum rejects only known upper bounds below the threshold', () => {
  const jobs = [
    job('low', { salary: '40–50 k€ brut/an' }), job('overlap', { salary: '45–60 k€ brut/an' }),
    job('monthly', { salary: '4 000 € par mois' }), job('unknown'), job('open', { salary: 'À partir de 40 k€ par an' })
  ];
  assert.deepEqual(ids(jobs, prefs({ salary: '55-65' })), ['overlap', 'unknown', 'open']);
  assert.deepEqual(ids(jobs, prefs({ salary: '55-65', excludeTags: ['nosalary'] })), ['overlap', 'open']);
});
test('search links reflect remote-only preference without remote location', () => {
  const p = prefs({ remote: 'remote' });
  assert.equal(new URL(searchLink('linkedin', 'IT Manager', p)).searchParams.get('f_WT'), '2');
  assert.match(new URL(searchLink('indeed', 'IT Manager', p)).searchParams.get('q'), /télétravail complet/);
});
