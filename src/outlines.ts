// Section templates and article outlines shared by designStructure (which proposes them) and the
// outline conformance check (which enforces them). Kept free of runtime imports so both can use it.
import type { Reader } from './workflows.js';
export type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
export interface SectionTemplate {
  id: string; label: string; collection: string; layout: 'cards' | 'list' | 'table'; icon: string;
  sort: { field: string; direction: 'asc' | 'desc' };
  for?: Reader[];
  fields: { key: string; label: string; type: FieldType }[];
  describe: string;
  example: { id: string; title: string; value: Record<string, unknown> };
}

// Section templates. Their ids, collections, layouts and field keys are mandatory: the outline conformance
// check rejects documentation that renames or extends them.
export const templates: Record<string, SectionTemplate> = {
  features: { id: 'features', label: 'Features', collection: 'features', layout: 'cards', icon: 'layout-grid',
    sort: { field: 'order', direction: 'asc' }, describe: 'What the product does, one article per user-facing capability.',
    fields: [{ key: 'summary', label: 'Summary', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }],
    example: { id: 'sign-in', title: 'Sign in', value: { summary: 'Sign in with your work account.', status: 'Available' } } },
  guides: { id: 'guides', label: 'How-to guides', collection: 'guides', layout: 'list', icon: 'book-open',
    sort: { field: 'order', direction: 'asc' }, describe: 'Step-by-step tasks written around the reader\'s goal.',
    fields: [{ key: 'goal', label: 'Goal', type: 'text' }, { key: 'duration', label: 'Time needed', type: 'text' }],
    example: { id: 'first-steps', title: 'First steps', value: { goal: 'Get set up and complete a first task.', duration: '5 minutes' } } },
  troubleshooting: { id: 'troubleshooting', label: 'Troubleshooting', collection: 'troubleshooting', layout: 'list', icon: 'life-buoy',
    sort: { field: 'title', direction: 'asc' }, describe: 'Symptoms, likely causes and what to do. Quote real on-screen messages.',
    fields: [{ key: 'symptom', label: 'Symptom', type: 'text' }, { key: 'cause', label: 'Cause', type: 'text' }, { key: 'resolution', label: 'Resolution', type: 'text' }],
    example: { id: 'cannot-sign-in', title: 'Cannot sign in', value: { symptom: 'The sign-in page shows "Access denied".', cause: 'Your account is not a member yet.', resolution: 'Ask an administrator to add you.' } } },
  faq: { id: 'faq', label: 'FAQ', collection: 'faq', layout: 'list', icon: 'circle-help',
    sort: { field: 'order', direction: 'asc' }, describe: 'Questions readers really ask, grouped by topic. Each question expands to its answer: what to do, how it helps, and a link to the full article.',
    fields: [{ key: 'audience', label: 'For', type: 'text' }, { key: 'questions', label: 'Questions', type: 'number' }],
    example: { id: 'access', title: 'Access and sign-in', value: { audience: 'Everyone', questions: 3 } } },
  glossary: { id: 'glossary', label: 'Glossary', collection: 'glossary', layout: 'list', icon: 'book-a',
    sort: { field: 'title', direction: 'asc' }, describe: 'Consistent definitions for terms used across the documentation.',
    fields: [{ key: 'definition', label: 'Definition', type: 'text' }],
    example: { id: 'workspace', title: 'Workspace', value: { definition: 'A shared space for one team\'s work.' } } },
  configuration: { id: 'configuration', label: 'Configuration', collection: 'settings', layout: 'table', icon: 'settings',
    sort: { field: 'title', direction: 'asc' }, describe: 'Every setting with its default, effect and who may change it. Never document secret values.',
    fields: [{ key: 'default', label: 'Default', type: 'text' }, { key: 'effect', label: 'Effect', type: 'text' }, { key: 'scope', label: 'Scope', type: 'text' }],
    example: { id: 'session-timeout', title: 'Session timeout', value: { default: '30 minutes', effect: 'Signs idle users out.', scope: 'Organization' } } },
  runbooks: { id: 'runbooks', label: 'Runbooks', collection: 'runbooks', layout: 'list', icon: 'wrench', for: ['administrators', 'support', 'internal'],
    sort: { field: 'title', direction: 'asc' }, describe: 'Operational procedures: when to use them, exact steps, verification and rollback.',
    fields: [{ key: 'trigger', label: 'When to use', type: 'text' }, { key: 'severity', label: 'Severity', type: 'text' }],
    example: { id: 'restore-access', title: 'Restore a member\'s access', value: { trigger: 'A member reports they cannot sign in.', severity: 'Medium' } } },
  api: { id: 'api', label: 'API reference', collection: 'endpoints', layout: 'table', icon: 'code', for: ['developers', 'testers', 'support', 'internal', 'administrators'],
    sort: { field: 'value.path', direction: 'asc' }, describe: 'Exact request/response contracts, authentication, errors and examples.',
    fields: [{ key: 'method', label: 'Method', type: 'text' }, { key: 'path', label: 'Path', type: 'text' }, { key: 'auth', label: 'Authentication', type: 'text' }],
    example: { id: 'list-items', title: 'List items', value: { method: 'GET', path: '/v1/items', auth: 'Bearer token' } } },
  errors: { id: 'errors', label: 'Errors', collection: 'errors', layout: 'table', icon: 'triangle-alert',
    sort: { field: 'value.code', direction: 'asc' }, describe: 'Every error code/message, its meaning and the fix. Keep messages verbatim.',
    fields: [{ key: 'code', label: 'Code', type: 'text' }, { key: 'message', label: 'Message', type: 'text' }, { key: 'resolution', label: 'Resolution', type: 'text' }],
    example: { id: 'unauthorized', title: 'Unauthorized', value: { code: '401', message: 'A valid token is required.', resolution: 'Sign in again or refresh the token.' } } },
  'release-notes': { id: 'release-notes', label: 'Release notes', collection: 'releases', layout: 'list', icon: 'megaphone',
    sort: { field: 'value.date', direction: 'desc' }, describe: 'What changed in each version, tagged New, Changed or Hotfix, linking to affected articles.',
    fields: [{ key: 'version', label: 'Version', type: 'text' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'highlights', label: 'Highlights', type: 'text' }],
    example: { id: 'v1-0-0', title: 'Version 1.0.0', value: { version: '1.0.0', date: '2026-10-16', highlights: 'First release.' } } },
  'test-scenarios': { id: 'test-scenarios', label: 'Test scenarios', collection: 'testScenarios', layout: 'table', icon: 'flask-conical', for: ['testers', 'product-owners', 'internal'],
    sort: { field: 'value.priority', direction: 'asc' }, describe: 'Acceptance criteria and test cases per feature for testers and product owners: preconditions, steps and expected result.',
    fields: [{ key: 'feature', label: 'Feature', type: 'text' }, { key: 'priority', label: 'Priority', type: 'text' }, { key: 'expected', label: 'Expected result', type: 'text' }],
    example: { id: 'sign-in-success', title: 'Sign in succeeds for a member', value: { feature: 'Sign in', priority: 'P1', expected: 'The member lands on the start page.' } } },
  'external-systems': { id: 'external-systems', label: 'External systems', collection: 'externalSystems', layout: 'cards', icon: 'plug',
    for: ['support', 'testers', 'product-owners', 'administrators', 'developers', 'internal'],
    sort: { field: 'title', direction: 'asc' }, describe: 'Third-party services the product depends on: what each is used for, how to check it is working, what users see when it fails and what to check before the product\'s own API.',
    fields: [{ key: 'provider', label: 'Provider', type: 'text' }, { key: 'usedFor', label: 'Used for', type: 'text' }, { key: 'owner', label: 'Internal owner', type: 'text' }],
    example: { id: 'email-provider', title: 'Email provider', value: { provider: 'Example Mail', usedFor: 'Sign-in and invite emails', owner: 'Platform team' } } },
  architecture: { id: 'architecture', label: 'Architecture', collection: 'components', layout: 'cards', icon: 'network', for: ['developers', 'internal'],
    sort: { field: 'order', direction: 'asc' }, describe: 'Components, responsibilities, data flows, owners and dependencies, with evidence references.',
    fields: [{ key: 'responsibility', label: 'Responsibility', type: 'text' }, { key: 'owner', label: 'Owner', type: 'text' }],
    example: { id: 'web-app', title: 'Web app', value: { responsibility: 'Serves the user interface.', owner: 'Frontend team' } } }
};

