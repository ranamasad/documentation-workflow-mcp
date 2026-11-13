import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueUploadTicket, verifyUploadTicket, UPLOAD_TICKET_TOOLS } from '../src/upload-ticket.js';

const user = '11111111-2222-4333-8444-555555555555';

test('an upload ticket names its user until it expires', () => {
  const now = Date.now();
  const { ticket, expiresAt } = issueUploadTicket(user, 600, now);
  assert.match(ticket, /^dup_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(verifyUploadTicket(ticket, now), user);
  assert.equal(new Date(expiresAt).getTime(), Math.floor(now / 1000) * 1000 + 600000);
  assert.equal(verifyUploadTicket(ticket, now + 601000), undefined);
});

test('an upload ticket lasts at most two hours', () => {
  const now = Date.now();
  const { ticket } = issueUploadTicket(user, 24 * 3600, now);
  assert.equal(verifyUploadTicket(ticket, now + 2 * 3600 * 1000 - 1000), user);
  assert.equal(verifyUploadTicket(ticket, now + 2 * 3600 * 1000 + 1000), undefined);
});

test('forged or altered tickets are refused', () => {
  const { ticket } = issueUploadTicket(user);
  const [body, signature] = ticket.slice(4).split('.');
  const other = Buffer.from(JSON.stringify({ v: 1, sub: '99999999-2222-4333-8444-555555555555', exp: 4102444800 })).toString('base64url');
  assert.equal(verifyUploadTicket('dup_' + other + '.' + signature), undefined);
  assert.equal(verifyUploadTicket('dup_' + body + '.' + 'A'.repeat(43)), undefined);
  assert.equal(verifyUploadTicket(ticket + '.x'), undefined);
  assert.equal(verifyUploadTicket('dmcp_' + ticket.slice(4)), undefined);
});

test('an upload ticket opens only validation, staging and code notes', () => {
  assert.deepEqual([...UPLOAD_TICKET_TOOLS].sort(), ['check_published', 'read_code_notes', 'save_code_notes', 'stage_documentation', 'validate_documentation', 'validate_documentation_snapshot', 'validate_draft']);
});

test('later workflow calls that send rulesVersion leave out the long rule lists', async () => {
  const { workflowPlan, rulesVersion } = await import('../src/workflows.js');
  const full = workflowPlan('new-project');
  assert.ok(full.boundaries.length && full.writingRules && full.transport);
  const again = workflowPlan('new-project', { rules: rulesVersion() }) as Record<string, unknown>;
  for (const name of ['boundaries', 'writingRules', 'transport', 'steps', 'publicationGate']) assert.equal(again[name], undefined, name);
  assert.match(String(again.rules), /Unchanged/);
  assert.ok(JSON.stringify(again).length < JSON.stringify(full).length / 3);
});
