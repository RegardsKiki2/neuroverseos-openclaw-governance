# NeuroVerseOS — Local (Non-Docker) Setup Guide

This guide explains how to install and run the NeuroVerseOS governance plugin when OpenClaw is running directly on your machine (no Docker).

---

## Architecture (Local Mode)

When OpenClaw runs locally, it creates a workspace in your home directory:

```
~/.openclaw
├── workspace        ← Your markdown governance files
├── extensions       ← Installed plugins
└── openclaw.json
```

NeuroVerse storage will be created at:

```
~/.neuroverse
```

So in local mode:

- **Workspace** → `~/.openclaw/workspace`
- **Compiled world** → `~/.neuroverse/world.json`

---

## Prerequisites

- Node.js 18+ (20 recommended)
- npm
- OpenClaw installed globally

Check versions:

```bash
node -v
npm -v
```

---

## Installation (Local)

### Step 1 — Clone the plugin

```bash
git clone https://github.com/<your-org>/neuroverseos-openclaw-governance.git
cd neuroverseos-openclaw-governance
```

### Step 2 — Install dependencies and build

```bash
npm install
npm run build
```

This generates:

```
dist/
```

### Step 3 — Install plugin into OpenClaw

If OpenClaw supports path installs:

```bash
openclaw plugins install --path .
```

If not, manually copy:

```bash
cp -r dist ~/.openclaw/extensions/neuroverseos-governance/
```

(Ensure the directory structure matches the Docker example.)

### Step 4 — Restart OpenClaw

If OpenClaw is running:

```bash
openclaw restart
```

Or stop and start it manually.

---

## Create Your Governance World

Put your markdown files here:

```
~/.openclaw/workspace
```

Example:

```bash
cd ~/.openclaw/workspace
touch AGENTS.md
touch TOOLS.md
touch SOUL.md
```

Then inside OpenClaw:

```
/world bootstrap
```

This compiles:

```
~/.neuroverse/world.json
```

---

## Updating the Plugin (Local)

When you update the repo:

```bash
cd neuroverseos-openclaw-governance
git pull
npm install
npm run build
cp -r dist ~/.openclaw/extensions/neuroverseos-governance/
openclaw restart
```

No reinstall required.

---

## Verifying Plugin Load

Run:

```bash
openclaw logs
```

You should see:

```
[NeuroVerse] Governance plugin loaded
```

If you see:

```
No world file found. Run /world bootstrap
```

That just means you haven't bootstrapped yet.

---

## How Local Differs from Docker

| Mode   | Workspace Location             | Storage Location     |
|--------|--------------------------------|----------------------|
| Docker | `/data/.openclaw/workspace`    | `/data/.neuroverse`  |
| Local  | `~/.openclaw/workspace`        | `~/.neuroverse`      |

Everything else behaves the same.

---

## Storage Detection Logic

The plugin automatically detects:

1. `/data` (Docker)
2. `$HOME` (local)
3. Fallback to current working directory

So you do not need to configure anything manually.

---

## Summary (Local)

To install:

1. Clone repo
2. `npm install`
3. `npm run build`
4. Install plugin into OpenClaw
5. Add `.md` files to workspace
6. Run `/world bootstrap`

That's it.
