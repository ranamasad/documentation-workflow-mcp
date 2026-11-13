# Moving projects between the hosted service and your own server

You can move a project **from the hosted dashboard to your own server**, or **from your own server to the hosted dashboard**, at any time.

## What moves and what stays

| | Moves? |
|---|---|
| The documentation (articles, releases, history) | **Stays** in your Firebase. Nothing is copied. |
| Readers, teams and administrators | **Stay** in your Firebase (`teams`, `feedbackAccess`, `adminAccess`). |
| Project name, ID and saved settings | Moves, in the move file. |
| Content keys of your encrypted releases | Move, in the move file. |
| A server's master key | **Never moves.** Each server keeps its own. |

### Why keys can move safely

Your documentation is not encrypted with a server's master key directly. Each project environment has its own **content key**, computed from the master key with a one-way function:

```
master key (stays on the server)  ──HMAC(project + environment + key ID)──▶  content key  ──encrypts──▶  your docs
```

The move file carries only your project's content keys. They open your project and nothing else, and the master key cannot be worked out from them. After the move, the **first publication in each environment switches to a new key from the new server's own master key** automatically. You can also do that immediately (`--reencrypt` or the dashboard does it for you).

**Treat the move file like a password.** It opens your encrypted documentation. Delete it when the move is done.

---

## Hosted dashboard → your own server

1. **Prepare your server.** Follow [GETTING-STARTED.md](GETTING-STARTED.md) steps 1 and 3, but do **not** run `project add`.
2. **Export.** In the dashboard open **Self-hosting**, choose the project, and click **Export for self-hosting**. Only owners and admins can do this. A file like `acme-docs-export.json` downloads.
3. **Get the service-account key** of the project's Firebase (the same key you uploaded to the dashboard, or a new one from Firebase console → Project settings → Service accounts).
4. **Import** on your server:

   ```bash
   npm run cli -- import acme-docs-export.json --key ./secrets/acme-docs-sa.json --site https://acme-docs.web.app --reencrypt
   ```

   `--reencrypt` immediately republishes each environment with your own key. Leave it out to switch on the next publication instead.
   `--site` is your reader website's address; it creates the website token for this server.
5. **Point the reader website to your server.** Start (or restart) the server, then:

   ```bash
   npm run cli -- site-config --project "Acme Docs" --url https://mcp.example.com
   ```

   Paste the output into the website's `assets/js/site-config.js` (in your copy of [documentation-workflow-site](https://github.com/ranamasad/documentation-workflow-site)) and deploy it with `firebase deploy --only hosting`.
6. **Point your AI to your server**: change the MCP URL to `https://mcp.example.com/mcp` and use your `MCP_BEARER_TOKEN`.
7. **Check** that readers can open the website and that `/health` shows your project.
8. **Clean up.** In the dashboard, remove the project. Delete the move file.

## Your own server → hosted dashboard

1. **Export** on your server:

   ```bash
   npm run cli -- export --project "Acme Docs" --out acme-docs-export.json
   ```

2. **Sign in to the hosted dashboard** and open **Self-hosting → Import a project**.
3. Choose the **workspace**, upload `acme-docs-export.json` and the project's **service-account key**, and click **Import**. The dashboard:
   - creates the project with the **same project ID** (required by the encryption scopes);
   - reads your existing teams, readers and administrators from Firestore so nobody loses access;
   - re-encrypts every environment with the hosted key.
4. **Point the reader website to the hosted service**: the dashboard's **Website** page deploys it for you, or shows the settings to use.
5. **Point your AI to the hosted MCP** and sign in.
6. **Clean up.** Remove the project from your `projects.json`, and delete the move file.

## Questions

**Do readers notice?** No, as long as you switch the website settings in the same sitting. Their access is unchanged.

**What about old releases (rollback history)?** With the imported keys kept in `projects.json` (`importedKeys`), your own server can still open older releases. The hosted dashboard re-encrypts the current release of each environment; older releases from before the move are not available for rollback there.

**Can I move back again later?** Yes. Each move is the same export and import.
