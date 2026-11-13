# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's **Report a vulnerability** button on this repository's *Security* tab (private advisory). Include what you found, how to reproduce it and its impact.

We reply within 5 working days and keep you informed until it is fixed. We credit reporters who wish to be named.

## Supported versions

Security fixes go into the latest release. Update regularly (`git pull`, `npm ci`, `npm run build`).

## Keeping your installation safe

- Never commit `.env`, `projects.json`, service-account keys or move files.
- Use a long random `MCP_BEARER_TOKEN` (`openssl rand -hex 32`) and serve the MCP only over HTTPS.
- Back up `MCP_DOCUMENTATION_ENCRYPTION_KEY` securely and restrict who can read it.
- Give the Firebase service account only the roles it needs (Cloud Datastore User for Firestore).
