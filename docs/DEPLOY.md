# Deploy the MCP server

For a team, run the MCP where everyone (and every reader's browser) can reach it over **HTTPS**. Pick one option.

Whatever you choose, the server needs:

- the secrets from `.env` (`MCP_BEARER_TOKEN`, `MCP_VALIDATION_SIGNING_KEY`, `MCP_DOCUMENTATION_ENCRYPTION_KEY`, optional `GEMINI_API_KEY` / `GROQ_API_KEY`);
- `MCP_ALLOWED_HOSTS` set to its public hostname, for example `mcp.example.com`;
- `MCP_PUBLIC_URL` set to its public address, for example `https://mcp.example.com`;
- your projects (`projects.json` plus the service-account keys).

After deploying, check `https://<your-server>/health`, then run `npm run cli -- site-config --project "<name>" --url https://<your-server>` and put the result in the reader website.

## Option A: Docker (any server or cloud that runs containers)

```bash
docker build -t documentation-mcp .
```

```bash
docker run -d --name documentation-mcp --restart unless-stopped -p 4318:4318 --env-file .env -e MCP_ALLOWED_HOSTS=mcp.example.com -e MCP_PUBLIC_URL=https://mcp.example.com -v "$PWD/projects.json:/app/projects.json" -v "$PWD/secrets:/app/secrets:ro" -v "$PWD/.mcp-data:/app/.mcp-data" documentation-mcp
```

Put an HTTPS proxy in front (Caddy is the simplest: `mcp.example.com { reverse_proxy localhost:4318 }`). Mount `projects.json` read-write if you want the AI to save project settings.

## Option B: a VPS without Docker (Ubuntu example)

```bash
git clone https://github.com/ranamasad/documentation-workflow-mcp.git
cd documentation-workflow-mcp && npm ci && npm run build
```

Copy `.env`, `projects.json` and `secrets/` from your computer (for example with `scp`), add `HOST=127.0.0.1`, `MCP_ALLOWED_HOSTS` and `MCP_PUBLIC_URL` to `.env`, and keep it running with a systemd service:

```ini
# /etc/systemd/system/documentation-mcp.service
[Unit]
Description=Documentation Workflow MCP
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/documentation-workflow-mcp
ExecStart=/usr/bin/npm start
Environment=NODE_ENV=production
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now documentation-mcp
```

Then add HTTPS with Caddy or Nginx + Let's Encrypt, proxying to `127.0.0.1:4318`.

## Option C: Vercel (serverless)

1. Fork this repository and import it in Vercel (framework preset **Other**; `vercel.json` sets everything else).
2. Serverless functions have no permanent disk, so give the projects as environment variables:
   - `MCP_PROJECTS_JSON`: the whole content of `projects.json`, with `"serviceAccountKeyEnv": "ACME_DOCS_SA"` instead of `serviceAccountKeyFile` in each project;
   - `ACME_DOCS_SA`: the full JSON of that service-account key;
   - the secrets from `.env`, plus `MCP_ALLOWED_HOSTS` (your Vercel domain) and `MCP_PUBLIC_URL`.
3. Deploy.

Limits on Vercel: the AI cannot save project settings (the projects come from a variable), and very large documentation staged in several parts may fail because each request can land on a different instance. For large projects prefer Docker or a VPS.

## Updating

```bash
git pull && npm ci && npm run build
```

Then restart the service (or rebuild the Docker image, or redeploy on Vercel). Your `.env`, `projects.json` and `secrets/` are never touched by updates.

## Backups

Back up three things: `.env` (above all `MCP_DOCUMENTATION_ENCRYPTION_KEY`), `projects.json` and `secrets/`. The documentation itself is in Firestore; use Firestore's own backups for it.
