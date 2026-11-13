# Who can read the documentation website

Readers sign in with **Google**. What they may see is stored in the project's own Firestore, in three collections. The website's `firestore.rules` and this MCP server both enforce them.

| Collection | Document ID | Fields | Meaning |
|---|---|---|---|
| `teams` | a UUID | `name`, optional `environments` (list), optional `reader` | A group of readers. Without `environments` the team sees every environment. `reader` tailors content (`support`, `testers`, `developers`, `end-users`, `product-owners`, `administrators`, `internal`). |
| `feedbackAccess` | the person's email, lowercase | `enabled: true`, `teamId` | May sign in; their team decides what they see. |
| `adminAccess` | the person's email, lowercase | `enabled: true` | Website administrator: every environment. |

## With the CLI (recommended)

Run these in the MCP folder.

Create teams:

```bash
npm run cli -- team add Support --project "Acme Docs" --envs production --reader support
```

```bash
npm run cli -- team add QA --project "Acme Docs" --envs development,beta --reader testers
```

Add people:

```bash
npm run cli -- access add alice@acme.com --project "Acme Docs" --team Support
```

```bash
npm run cli -- access admin bob@acme.com --project "Acme Docs"
```

See who has access, and remove someone:

```bash
npm run cli -- access list --project "Acme Docs"
```

```bash
npm run cli -- access remove alice@acme.com --project "Acme Docs"
```

Changes apply on the reader's next page load. Removing someone stops new access at once; documentation they already downloaded stays on their device.

## With the Firebase console

1. Open Firebase console → **Firestore Database → Data**.
2. To add a team: **Start collection** `teams` (or open it), **Add document** with an auto-ID that is a UUID (for example from <https://www.uuidgenerator.net>), and fields `name` (string) and optionally `environments` (array of strings).
3. To add a reader: collection `feedbackAccess`, document ID = their email in lowercase, fields `enabled` (boolean `true`) and `teamId` (string, the team's document ID).
4. To add an administrator: collection `adminAccess`, document ID = their email in lowercase, field `enabled` (boolean `true`). Also give them a `feedbackAccess` document with `enabled: true`.

## Moving to the hosted dashboard later

The hosted dashboard manages these same documents from its **Team** page. When you import a self-hosted project there, it reads your existing teams and readers first, so nobody loses access. See [MOVING-PROJECTS.md](MOVING-PROJECTS.md).