// Every article follows its section's outline: real headings and the block type that fits each part.
// The starter articles carry "[Write: …]" prompts that quality checks reject until they are replaced.
// A part with `for` is written only when one of those readers is selected; parts without it are for everyone.
export type Part = { heading: string; group?: string; block: 'question' | 'support-question' | 'paragraph' | 'list' | 'steps' | 'table' | 'code' | 'json' | 'diagram' | 'callout' | 'cards' | 'details'; write: string; columns?: string[]; for?: Reader[]; count?: number;
  /** Left out of compact outlines (depth "compact"): detail that other parts of the article already cover in brief. */
  compactSkip?: boolean };
export const TECHNICAL: Reader[] = ['support', 'testers', 'administrators', 'developers', 'internal'];
export const HANDS_ON: Reader[] = ['administrators', 'developers', 'internal'];
// Type is one of scenarioTypes (reader-rules.ts); a feature's scenario table must cover every type.
const scenarioColumns = ['Type', 'Scenario', 'Preconditions', 'Steps', 'Expected result', 'Priority'];
const errorColumns = ['Situation', 'What the user sees', 'Why it happens', 'What to do'];
export const outlines: Record<string, Part[]> = {
  // Parts carry a `group`: the website shows a long feature article as tabs (Overview, How to use, …).
  features: [
    { heading: 'Overview', group: 'Overview', block: 'paragraph', write: 'what the feature does and the problem it solves, in two or three sentences' },
    { heading: 'Linked features', group: 'Overview', block: 'cards', write: 'a card per feature this one needs or affects, each saying how they are linked (for example "Needs: Sign in", "Feeds: Reports")' },
    { heading: 'Why it matters', group: 'Overview', block: 'paragraph', for: ['product-owners'], write: 'the user problem it solves and who benefits, as the product implements it today (never invent metrics or plans)' },
    { heading: 'Who can use it', group: 'Overview', block: 'table', columns: ['Role', 'What they can do', 'Where'], write: 'each role and its permissions, from the access checks in the code' },
    { heading: 'How it works', group: 'Overview', block: 'diagram', for: ['support', 'testers', 'product-owners', 'administrators', 'developers', 'internal'], write: 'a Mermaid sequence or flowchart of the real flow between screens, services, external systems and data stores' },
    { heading: 'Step by step', group: 'How to use', block: 'steps', write: 'each step with the exact button, field and page names' },
    { heading: 'Settings and limits', group: 'How to use', block: 'table', columns: ['Setting or limit', 'Value or default', 'Effect'], write: 'every option, default, quota, size and time limit' },
    { heading: 'Business rules', group: 'How to use', block: 'table', columns: ['Rule (plain words)', 'Where it is enforced'], write: 'every validation, permission and business rule, and the screen, service or database rule that enforces it' },
    { heading: 'Frequently asked questions', group: 'Questions', block: 'question', count: 3, for: ['end-users'], write: 'the questions users ask about this feature, in their words, each with a direct answer, the steps and a link' },
    { heading: 'Customer questions for support', group: 'Questions', block: 'support-question', count: 3, for: ['support'], write: 'each question customers ask about this feature, with the answer to give, what to check, how to fix it and when to escalate' },
    { heading: 'Current limitations', group: 'Questions', block: 'list', for: ['product-owners', 'support'], write: 'what the feature does not do today and its known restrictions' },
    { heading: 'Errors and edge cases', group: 'Problems', block: 'table', columns: errorColumns, write: 'every error message (verbatim) and unusual case the code handles' },
    { heading: 'Check these first', group: 'Problems', block: 'table', columns: ['Order', 'Check', 'Where', 'If it fails'], for: ['support', 'testers', 'administrators', 'developers', 'internal'], write: 'the order to investigate a problem with this feature: first each external system it uses (status page, dashboard, logs), then its API endpoints, then the data; link each external system to its article' },
    { heading: 'What happens in each scenario', compactSkip: true, group: 'Problems', block: 'table', columns: ['Scenario', 'User did', 'What happens', 'User sees', 'Support should', 'HTTP status and final data state'], for: ['support', 'testers', 'developers', 'internal'], write: 'the success path and every failure path (validation, permission, network, external system down, conflict), with the status code and what is left in the database' },
    // Support, testers and administrators get the risks in plain words; only developers and engineering get the code-level issues.
    { heading: 'Risks', compactSkip: true, group: 'Problems', block: 'table', columns: ['Risk', 'Who notices it', 'What to do'], for: ['support', 'testers', 'administrators'], write: 'what can go wrong for users or operations, in plain words without code, endpoints or setting names, who notices it and what to do' },
    { heading: 'Known issues', group: 'Problems', block: 'list', for: ['developers', 'internal'], write: 'TODOs, known bugs and risky areas found in the code, with the cause and where it is' },
    { heading: 'Acceptance criteria', group: 'Testing', block: 'list', for: ['product-owners', 'testers'], write: 'each rule the feature satisfies, as checkable statements taken from the code' },
    { heading: 'Test scenarios', group: 'Testing', block: 'table', columns: scenarioColumns, for: ['testers', 'internal'], write: 'the happy path, permissions, validation errors, external system failures and edge cases' },
    { heading: 'Regression checks', compactSkip: true, group: 'Testing', block: 'list', for: ['testers'], write: 'what to re-test when this feature, its linked features or its external systems change' },
    { heading: 'Applications and services involved', compactSkip: true, group: 'Technical', block: 'cards', for: TECHNICAL, write: 'links to the architecture article of each app and service this feature runs in' },
    { heading: 'External systems used', group: 'Technical', block: 'cards', for: TECHNICAL, write: 'a card per third-party service (email, payments, maps, identity, storage…) linking to its External systems article' },
    { heading: 'Endpoints used', group: 'Technical', block: 'cards', for: TECHNICAL, write: 'a card per endpoint (title "METHOD /path") linking to its API reference article; write that API article too' },
    { heading: 'Data and JSON', group: 'Technical', block: 'json', for: TECHNICAL, write: 'the real request and response payloads, each followed by a field table (Field, Type, Required, Meaning, Example, Comes from, Stored in)' },
    { heading: 'Database tables and objects', group: 'Technical', block: 'table', columns: ['Table or collection', 'Read or written', 'Fields involved', 'Why'], for: TECHNICAL, write: 'every table, collection or object this feature reads or writes' },
    { heading: 'Events and background jobs', compactSkip: true, group: 'Technical', block: 'table', columns: ['Event, message or job', 'When it fires', 'What it does', 'Who consumes it'], for: TECHNICAL, write: 'events, queue messages, notifications and scheduled jobs this feature triggers' },
    { heading: 'Technical details', block: 'details', columns: ['File', 'Function or type', 'Purpose'], for: TECHNICAL, write: 'every source file, function or type involved and its purpose, for engineers' },
    { heading: 'Related', group: 'Overview', block: 'cards', write: 'links to the guides, troubleshooting and FAQ articles for this feature' }
  ],
  guides: [
    { heading: 'Before you start', block: 'list', write: 'required access, accounts, data and prerequisites' },
    { heading: 'Steps', block: 'steps', write: 'each action with the exact labels, values to enter and what appears next' },
    { heading: 'Check that it worked', block: 'list', write: 'what the reader should see when the task succeeded' },
    { heading: 'If something goes wrong', block: 'table', columns: errorColumns, write: 'the errors this task can show and how to fix each one' },
    { heading: 'Example', block: 'code', for: HANDS_ON, write: 'a complete worked example (command, request or input values)' },
    { heading: 'Technical details', block: 'details', columns: ['Step', 'Endpoint or component', 'What happens'], for: TECHNICAL, write: 'what happens behind the scenes for each step, for engineers' },
    { heading: 'Related', block: 'cards', write: 'links to the feature this task performs and relevant troubleshooting; explain each relationship and link back from the feature. If no related article applies, use a related-not-applicable callout with a specific source-backed reason' }
  ],
  'external-systems': [
    { heading: 'Overview', block: 'paragraph', write: 'what the service is, who provides it and exactly what the product uses it for' },
    { heading: 'Features that use it', block: 'cards', write: 'a card per feature that depends on this service, linking to the feature article' },
    { heading: 'How to check it is working', block: 'table', columns: ['Check', 'How', 'Healthy result'], write: 'the status page, provider dashboard, logs and a test action, in the order to try them' },
    { heading: 'When it fails', block: 'table', columns: ['Symptom', 'What users see', 'Affected features', 'What to do'], write: 'every failure the product can show when this service is slow, down, rejects a request or is misconfigured' },
    { heading: 'Before you blame the API', block: 'steps', for: ['support', 'testers', 'administrators', 'developers', 'internal'], write: 'the steps to rule this service in or out before investigating the product\'s own API and data' },
    { heading: 'Status page and contacts', block: 'table', columns: ['Resource', 'Where to find it', 'Notes'], write: 'status page, provider dashboard, support channel and the internal owner (never credentials)' },
    { heading: 'Configuration', block: 'table', columns: ['Setting', 'Where it is set', 'Effect'], for: ['administrators', 'developers', 'internal'], write: 'every setting that points the product at this service; name environment variables but never their secret values' },
    { heading: 'Technical details', block: 'details', columns: ['File', 'Function or type', 'Purpose'], for: TECHNICAL, write: 'where the product calls this service, timeouts and retries' }
  ],
  troubleshooting: [
    { heading: 'What you see', block: 'callout', write: 'the exact message or behaviour the reader sees' },
    { heading: 'Likely causes', block: 'table', columns: ['Cause', 'How to confirm it'], write: 'every cause the code can produce, most common first' },
    { heading: 'How to fix it', block: 'steps', write: 'the fix for each cause, step by step' },
    { heading: 'When to escalate', block: 'list', for: ['support', 'testers', 'administrators', 'internal'], write: 'when to escalate and the details engineering needs (IDs, time, screenshots, logs)' },
    { heading: 'Technical details', block: 'details', columns: ['Log message or code', 'Where it is raised', 'What it means'], for: TECHNICAL, write: 'log messages, error codes and the code path involved' },
    { heading: 'Related', block: 'cards', write: 'links to the affected feature and recovery guide with the reason each helps; link back from the feature. If none applies, use a related-not-applicable callout with a specific source-backed reason' }
  ],
  // One FAQ article per topic; every question is an expandable details block holding its answer.
  faq: [
    { heading: 'About these questions', block: 'paragraph', write: 'what this topic covers and who these questions are for' },
    { heading: '[Write: a question readers really ask, in their words] What do readers ask here?', block: 'question', write: 'the answer' },
    { heading: '[Write: a question readers really ask, in their words] What do readers ask here?', block: 'question', write: 'the answer' },
    { heading: '[Write: a question readers really ask, in their words] What do readers ask here?', block: 'question', write: 'the answer' },
    { heading: 'Related', block: 'cards', write: 'links to the guides and features these questions refer to' }
  ],
  glossary: [
    { heading: 'Definition', block: 'paragraph', write: 'the definition as used in this product' },
    { heading: 'Example', block: 'paragraph', write: 'where the reader meets this term' },
    { heading: 'Related', block: 'cards', write: 'related terms and articles' }
  ],
  configuration: [
    { heading: 'What it controls', block: 'paragraph', write: 'the behaviour this setting changes' },
    { heading: 'Values', block: 'table', columns: ['Value', 'Effect', 'Default'], write: 'every allowed value and its effect' },
    { heading: 'How to change it', block: 'steps', write: 'where and how to change it, and who may' },
    { heading: 'Example', block: 'code', for: HANDS_ON, write: 'an example configuration (never real secrets)' },
    { heading: 'Side effects and risks', block: 'callout', write: 'what else changes and what can break' }
  ],
  runbooks: [
    { heading: 'When to use this', block: 'paragraph', write: 'the trigger and the symptoms' },
    { heading: 'Before you start', block: 'list', write: 'access, tools and checks needed' },
    { heading: 'Procedure', block: 'steps', write: 'each step with exact commands or console paths' },
    { heading: 'Commands', block: 'code', write: 'the commands to run, with placeholders for IDs' },
    { heading: 'Verify', block: 'list', write: 'how to confirm the system is healthy again' },
    { heading: 'Roll back', block: 'steps', write: 'how to undo the change safely' }
  ],
  api: [
    { heading: 'Overview', group: 'Overview', block: 'paragraph', write: 'what the endpoint does and when to call it' },
    { heading: 'Authentication and permissions', group: 'Overview', block: 'table', columns: ['Requirement', 'Details'], write: 'the token or session it needs and every role or permission check' },
    { heading: 'Request fields', group: 'Request', block: 'table', columns: ['Field', 'In', 'Type', 'Required', 'Meaning', 'Example'], write: 'every path, query, header and body field, with validation rules' },
    { heading: 'Example request', group: 'Request', block: 'code', write: 'a complete curl or SDK request' },
    { heading: 'Response fields', group: 'Response', block: 'table', columns: ['Field', 'Type', 'Always present', 'Meaning', 'Example'], write: 'every field of the success response' },
    { heading: 'Example response', group: 'Response', block: 'json', write: 'a complete example response body' },
    { heading: 'Errors', group: 'Errors and limits', block: 'table', columns: ['Status', 'Code', 'Message', 'Cause and fix'], write: 'every error response, messages verbatim' },
    { heading: 'Side effects', group: 'Errors and limits', block: 'table', columns: ['Table, event or service', 'What changes'], write: 'the data it writes, the events it emits and the services it calls' },
    { heading: 'Used by', group: 'Overview', block: 'cards', write: 'links to the feature articles that call this endpoint' },
    { heading: 'Limits and behaviour', group: 'Errors and limits', block: 'list', write: 'rate limits, pagination, idempotency and timeouts' },
    { heading: 'Technical details', block: 'details', columns: ['File', 'Function', 'Purpose'], write: 'the route handler and service functions, for engineers' }
  ],
  errors: [
    { heading: 'What it means', block: 'paragraph', write: 'the meaning of the error in plain words' },
    { heading: 'When it happens', block: 'list', write: 'every situation that triggers it' },
    { heading: 'How to fix it', block: 'steps', write: 'the fix the reader can apply' },
    { heading: 'Technical details', block: 'details', columns: ['Error code', 'HTTP status', 'Endpoint', 'Raised in'], for: TECHNICAL, write: 'error code, HTTP status and where it is raised' }
  ],
  'release-notes': [
    { heading: 'Highlights', block: 'paragraph', write: 'the most important changes in this exact version; state Documentation-only if application behavior is unchanged, or Application changes when the product implementation changed' },
    { heading: 'Changes', block: 'table', columns: ['Change', 'Type', 'Affected area', 'Details'], write: 'every New, Changed and Hotfix item' },
    { heading: 'Action needed', block: 'callout', write: 'anything readers must do after this release, or say that nothing is needed' },
    { heading: 'Affected articles', block: 'cards', write: 'links to the updated articles' }
  ],
  'test-scenarios': [
    { heading: 'Goal', block: 'paragraph', write: 'what this scenario proves' },
    { heading: 'Preconditions', block: 'list', write: 'accounts, roles, data and settings needed' },
    { heading: 'Steps', block: 'steps', write: 'each tester action with exact inputs' },
    { heading: 'Expected results', block: 'list', write: 'what must happen after each step' },
    { heading: 'Variations and edge cases', block: 'table', columns: scenarioColumns, write: 'negative, permission and boundary cases' },
    { heading: 'Test data', block: 'code', write: 'sample inputs (no real customer data)' }
  ],
  architecture: [
    { heading: 'Responsibility', block: 'paragraph', write: 'what this component owns' },
    { heading: 'How it fits', block: 'diagram', write: 'a Mermaid diagram of its connections' },
    { heading: 'Interfaces', block: 'table', columns: ['Interface', 'Direction', 'Protocol', 'Purpose'], write: 'every API, event and data store it uses or exposes' },
    { heading: 'Data', block: 'table', columns: ['Entity or collection', 'Key fields', 'Notes'], write: 'the data it reads and writes' },
    { heading: 'Operations', block: 'list', write: 'deployment, monitoring, scaling and known issues' },
    { heading: 'Source references', block: 'details', columns: ['Repository or folder', 'Main symbols', 'Purpose'], write: 'repositories, folders and main symbols' },
    { heading: 'Related', block: 'cards', write: 'links to supported features and connected architecture components, explaining the dependency; link back from supported features. If none applies, use a related-not-applicable callout with a specific source-backed reason' }
  ]
};

