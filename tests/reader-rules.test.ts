import test from 'node:test';
import assert from 'node:assert/strict';
import { designStructure } from '../src/authoring.js';
import { checkOutlineConformance } from '../src/outline-conformance.js';
import { reviewedCatalog } from './reviewed-catalog.js';

type Block = Record<string, unknown> & { type?: string; text?: string; title?: string; items?: unknown[]; rows?: Record<string, unknown>[];
  columns?: { key: string; label: string }[]; blocks?: Block[] };
type Rec = { key: string; data: Record<string, unknown> & { blocks?: Block[] } };
const all = ['end-users', 'support', 'testers', 'product-owners', 'administrators', 'developers', 'internal'] as const;
const purposes = ['product-guide', 'api-reference', 'test-handbook', 'internal-architecture', 'admin-guide', 'release-notes', 'support-handbook'] as const;
const catalog = () => structuredClone(reviewedCatalog([...all], [...purposes])) as unknown as Rec[];
const issues = (records: Rec[]) => checkOutlineConformance(records as never, records[0] as never).filter(issue => issue.code === 'READER_REQUIREMENT');
const article = (records: Rec[], prefix: string) => records.find(record => record.key.startsWith(prefix + '/'))!;
// The blocks after a level-2 heading, up to the next one.
function part(record: Rec, heading: string): Block[] {
  const blocks = record.data.blocks!;
  const start = blocks.findIndex(block => block.type === 'heading' && block.text === heading);
  const end = blocks.findIndex((block, index) => index > start && block.type === 'heading');
  return blocks.slice(start + 1, end < 0 ? undefined : end);
}
const table = (record: Rec, heading: string) => part(record, heading).find(block => block.type === 'table')!;
const list = (record: Rec, heading: string) => part(record, heading).find(block => block.type === 'list')!;
const expectIssue = (records: Rec[], key: string, pattern: RegExp) =>
  assert.ok(issues(records).some(issue => issue.key === key && pattern.test(issue.message)), 'Expected ' + pattern + ' on ' + key + ': ' + JSON.stringify(issues(records).map(issue => issue.message)));

test('documentation that meets every reader rule has no reader issues', () => {
  assert.deepEqual(issues(catalog()), []);
});

test('the outline tells the AI each rule it will be held to', () => {
  const design = designStructure({ appName: 'Acme', audiences: [...all], purposes: [...purposes] });
  const scenarios = design.articleOutlines.features!.find(item => item.heading === 'Test scenarios')!;
  assert.ok(scenarios.must!.some(line => /Success, Permission, Validation, Boundary, Conflict, Dependency failure/.test(line)));
  assert.ok(design.articleOutlines.api!.find(item => item.heading === 'Limits and behaviour')!.must!.some(line => /timeouts/.test(line)));
});

test('support needs exact messages, ordered checks and escalation evidence', () => {
  const records = catalog();
  const feature = article(records, 'features');
  const errors = table(feature, 'Errors and edge cases');
  errors.rows![0]![errors.columns!.find(column => column.label === 'What the user sees')!.key] = 'An error appears';
  table(feature, 'Check these first').rows!.splice(1);
  list(article(records, 'troubleshooting'), 'When to escalate').items = ['Escalate quickly.', 'Contact engineering.'];
  expectIssue(records, feature.key, /Errors and edge cases.*quote the exact message/);
  expectIssue(records, feature.key, /Check these first.*at least 2 rows/);
  expectIssue(records, article(records, 'troubleshooting').key, /When to escalate.*evidence engineering needs/);
});

