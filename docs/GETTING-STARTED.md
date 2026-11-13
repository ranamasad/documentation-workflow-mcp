# Getting started for beginners

This guide takes you from nothing to published, encrypted documentation that your team can read. No prior Firebase or server experience is needed. Plan about **45 minutes**.

You will set up three things:

| Piece | What it is | Where it runs |
|---|---|---|
| **Firebase project** | Google's database (Firestore) and sign-in (Authentication). Your documentation lives here. | Google, free tier is enough to start |
| **MCP server** (this repository) | The program your AI talks to. It encrypts and publishes documentation. | Your computer first, a server later |
| **Reader website** ([documentation-workflow-site](https://github.com/ranamasad/documentation-workflow-site)) | The website where people read the documentation. | Firebase Hosting |

## 1. Install the tools

1. **Node.js 20 or newer**: download the LTS version from <https://nodejs.org>. Check it in a terminal:

   ```bash
   node --version
   ```

   It should print `v20…` or higher.

2. **Git**: <https://git-scm.com/downloads> (macOS already has it after `xcode-select --install`).

3. **Firebase CLI**, used to put the reader website online:

   ```bash
   npm install -g firebase-tools
   ```

   ```bash
   firebase login
   ```

## 2. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Create a project**. Pick a name such as `acme-docs`. Note the **project ID** shown under the name (for example `acme-docs` or `acme-docs-1a2b3`); you will use it many times.
2. **Firestore:** in the left menu choose **Build → Firestore Database → Create database**. Choose a location near your readers and **Start in production mode**.
3. **Google sign-in:** choose **Build → Authentication → Get started → Sign-in method → Google → Enable**. Pick a support email and save.
4. **Web app settings:** click ⚙ **Project settings → General**. Under *Your apps*, click the **`</>`** (Web) icon, give it any nickname, and register it (Hosting can be skipped here). Keep the `firebaseConfig` values visible; you need them in step 5.
5. **Service-account key:** in ⚙ **Project settings → Service accounts**, click **Generate new private key**. A `.json` file downloads. This file can read and write your database: **never share it or commit it to Git**.

## 3. Set up the MCP server

```bash
git clone https://github.com/ranamasad/documentation-workflow-mcp.git
cd documentation-workflow-mcp
npm ci
npm run build
npm run cli -- init --owner you@example.com
```

Use your own email. This created two private files:

- `.env`: the server's secrets. Open it and **copy `MCP_DOCUMENTATION_ENCRYPTION_KEY` into your password manager now.** If this key is lost, encrypted documentation cannot be read.
- `projects.json`: your project list (empty for now).

Move the downloaded service-account key into a `secrets` folder:

```bash
mkdir -p secrets
```

```bash
mv ~/Downloads/acme-docs-*.json secrets/acme-docs-sa.json
```

Add your project. Replace `acme-docs` with your Firebase project ID. The two `--site` addresses are the live website and the local preview you will use while testing:

```bash
npm run cli -- project add --name "Acme Docs" --firebase acme-docs --key ./secrets/acme-docs-sa.json --site https://acme-docs.web.app,http://localhost:4173
```

Start the server and leave this terminal open:

```bash
npm start
```

Check it in your browser: <http://127.0.0.1:4318/health> should show `"projects":1` and `"encryption":true`.

## 4. Connect your AI

Find your token (the value after `MCP_BEARER_TOKEN=`):

```bash
grep MCP_BEARER_TOKEN .env
```

**Claude Code** (in another terminal):

```bash
claude mcp add --transport http documentation-workflow http://127.0.0.1:4318/mcp --header "Authorization: Bearer PASTE_TOKEN_HERE"
```

**VS Code with GitHub Copilot:** in your product's repository create `.vscode/mcp.json` from [examples/vscode.mcp.json](../examples/vscode.mcp.json), change the URL to `http://127.0.0.1:4318/mcp`, then open the Copilot chat in **Agent** mode. VS Code asks for the token the first time.

## 5. Set up the reader website

In a new terminal:

```bash
git clone https://github.com/ranamasad/documentation-workflow-site.git
cd documentation-workflow-site
npm ci
```

1. Open `assets/js/auth-config.js` and replace every `YOUR_…` value with the `firebaseConfig` values from step 2.4.
2. Print the website settings from the MCP folder:

   ```bash
   npm run cli -- site-config --project "Acme Docs" --url http://127.0.0.1:4318
   ```

   Paste the printed block into the website's `assets/js/site-config.js`, replacing what is there. (When the MCP runs on a real server, run this again with its `https://` address.)
3. Put the security rules online (they decide who may read):

   ```bash
   firebase deploy --only firestore:rules --project acme-docs
   ```

4. Preview the website on your computer:

   ```bash
   npm run preview
   ```

   Open <http://localhost:4173>. It asks you to sign in with Google.

## 6. Give yourself access

Back in the MCP folder:

```bash
npm run cli -- access admin you@example.com --project "Acme Docs"
```

Administrators can read every environment. Reload the website and sign in.

## 7. Write and publish your first documentation

Open your product's repository in your AI app and ask:

> Write the documentation for this repository using the documentation-workflow MCP. Project: Acme Docs.

The AI asks who the readers are, estimates the work, reads the code, writes the articles, checks them and asks your approval before publishing to **development**. Reload the website: your documentation is there.

Later you can say *"promote development to production"* or *"roll back production"*.

## 8. Put it online for your team

Your laptop works for you alone. When other people need to read encrypted documentation, the MCP must be reachable on the internet over HTTPS:

1. Deploy the MCP: [DEPLOY.md](DEPLOY.md) (Docker, a VPS or Vercel).
2. Run `site-config` again with the server's `https://` address and paste it into the website.
3. Put the website online:

   ```bash
   firebase deploy --only hosting,firestore:rules --project acme-docs
   ```

4. Add your readers: [READER-ACCESS.md](READER-ACCESS.md).

## Troubleshooting

| You see | Do this |
|---|---|
| `/health` does not load | Is `npm start` still running? Is the port 4318 free? |
| AI says *"A valid MCP bearer token is required"* | The token in your AI settings does not match `MCP_BEARER_TOKEN` in `.env`. |
| AI says the project is not in projects.json | Restart `npm start` after adding a project. |
| *"service-account key … belongs to X, not Y"* | You downloaded the key from another Firebase project. |
| Website says *Website membership required* | Add the person with `access add` or `access admin` (step 6). |
| Website says *Site access denied* | The address in your browser is not in the project's `site.origins` in `projects.json`. Add it and restart. |
| *Firestore refused this key* | In Google Cloud console → IAM, give the service account the **Cloud Datastore User** role. |
