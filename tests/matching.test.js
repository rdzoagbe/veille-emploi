import test from 'node:test';
import assert from 'node:assert/strict';
import { selectOffers, annualSalary, salaryTooLow, workplaceMatch, searchLink } from '../server/veille/core.js';
import { applicationDate, csvCell } from '../js/history.js';
const now = Date.parse('2026-11-25T12:00:00Z');
const job = { id:'1', title:'Software engineer', company:'Example', url:'https://example.org/job', posted:'2026-11-25T09:00:00Z', source:'startups', location:'Paris', workplace:'OnSite', remote:false };
const prefs = { roles:['Software engineer'], locations:['R:IDF'], remote:'remote', since:'3' };
test('fully remote preference rejects Paris onsite and hybrid offers', () => {
 assert.equal(selectOffers([job],prefs,new Set(),now).length,0);
 assert.equal(selectOffers([{...job,workplace:'Hybrid',remote:true}],prefs,new Set(),now).length,0);
 assert.equal(selectOffers([{...job,workplace:'Remote',remote:true}],prefs,new Set(),now).length,1);
});
test('hybrid requires evidence; onsite accepted imposes no restriction', () => {
 assert.equal(workplaceMatch(job,'hybrid'),false);
 assert.equal(workplaceMatch({...job,workplace:'Hybrid'},'hybrid'),true);
 assert.equal(workplaceMatch({...job,workplace:'',remote:false},'remote'),false);
 assert.equal(workplaceMatch(job,'onsite'),true);
 assert.equal(workplaceMatch({...job,location:'Paris (no remote)',workplace:''},'remote'),false);
 assert.equal(workplaceMatch({...job,location:'Paris / remote',workplace:'OnSite',remote:true},'remote'),false);
});
test('France Travail does not bypass work-arrangement preference', () => {
 assert.equal(selectOffers([{...job,source:'francetravail'}],prefs,new Set(),now).length,0);
});
test('annual and monthly French salary formats, decimal and thousands separators', () => {
 for (const [s,n] of [['Annuel de 35 000,00 Euros à 45 000,00 Euros',45000],['45–55 k€ annuel',55000],['Annuel 45.000 EUR',45000],['Mensuel 2 500,50 EUR',30006],['annuel 45,5 k€',45500]]) assert.equal(annualSalary(s),n,s);
 for (const s of ['', 'Selon profil','20 EUR horaire','50000 USD annual','3000 EUR net mensuel']) assert.equal(annualSalary(s),null,s);
 assert.equal(salaryTooLow({salary:'Mensuel 2500 EUR'},{salary:'35-45'}),true);
 assert.equal(salaryTooLow({salary:''},{salary:'35-45'}),false);
});
test('salary minimum and exclusion affect actual selection', () => {
 const p={...prefs,remote:'onsite',salary:'45-55'};
 assert.equal(selectOffers([{...job,salary:'35 k€ annuel'}],p,new Set(),now).length,0);
 assert.equal(selectOffers([job],{...p,excludeTags:['nosalary']},new Set(),now).length,0);
});
test('remote search links follow remote dropdown', () => assert.match(searchLink('linkedin','Engineer',prefs),/f_WT=2/));
test('received/status dates never masquerade as application dates', () => {
 assert.equal(applicationDate({sent_at:'2026-11-20',status_at:'2026-11-24'}),null);
 assert.equal(applicationDate({applied_at:'bad'}),null);
 assert.equal(applicationDate({applied_at:'2026-11-23'}),'2026-11-23');
});
test('CSV safely quotes commas, quotes and spreadsheet formulas', () => {
 assert.equal(csvCell('A"B'),'"A""B"');
 assert.equal(csvCell('=SUM(1,2)'), '"\'=SUM(1,2)"');
});