test('testers need every scenario type, untested gaps and synthetic data', () => {
  const records = catalog();
  const feature = article(records, 'features');
  const scenarios = table(feature, 'Test scenarios');
  const type = scenarios.columns!.find(column => column.label === 'Type')!.key;
  scenarios.rows = scenarios.rows!.filter(row => row[type] !== 'Conflict');
  scenarios.rows[0]![type] = 'Happy';
  list(feature, 'Regression checks').items = ['Re-test sign-in after a change to the session code.', 'Re-test invites after a change to email.'];
  const data = article(records, 'test-scenarios');
  part(data, 'Test data').find(block => block.type === 'code')!.code = 'email: jane.doe@acme-airline.com';
  expectIssue(records, feature.key, /missing .*Conflict/);
  expectIssue(records, feature.key, /unknown Type values: Happy/);
  expectIssue(records, feature.key, /Not tested:/);
  expectIssue(records, data.key, /synthetic data only; replace jane.doe@acme-airline.com/);
});

test('product owners need checkable criteria and no metrics or roadmap claims', () => {
  const records = catalog();
  const feature = article(records, 'features');
  list(feature, 'Acceptance criteria').items = ['Sign-in works correctly for every member of the team.', 'The page loads within two seconds of the click.', 'Owners see the settings page after signing in.'];
  part(feature, 'Why it matters').find(block => block.type === 'paragraph')!.text = 'Members sign in once and keep working, which cuts support calls by 40% and keeps the session secure for every team member on every device.';
  part(feature, 'Overview').find(block => block.type === 'paragraph')!.text += ' Single sign-on will be added in a future release.';
  expectIssue(records, feature.key, /vague wording \("works correctly"\)/);
  expectIssue(records, feature.key, /Why it matters.*percentages/);
  expectIssue(records, feature.key, /not plans: remove "will be added"/);
});

test('developers need typed fields and limits; administrators need access and rollback', () => {
  const records = catalog();
  const api = article(records, 'api');
  const fields = table(api, 'Request fields');
  fields.rows![0]![fields.columns!.find(column => column.label === 'Type')!.key] = '';
  list(api, 'Limits and behaviour').items = ['Pages hold 50 items.', 'Results are sorted by name.', 'Deleted items are hidden.', 'Results are cached.'];
  const runbook = article(records, 'runbooks');
  list(runbook, 'Before you start').items = ['A laptop.', 'A stable network connection.'];
  const rollback = part(runbook, 'Roll back');
  rollback.splice(0, rollback.length, { id: 'na', type: 'callout', tone: 'info', text: 'Not applicable: this procedure changes nothing that would need to be undone.' });
  runbook.data.blocks = runbook.data.blocks!.filter(block => block.type !== 'list' || block !== list(runbook, 'Roll back'));
  const start = runbook.data.blocks.findIndex(block => block.type === 'heading' && block.text === 'Roll back');
  runbook.data.blocks.splice(start + 1, 0, ...rollback);
  expectIssue(records, api.key, /Request fields.*Type/);
  expectIssue(records, api.key, /must mention timeouts/);
  expectIssue(records, api.key, /must mention retries/);
  expectIssue(records, runbook.key, /Before you start.*access, role or permission/);
  expectIssue(records, runbook.key, /Roll back.*cannot be marked "Not applicable"/);
});

test('end users never see endpoints, tables or environment names', () => {
  const records = catalog();
  const feature = article(records, 'features');
  list(feature, 'Step by step').items!.push('Call POST /v1/sessions and read the session_token field.');
  expectIssue(records, feature.key, /End users see "POST \/v1\/sessions"/);
});

test('support sees risks in plain words; only developers see code-level known issues', () => {
  const design = designStructure({ appName: 'Acme', audiences: [...all], purposes: [...purposes] });
  const outline = design.articleOutlines.features!;
  assert.deepEqual(outline.find(item => item.heading === 'Known issues')!.audiences, ['developers', 'internal']);
  assert.deepEqual(outline.find(item => item.heading === 'Risks')!.audiences, ['support', 'testers', 'administrators']);
  const records = catalog();
  const feature = article(records, 'features');
  const risks = table(feature, 'Risks');
  risks.rows![0]![risks.columns![0]!.key] = 'POST /v1/i-perform/cron/sync-pending-iperform-emails has no AuthGuard.';
  expectIssue(records, feature.key, /Risks.*plain words/);
});
