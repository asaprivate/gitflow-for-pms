# 🚀 GitFlow for PMs

### Contribute to Code without the Headache

GitFlow for PMs lets you make changes to your codebase using simple English. Just tell your AI assistant what you want to do, and it handles all the Git complexity for you.

> **No terminal commands. No Git knowledge. Just describe what you want.**

### 🎯 Designed for Vibe Coding Tools

Works with all major AI coding assistants:

| Tool | Status |
|------|--------|
| 🤖 **Claude Desktop** | ✅ Full Support |
| ✏️ **Cursor** | ✅ Full Support |
| 🔷 **Base44** | ✅ Full Support |
| 🌐 **Other MCP Clients** | ✅ Standard MCP Protocol |

---

## ✨ What Can You Do?

| You Say... | What Happens |
|------------|--------------|
| "What repos can I work on?" | Shows your accessible projects |
| "Set up the website project" | Downloads and prepares the code |
| "Save my changes" | Creates a checkpoint of your work |
| "I'm done, send for review" | Pushes your code and creates a PR link to share |
| "What was I working on?" | Shows your recent work sessions |
| "Go back to the pricing task" | Switches to your previous work |
| "Jump" | We ask how high |
---

## 📋 Before You Start (Checklist)

You'll need to download and install these tools. Don't worry—each one has a simple installer!

