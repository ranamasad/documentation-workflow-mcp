# Documentation Workflow MCP (self-hosted)

An MCP server that lets your AI assistant (Claude, GitHub Copilot, Cursor and others) **write, check, publish, promote and roll back documentation** for your product. The documentation is stored in **your own Firebase**, encrypted, and shown to readers on the [Documentation Workflow reader website](https://github.com/ranamasad/documentation-workflow-site).

This is the open-source, self-hosted edition. You run everything yourself: no account with us, and nothing is sent to us.

> **New to this?** Follow [Getting started for beginners](docs/GETTING-STARTED.md). It explains every step, including creating the Firebase project.

## What you get

| Feature | Self-hosted (this repo) | Hosted service |
|---|---|---|
| AI tools: write, validate, publish, promote, roll back, migrate | ✅ | ✅ |
| Encrypted (v3) documentation in your Firebase | ✅ your own key | ✅ managed key |
| Reader website with Google sign-in, teams and environments | ✅ | ✅ |
| Orbit: readers ask questions about the docs | ✅ your Gemini/Groq key | ✅ |
| Issues and FAQ raised from the website | ✅ | ✅ |
| Reader access (teams, admins) | CLI, or Firebase console | Dashboard screens |
| Dashboard, workspaces, invitations, personal tokens per person | ❌ | ✅ |
| Analytics screens, release manager, one-click site deploy | ❌ | ✅ |
| Server, backups, updates | You | Us |

Want the dashboard instead? Use the hosted service at <https://documentation-workflow.withwilco.com>. You can [move projects between the two](docs/MOVING-PROJECTS.md) in either direction at any time.

## How it works

```
Your AI ──(MCP + bearer token)──▶ this server ──(service-account key)──▶ your Firebase (Firestore)
                                     │ holds MCP_DOCUMENTATION_ENCRYPTION_KEY       ▲
                                     │ encrypts before writing                      │ ciphertext only
Readers ──(Google sign-in)──▶ reader website ──(asks for the key)──▶ this server ───┘
                                                 /api/documentation-v3
```

- **Publishing:** your AI calls the tools here; this server encrypts the documentation and writes it to your Firestore with the project's service-account key.
- **Reading:** the reader website signs people in with Google, then asks this server for the decryption key. The server checks the reader against **your Firestore** (`teams`, `feedbackAccess`, `adminAccess`) before handing out the key. Browsers decrypt locally.
- **Your projects** are listed in `projects.json`. Whoever holds `MCP_BEARER_TOKEN` is the owner of all of them.

## Quick start (5 minutes, on your computer)

You need **Node.js 20 or newer** and a Firebase project with Firestore (see [Getting started](docs/GETTING-STARTED.md#2-create-the-firebase-project) if you don't have one).

```bash
git clone https://github.com/ranamasad/documentation-workflow-mcp.git
cd documentation-workflow-mcp
npm ci
npm run build
npm run cli -- init --owner you@example.com
```

`init` creates `projects.json` and a `.env` with a fresh bearer token, signing key and encryption key. **Back up `MCP_DOCUMENTATION_ENCRYPTION_KEY` now** (a password manager is fine). Without it, encrypted documentation cannot be read.

Download your Firebase service-account key (Firebase console → ⚙ Project settings → Service accounts → **Generate new private key**), save it as `secrets/my-docs-sa.json`, then add the project:

```bash
npm run cli -- project add --name "My Docs" --firebase my-firebase-project-id --key ./secrets/my-docs-sa.json --site https://my-firebase-project-id.web.app
```

Start the server:

```bash
npm start
```

Open <http://127.0.0.1:4318/health>. You should see `"projects":1` and `"encryption":true`.

Now [connect your AI](#connect-your-ai) and ask it: *"Write the documentation for this repository."*

## Connect your AI

The server address is `http://127.0.0.1:4318/mcp` on your computer, or `https://<your-server>/mcp` once deployed. The token is `MCP_BEARER_TOKEN` from `.env`.

**Claude Code**

```bash
claude mcp add --transport http documentation-workflow https://your-server.example.com/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

**VS Code (GitHub Copilot)**: save [examples/vscode.mcp.json](examples/vscode.mcp.json) as `.vscode/mcp.json`, replace `YOUR-MCP-DOMAIN`, and VS Code asks for the token once.

**Claude Desktop, Cursor and other MCP apps**: use [examples/claude.mcp.json](examples/claude.mcp.json) and set `DOCUMENTATION_WORKFLOW_MCP_TOKEN` in your environment.

**Only on your own computer, no server at all (stdio)**: point your AI at the command `npm run start:stdio` in this folder. It reads the same `projects.json` and `.env`. Readers of encrypted documentation still need a reachable server, so use this for writing and publishing only.

## projects.json

```json
{
  "owner": "you@example.com",
  "projects": [
    {
      "id": "6f1c2a4e-1b2c-4d3e-8f90-123456789abc",
      "name": "My Docs",
      "firebaseProject": "my-firebase-project-id",
      "environments": ["development", "beta", "production"],
      "serviceAccountKeyFile": "./secrets/my-docs-sa.json",
      "settings": {},
      "site": { "token": "dsite_…", "origins": ["https://my-firebase-project-id.web.app"] },
      "importedKeys": {}
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `owner` | Your email. Recorded as the author of releases. |
| `id` | Created for you. It is part of every encryption scope: **never change it** after publishing. |
| `name` | What you and your AI call the project. |
| `firebaseProject` | The Firebase project ID that stores this documentation. |
| `environments` | Which of `development`, `beta`, `production` you use. |
| `serviceAccountKeyFile` / `serviceAccountKeyEnv` | The service-account key: a file path (relative to `projects.json`) or the name of an environment variable holding the JSON. |
| `settings` | Saved answers (repositories, readers…). Your AI fills this in with your permission. |
| `site` | The reader website: `token` identifies the site to this server, `origins` are the exact website addresses allowed to ask for keys. |
| `importedKeys` | Content keys brought from another server when a project moved here. Leave empty otherwise. |

`projects.json`, `secrets/`, `.env` and `.mcp-data/` are in `.gitignore`. **Never commit them.**

## Give people access to the reader website

Readers sign in with Google. Access lives in the project's own Firestore, managed with the CLI:

```bash
npm run cli -- team add Support --project "My Docs" --envs production --reader support
npm run cli -- access add alice@example.com --project "My Docs" --team Support
npm run cli -- access admin bob@example.com --project "My Docs"
npm run cli -- access list --project "My Docs"
npm run cli -- access remove alice@example.com --project "My Docs"
```

Full details, including doing the same in the Firebase console: [docs/READER-ACCESS.md](docs/READER-ACCESS.md).

## Deploy it for your team

Your laptop is fine for one person. For a team (and for readers of encrypted docs) run it on a server with HTTPS. Step-by-step guides for **Docker**, a **VPS** and **Vercel**: [docs/DEPLOY.md](docs/DEPLOY.md).

## Orbit and issue write-ups (optional)

Set `GEMINI_API_KEY` (and optionally `GROQ_API_KEY` as a fallback) in `.env`. Readers can then ask Orbit questions on the website, and issues they raise get a clear write-up. Without keys everything else still works.

## Move a project between the hosted service and your server

- **Hosted → here:** dashboard → **Self-hosting** → *Export for self-hosting*, then `npm run cli -- import <file> --key <service-account.json>`.
- **Here → hosted:** `npm run cli -- export --project "My Docs"`, then dashboard → **Self-hosting** → *Import a project*.

Your documentation never moves: it stays in your Firebase. Only the project's settings and its content keys travel, never a server's master key. Full guide: [docs/MOVING-PROJECTS.md](docs/MOVING-PROJECTS.md).

## Command reference

| Command | What it does |
|---|---|
| `npm run build` | Compile (run after every update). |
| `npm start` | Run the HTTP server (`PORT`, `HOST` from `.env`). |
| `npm run start:stdio` | Run as a local stdio MCP for one AI app. |
| `npm run cli -- help` | List every CLI command. |
| `npm test` | Build and run the tests. |

## Security

- The bearer token gives full owner access to every project. Share it only with people who should publish.
- The service-account key can read and write your Firestore. Keep it in `secrets/` (git-ignored) or in your host's secret store.
- `MCP_DOCUMENTATION_ENCRYPTION_KEY` never leaves this server. Back it up. If you lose it, encrypted docs must be republished from source.
- Encryption is server-managed (the server and the AI host can read content), not end-to-end.
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

In short: use it, change it and self-host it freely. If you change it **and** let other people use your changed version over a network, you must offer those users your changed source code under the same license. Commercial licenses without this obligation are available: contact the maintainers.

"Documentation Workflow" and its logo are trademarks of the maintainers; see [TRADEMARKS.md](TRADEMARKS.md). Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