/**
 * The outline parts these readers need. With several readers, a part for only some of them carries
 * `audiences`: the website shows it to those readers (and to administrators, with a reader badge).
 */
export type Depth = 'standard' | 'compact';
/** Compact articles keep every reader's essential parts with fewer repeated questions and fewer words. */
export const depthLimits: Record<Depth, { articleWords: number; questions: number }> = {
  // Minimums are floors, kept low so a short, true article passes; padding is rejected by DUPLICATE_CONTENT/BOILERPLATE.
  standard: { articleWords: 250, questions: 3 },
  compact: { articleWords: 150, questions: 2 }
};
/** The depth the foundation declares in audienceCoverage.depth (standard when absent). */
export function depthOf(foundation: { data?: unknown } | undefined): Depth {
  const coverage = (foundation?.data as { audienceCoverage?: { depth?: unknown } } | undefined)?.audienceCoverage;
  return coverage?.depth === 'compact' ? 'compact' : 'standard';
}

export function outlineFor(section: string, chosen: Reader[], depth: Depth = 'standard'): (Part & { audiences?: Reader[] })[] {
  return (outlines[section] ?? outlines.features!).filter(part => depth !== 'compact' || !part.compactSkip)
    .map(part => depth === 'compact' && part.count ? { ...part, count: Math.min(part.count, depthLimits.compact.questions) } : part).flatMap(part => {
    if (!part.for) return [part];
    const audience = chosen.filter(reader => part.for!.includes(reader));
    if (!audience.length) return [];
    return [audience.length < chosen.length ? { ...part, audiences: audience } : part];
  });
}