| Tool | What It Does | Download Link |
|------|--------------|---------------|
| 🐳 **Docker Desktop** OR **Rancher Desktop** | Runs the database | [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Rancher Desktop](https://rancherdesktop.io/) |
| 💚 **Node.js** (v20+) | Runs the server | [Download Node.js](https://nodejs.org/) (choose "LTS") |
| 🤖 **AI Coding Tool** (pick one) | Your AI assistant | [Claude Desktop](https://claude.ai/download), [Cursor](https://cursor.sh/), or [Base44](https://base44.com/) |

### ⚠️ Important: Start Docker/Rancher!

After installing **Docker Desktop** or **Rancher Desktop**, **open the app and let it run in the background**.

- **Docker Desktop:** Look for the whale 🐳 icon in your menu bar
- **Rancher Desktop:** Look for the Rancher icon in your menu bar

> **Note for Rancher users:** Rancher Desktop uses the same `docker compose` commands, so all instructions work the same way!

---

## 🛠️ Installation (Step by Step)

### Step 1: Open Your Terminal

**On Mac:**
- Press `Cmd + Space`, type "Terminal", press Enter

**On Windows:**
- Press `Win + R`, type "cmd", press Enter

### Step 2: Download the Project

Copy and paste this command, then press Enter:

```bash
git clone https://github.com/asaprivate/gitflow-for-pms.git
cd gitflow-for-pms
```

### Step 3: Install Dependencies

```bash
npm install
```

### Step 4: Create Your Configuration File

```bash
cp .env.example .env
```

> **Note:** If `.env.example` doesn't exist, create a new file called `.env` and add the contents from the next section.

### Step 5: Configure Your `.env` File
> **💡 Tip:** for Mac Users: If you don't see the .env file in Finder, press Cmd + Shift + . (period) to reveal hidden files.

Open the `.env` file in any text editor and add these settings:

```bash
# =============================================================================
# GitFlow MCP Server Configuration
# =============================================================================

# Environment
NODE_ENV=development
LOG_LEVEL=debug
PORT=3000

# Database (Docker will set this up for you)
DATABASE_URL=postgresql://gitflow:gitflow_secret@localhost:5432/gitflow_dev

# GitHub OAuth (Get these from GitHub - see instructions below)
GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here
GITHUB_REDIRECT_URI=http://localhost:3000/oauth/callback

# JWT Security (You can leave these as-is for development)
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=7d
JWT_ISSUER=gitflow-for-pms

# Redis (Docker will set this up for you)
REDIS_URL=redis://localhost:6379

# Stripe (Optional - for billing features)
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRO_PRICE_ID=price_xxx
```

### Step 6: Get Your GitHub Credentials

You need to create a GitHub OAuth App to connect your account:

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **"OAuth Apps"** → **"New OAuth App"**
3. Fill in:
   - **Application name:** `GitFlow for PMs`
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000/oauth/callback`
4. Click **"Register application"**
5. Copy the **Client ID** → paste into `GITHUB_CLIENT_ID` in your `.env`
6. Click **"Generate a new client secret"**
7. Copy the **Client Secret** → paste into `GITHUB_CLIENT_SECRET` in your `.env`

### Step 7: Start the Database

Make sure Docker Desktop (or Rancher Desktop) is running, then:

```bash
docker compose up -d db redis
```

You should see something like:
```
✔ Container gitflow-postgres  Started
✔ Container gitflow-redis     Started
```

### Step 8: Set Up the Database Tables

```bash
npm run migrate
```

### Step 9: Build the Server

```bash
npm run build
```

🎉 **Installation complete!** Now let's connect it to your AI coding tool.

---

## 🔌 Connecting to Your AI Tool

Choose your AI coding tool below and follow the instructions.

> **💡 Tip:** Before configuring, find your project path by running `pwd` in your terminal (while in the project folder). You'll need this path below.
>
> **Example paths:**
> - Mac: `/Users/yourname/gitflow-for-pms`
> - Windows: `C:\Users\yourname\gitflow-for-pms`

---

### 🤖 Option A: Claude Desktop

#### Step 1: Find Your Claude Config File

**On Mac:**
```bash
open ~/Library/Application\ Support/Claude/
```

**On Windows:**
```
%APPDATA%\Claude\
```

#### Step 2: Edit `claude_desktop_config.json`

If the file doesn't exist, create it. Add this configuration:

```json
{
  "mcpServers": {
    "gitflow": {
      "command": "node",
      "args": ["/FULL/PATH/TO/gitflow-for-pms/dist/index.js"],
      "env": {
        "NODE_ENV": "development",
        "DATABASE_URL": "postgresql://gitflow:gitflow_secret@localhost:5432/gitflow_dev",
        "REDIS_URL": "redis://localhost:6379",
        "GITHUB_CLIENT_ID": "your_client_id_here",
        "GITHUB_CLIENT_SECRET": "your_client_secret_here",
        "GITHUB_REDIRECT_URI": "http://localhost:3000/oauth/callback",
        "JWT_SECRET": "your-super-secret-jwt-key-change-in-production"
      }
    }
  }
}
```

⚠️ **Important:** Replace `/FULL/PATH/TO/gitflow-for-pms` with your actual project path.

#### Step 3: Restart Claude Desktop

Completely quit Claude Desktop and reopen it. The GitFlow tools should now be available!

#### Step 4: Verify It's Working

In Claude, try asking:

> "What GitFlow tools do you have available?"

Claude should list the tools like `list_repositories`, `save_changes`, `push_for_review`, etc.

---

### ✏️ Option B: Cursor

Cursor uses a JSON configuration file for MCP servers, similar to Claude Desktop.

#### Step 1: Open MCP Settings

1. Open **Cursor**
2. Press **⌘ + ,** (Mac) or **Ctrl + ,** (Windows) to open Settings
3. Click **"Tools & MCP"** in the left sidebar

#### Step 2: Open the Config File

1. Click **"+ New MCP Server"**
2. This will open the `mcp.json` configuration file in your editor

> 💡 **Config file location:** Usually at `~/.cursor/mcp.json`

#### Step 3: Add the GitFlow Configuration

Paste the following inside the `"mcpServers"` object:

```json
"gitflow": {
  "command": "node",
  "args": ["/ABSOLUTE/PATH/TO/gitflow-for-pms/dist/index.js"],
  "env": {
    "NODE_ENV": "development",
    "DATABASE_URL": "postgresql://gitflow:gitflow_secret@localhost:5432/gitflow_dev",
    "REDIS_URL": "redis://localhost:6379",
    "GITHUB_CLIENT_ID": "your_client_id_here",
    "GITHUB_CLIENT_SECRET": "your_client_secret_here",
    "GITHUB_REDIRECT_URI": "http://localhost:3000/oauth/callback",
    "JWT_SECRET": "your-super-secret-jwt-key-change-in-production"
  }
}
```

⚠️ **Important:** 
- Replace `/ABSOLUTE/PATH/TO/gitflow-for-pms` with your actual project path
- Replace `your_client_id_here` and `your_client_secret_here` with your GitHub OAuth credentials
- If you have other MCP servers already configured, add a comma before this block

> 💡 **To find your path:** In your terminal, navigate to the project folder and run `pwd`. 
>
> **Example:** `/Users/yourname/gitflow-for-pms/dist/index.js`

#### Step 4: Save and Restart

1. Save the `mcp.json` file
2. Restart Cursor completely (quit and reopen)

#### Step 5: Verify the Connection

Look for the **green status indicator** 🟢 next to "gitflow" in the MCP list.

| Status | Meaning |
|--------|---------|
| 🟢 Green | Connected and working! |
| 🔴 Red | Something's wrong (check path and env vars) |
| ⚪ Gray | Not started yet (restart Cursor) |

> **If you see connection errors:** Make sure Docker/Rancher is running and the database is started (`docker compose up -d db redis`).

---

### 🔷 Option C: Base44

Base44 follows the standard MCP protocol configuration.

#### Step 1: Open MCP Settings

In Base44, navigate to your MCP server configuration (usually in Settings or Preferences).

#### Step 2: Add Server Configuration

Add a new MCP server with these settings:

| Setting | Value |
|---------|-------|
| **Transport** | `stdio` |
| **Command** | `node` |
| **Arguments** | `/FULL/PATH/TO/gitflow-for-pms/dist/index.js` |

#### Step 3: Configure Environment Variables

Add the same environment variables listed in the Cursor section above, or ensure your `.env` file is loaded.

#### Step 4: Restart Base44

Restart the application to activate the GitFlow tools.

---

### 🌐 Option D: Other MCP-Compatible Tools

GitFlow for PMs uses the standard **Model Context Protocol (MCP)** with `stdio` transport.

**Configuration details:**
- **Transport:** `stdio`
- **Command:** `node`
- **Arguments:** `["/path/to/gitflow-for-pms/dist/index.js"]`
- **Environment variables:** See the table in the Cursor section above

Refer to your tool's documentation for how to add MCP servers.

---

## 📖 How to Use (Cheat Sheet)

Once connected, just talk to your AI assistant naturally. Here are some example prompts:

### 🚀 Getting Started

| What You Want | What to Say |
|---------------|-------------|
| See your repos | "What repositories can I access?" |
| Start working | "Set up the [project-name] repository" |
| Check status | "What's the status of my current project?" |

### 💾 Saving Your Work

| What You Want | What to Say |
|---------------|-------------|
| Save progress | "Save my changes with the message: Updated pricing" |
| Check changes | "What files have I changed?" |
| Multiple saves | Save often! It's like creating checkpoints. |

### 📤 Sending for Review

| What You Want | What to Say |
|---------------|-------------|
| Create a PR | "I'm done, create a pull request" |
| Draft PR | "Send this for review as a draft" |
| Custom title | "Create a PR titled: Fix checkout button" |

### 🔄 Managing Multiple Tasks

| What You Want | What to Say |
|---------------|-------------|
| See past work | "What was I working on before?" |
| Switch tasks | "Go back to the login bug fix" |
| Current task | "What am I currently working on?" |

### 💡 Pro Tips

1. **Save frequently** — Every save is a checkpoint you can return to
2. **Describe your work** — "Save changes: Added new pricing tier" helps track what you did
3. **Ask for help** — Your AI assistant can explain what's happening in simple terms
4. **Don't worry about branches** — The tool handles that automatically

---

## 🔧 Troubleshooting

### ❌ "Database connection error"

**Problem:** The database isn't running.

**Solution:**
1. Make sure **Docker Desktop** or **Rancher Desktop** is open and running
   - Docker: Look for the whale 🐳 icon in your menu bar
   - Rancher: Look for the Rancher icon in your menu bar
2. Run this command:
   ```bash
   docker compose up -d db redis
   ```
3. Wait 10 seconds, then try again

### ❌ "Authentication error" or "GitHub error"

**Problem:** Your GitHub credentials are wrong or missing.

**Solution:**
1. Check your `.env` file (or MCP config) has the correct `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
2. Make sure you copied them correctly from [GitHub Developer Settings](https://github.com/settings/developers)
3. Rebuild the project:
   ```bash
   npm run build
   ```

### ❌ "MCP server not found"

**Problem:** Your AI tool can't find the GitFlow server.

**Solution:**
1. Check that the path to `dist/index.js` is correct in your configuration
2. Make sure you ran `npm run build` after installation
3. Completely quit and restart your AI tool (Claude, Cursor, or Base44)

### ❌ "Command not found: node"

**Problem:** Node.js isn't installed or isn't in your PATH.

**Solution:**
1. Install Node.js from [nodejs.org](https://nodejs.org/) (choose "LTS")
2. Restart your terminal
3. Verify by running: `node --version`

### ❌ "Permission denied" errors

**Problem:** The tool can't access certain files.

**Solution:**
- On Mac, you may need to grant Terminal full disk access in System Preferences → Privacy & Security

### 🆘 Still Stuck?

1. Check the logs:
   ```bash
   docker compose logs -f
   ```
2. Reset everything and start fresh:
   ```bash
   docker compose down -v
   docker compose up -d db redis
   npm run migrate
   npm run build
   ```
3. Restart your AI tool completely

---

## 📚 More Resources

- **[AI Usage Guide](docs/AI_USAGE_GUIDE.md)** — Detailed guide for how the AI assistant works
- **[GitHub Issues](https://github.com/gitflow-for-pms/gitflow-for-pms/issues)** — Report bugs or request features

---

## 🙋 Frequently Asked Questions

### Do I need to know Git?

**No!** That's the whole point. GitFlow handles all the Git complexity. You just describe what you want in plain English.

### Can I break anything?

**Very unlikely.** The tool prevents dangerous operations like pushing directly to main. Your changes are always on a separate branch until an engineer reviews them.

### What if I make a mistake?

You can always go back to a previous save. Just ask "What changes have I made?" and work from there.

### Do engineers need to change their workflow?

**No.** Engineers still review and merge PRs the same way they always have. They just get a PR link from you instead of you asking them to make changes.

### Can multiple people use this?

Yes! Each person has their own sessions and workspaces. The tool tracks who's working on what.

---

## 📄 License

MIT License — See [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>GitFlow for PMs</strong> — Empowering Product Managers to contribute to code 🚀
</p>
