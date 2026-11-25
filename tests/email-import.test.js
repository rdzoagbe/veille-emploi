import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationEvent, findApplicationMatch, shouldUpdateApplication, cleanPrefs } from '../server/veille/core.js';
const mail = (subject, text = '') => applicationEvent({subject,text,fromName:'Example'});
const confirmation = 'Your application to IT Manager at Example';
test('detects an explicit recruitment confirmation, interview and rejection', () => {
  for (const [text, status] of [
    ['Thank you for applying. We have received your application.', 'applied'],
    ['We invite you to schedule an interview.', 'interview'],
    ['We have decided not to proceed with your application.', 'rejected']
  ]) {
    const p = mail(confirmation, text);
    assert.equal(p?.title, 'IT Manager');
    assert.equal(p?.company, 'Example');
    assert.equal(p?.status, status);
  }
});
test('ignores alerts, invitations to apply, forwarding verification and unrelated messages', () => {
  for (const subject of ['Job alert: IT Manager', 'Invitation à postuler', 'Forwarding confirmation', 'Invoice for IT Manager', 'Your weekly newsletter']) {
    assert.equal(mail(subject, 'Here are some jobs that may interest you.'), null);
  }
  assert.equal(mail('Hello', 'Could you send me your CV?'), null);
  assert.equal(applicationEvent({subject:'Application received',text:'Thank you for applying.'}), null);
});
test('does not confuse a conditional rejection with an actual rejection', () => {
  assert.equal(mail(confirmation,'Thank you for applying. If you have not been contacted, please consider your application unsuccessful.').status,'applied');
});
test('exact application identity is preferred and fuzzy candidates are held for review', () => {
  const rows = [{id:1,title:'IT Manager',company:'Example',url:'https://www.linkedin.com/jobs/view/123/'},{id:2,title:'Infrastructure Manager',company:'Example'}];
  assert.equal(findApplicationMatch(rows,{title:'IT Manager',company:'Example'}).row.id,1);
  assert.equal(findApplicationMatch(rows,{title:'Some other title',company:'Other',url:'https://www.linkedin.com/jobs/view/123/'}).row.id,1);
  assert.equal(findApplicationMatch(rows,{title:'IT Infrastructure Manager',company:'Example'}).ambiguous,true);
  assert.equal(findApplicationMatch([...rows, {...rows[0],id:3}],{title:'IT Manager',company:'Example'}).ambiguous,true);
  assert.equal(findApplicationMatch(rows,{title:'Designer',company:'Different'}).row,null);
});
test('late confirmations do not regress status; later rejection can close an interview', () => {
  const current = {status:'interview',status_at:'2026-11-20T09:00:00Z'};
  assert.equal(shouldUpdateApplication(current,'applied','2026-11-21T10:00:00Z'),false);
  assert.equal(shouldUpdateApplication(current,'rejected','2026-11-19T10:00:00Z'),false);
  assert.equal(shouldUpdateApplication(current,'rejected','2026-11-21T10:00:00Z'),true);
  assert.equal(shouldUpdateApplication({status:'rejected'},'interview','2026-11-21T10:00:00Z'),false);
  assert.equal(shouldUpdateApplication({status:'notforme'},'applied','2026-11-21T10:00:00Z'),false);
});
test('mailbox import defaults off and accepts only explicit boolean opt-in', () => {
  assert.equal(cleanPrefs({}).mailImport,false);
  assert.equal(cleanPrefs({mailImport:'true'}).mailImport,false);
  assert.equal(cleanPrefs({mailImport:true}).mailImport,true);
});

import { importMailboxConfig, canImportMailbox } from '../server/veille/core.js';
test('notification and recruitment credentials remain independent', () => {
 const c=importMailboxConfig('notify@gmail.com','send','owner@gmail.com',' app pass ');
 assert.deepEqual(c,{user:'owner@gmail.com',pass:'apppass'});
 assert.equal(canImportMailbox('owner@gmail.com',c),true);
 assert.equal(canImportMailbox('notify@gmail.com',c),false);
 assert.equal(canImportMailbox('other@gmail.com',c),false);
});
test('partial explicit mailbox credentials fail closed, absent credentials preserve existing behavior', () => {
 assert.equal(importMailboxConfig('notify@gmail.com','send','owner@gmail.com',''),null);
 assert.equal(importMailboxConfig('notify@gmail.com','send','','pass'),null);
 assert.equal(importMailboxConfig('notify@gmail.com','','',''),null);
 assert.deepEqual(importMailboxConfig('notify@gmail.com','send','',''),{user:'notify@gmail.com',pass:'send'});
 assert.equal(canImportMailbox('owner@gmail.com',null),false);
});
