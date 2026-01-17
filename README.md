# 🚀 GitFlow for PMs

### Contribute to Code without the Headache

GitFlow for PMs lets you make changes to your codebase using simple English. Just tell Claude what you want to do, and it handles all the Git complexity for you.

> **No terminal commands. No Git knowledge. Just describe what you want.**

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

---

## 📋 Before You Start (Checklist)

You'll need to download and install these tools. Don't worry—each one has a simple installer!

| Tool | What It Does | Download Link |
|------|--------------|---------------|
| 🐳 **Docker Desktop** | Runs the database | [Download Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| 💚 **Node.js** (v20+) | Runs the server | [Download Node.js](https://nodejs.org/) (choose "LTS") |
| 🤖 **Claude Desktop** | Your AI assistant | [Download Claude Desktop](https://claude.ai/download) |
| ✏️ **Cursor** (optional) | For editing code files | [Download Cursor](https://cursor.sh/) |

### ⚠️ Important: Start Docker Desktop!

After installing Docker Desktop, **open the app and let it run in the background**. You'll see a whale icon in your menu bar when it's ready.

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
git clone https://github.com/gitflow-for-pms/gitflow-for-pms.git
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

Make sure Docker Desktop is running, then:

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

🎉 **Installation complete!** Now let's connect it to Claude.

---

## 🤖 Connecting to Claude Desktop

### Step 1: Find Your Claude Config File

**On Mac:**
```bash
open ~/Library/Application\ Support/Claude/
```

**On Windows:**
```
%APPDATA%\Claude\
```

### Step 2: Edit `claude_desktop_config.json`

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

⚠️ **Important:** Replace `/FULL/PATH/TO/gitflow-for-pms` with the actual path to where you downloaded the project.

**To find your full path:**
- In your terminal, navigate to the project folder and run:
  ```bash
  pwd
  ```
- Copy the output and use it in the config

**Example paths:**
- Mac: `/Users/yourname/gitflow-for-pms/dist/index.js`
- Windows: `C:\\Users\\yourname\\gitflow-for-pms\\dist\\index.js`

### Step 3: Restart Claude Desktop

Completely quit Claude Desktop and reopen it. The GitFlow tools should now be available!

### Step 4: Verify It's Working

In Claude, try asking:

> "What GitFlow tools do you have available?"

Claude should list the tools like `list_repositories`, `save_changes`, `push_for_review`, etc.

---

## 📖 How to Use (Cheat Sheet)

Once connected, just talk to Claude naturally. Here are some example prompts:

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
3. **Ask for help** — Claude can explain what's happening in simple terms
4. **Don't worry about branches** — The tool handles that automatically

---

## 🔧 Troubleshooting

### ❌ "Database connection error"

**Problem:** The database isn't running.

**Solution:**
1. Make sure Docker Desktop is open and running (look for the whale icon)
2. Run this command:
   ```bash
   docker compose up -d db redis
   ```
3. Wait 10 seconds, then try again

### ❌ "Authentication error" or "GitHub error"

**Problem:** Your GitHub credentials are wrong or missing.

**Solution:**
1. Check your `.env` file has the correct `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
2. Make sure you copied them correctly from [GitHub Developer Settings](https://github.com/settings/developers)
3. Rebuild the project:
   ```bash
   npm run build
   ```

### ❌ "MCP server not found" in Claude

**Problem:** Claude can't find the GitFlow server.

**Solution:**
1. Check the path in `claude_desktop_config.json` is correct
2. Make sure you ran `npm run build` after installation
3. Completely quit and restart Claude Desktop

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

You can always go back to a previous save. Just tell Claude "What changes have I made?" and work from there.

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
