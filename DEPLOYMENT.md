# NeuroVerseOS Governance Plugin — Docker Deployment Guide

This guide explains how to deploy and update the NeuroVerseOS governance plugin when running OpenClaw inside Docker on any VPS (Hostinger, DigitalOcean, AWS, etc.).

It assumes:
- OpenClaw is already running in Docker
- You have SSH access to your server
- You have cloned this repository on the host machine

---

## Architecture Overview

When running in Docker, OpenClaw uses:

```
/data
├── .openclaw
│    ├── workspace          ← Your markdown governance files live here
│    └── extensions         ← Installed plugins live here
└── .neuroverse             ← Compiled world.json + runtime state
```

Important:

- Markdown files are read from: `/data/.openclaw/workspace`
- NeuroVerse compiled world + runtime state is stored in: `/data/.neuroverse`
- The plugin itself lives in: `/data/.openclaw/extensions/neuroverseos-governance`

---

## Host vs Container

This is critical.

If your prompt looks like:

```
root@abc123def456
```

You are **inside** the Docker container.

Docker commands (`docker cp`, `docker restart`, etc.) must be run on the **host machine** — not inside the container.

---

## Initial Installation (Docker)

### Step 1 — Clone the repository (on host)

```bash
git clone https://github.com/<your-org>/neuroverseos-openclaw-governance.git
cd neuroverseos-openclaw-governance
```

### Step 2 — Install dependencies and build

```bash
npm install
npm run build
```

This generates the compiled plugin in:

```
dist/
```

### Step 3 — Find your OpenClaw container name

```bash
docker ps
```

Look for a container running OpenClaw. Example output:

```
openclaw-xyz-1
```

Use that name in the next step.

### Step 4 — Copy plugin into container

```bash
docker cp dist/. <openclaw-container-name>:/data/.openclaw/extensions/neuroverseos-governance/dist/
```

Example:

```bash
docker cp dist/. openclaw-xyz-1:/data/.openclaw/extensions/neuroverseos-governance/dist/
```

### Step 5 — Restart OpenClaw

```bash
docker restart <openclaw-container-name>
```

The plugin will now load automatically.

---

## Verifying Plugin Load

Check container logs:

```bash
docker logs <openclaw-container-name>
```

You should see:

```
[NeuroVerse] Governance plugin loaded (v1.0.0)
```

If you see:

```
No world file found. Run /world bootstrap to create one.
```

That is expected on first run.

---

## Creating Your Governance World

Inside OpenClaw, run:

```
/world bootstrap
```

The plugin will:

- Scan `/data/.openclaw/workspace` for all `.md` files
- Compile them into `world.json`
- Store the compiled world in `/data/.neuroverse`

No specific filenames are required. All `.md` files in the workspace are included.

---

## Updating the Plugin

When you push changes to the plugin:

**On the host:**

```bash
cd <plugin-directory>
git pull
npm install
npm run build
docker cp dist/. <openclaw-container-name>:/data/.openclaw/extensions/neuroverseos-governance/dist/
docker restart <openclaw-container-name>
```

You do **NOT** need to reinstall the plugin.

---

## Troubleshooting

### "No .md files found in workspace"

Check inside the container:

```bash
docker exec -it <openclaw-container-name> bash
ls /data/.openclaw/workspace
```

If no files appear, you must add your governance `.md` files there.

If files exist and are not detected, verify the plugin workspace path configuration.

### Permission Errors

If you see errors like:

```
EACCES: permission denied
```

Verify that `/data` is writable inside the container:

```bash
ls -la /data
```

NeuroVerse automatically detects writable `/data` volumes in Docker.

---

## Storage Model

- **Source of truth** → Markdown in `/data/.openclaw/workspace`
- **Compiled world** → `/data/.neuroverse/world.json`
- **Drift detection** → Hash comparison of workspace markdown files
- **Runtime state** → Stored in `/data/.neuroverse`

---

## Security Note

If you see:

```
plugins.allow is empty; discovered non-bundled plugins may auto-load
```

You can explicitly trust the plugin in `openclaw.json` by adding it to `plugins.allow`.

---

## Summary

To deploy or update:

1. Build on host
2. Copy `dist/` into container
3. Restart container
4. Run `/world bootstrap`

That's it.

NeuroVerseOS is now fully portable across VPS providers.
