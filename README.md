# 🍎 Apple MCP - Better Siri that can do it all :)

> **Plot twist:** Your Mac can do more than just look pretty. Turn your Apple apps into AI superpowers!

Love this MCP? Check out supermemory MCP too - https://mcp.supermemory.ai


Click below for one click install with `.dxt`

<a href="https://github.com/supermemoryai/apple-mcp/releases/download/1.0.0/apple-mcp.dxt">
  <img  width="280" alt="Install with Claude DXT" src="https://github.com/user-attachments/assets/9b0fa2a0-a954-41ee-ac9e-da6e63fc0881" />
</a>

[![smithery badge](https://smithery.ai/badge/@Dhravya/apple-mcp)](https://smithery.ai/server/@Dhravya/apple-mcp)


<a href="https://glama.ai/mcp/servers/gq2qg6kxtu">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/gq2qg6kxtu/badge" alt="Apple Server MCP server" />
</a>

## 🤯 What Can This Thing Do?

**Basically everything you wish your Mac could do automatically (but never bothered to set up):**

### 💬 **Messages** - Because who has time to text manually?

- Send messages to anyone in your contacts (even that person you've been avoiding)
- Read your messages (finally catch up on those group chats)
- Schedule messages for later (be that organized person you pretend to be)

### 📝 **Notes** - Your brain's external hard drive

- Create notes faster than you can forget why you needed them
- Search through that digital mess you call "organized notes"
- Actually find that brilliant idea you wrote down 3 months ago

### 👥 **Contacts** - Your personal network, digitized

- Find anyone in your contacts without scrolling forever
- Get phone numbers instantly (no more "hey, what's your number again?")
- Actually use that contact database you've been building for years

### 📧 **Mail** - Email like a pro (or at least pretend to)

- Send emails with attachments, CC, BCC - the whole professional shebang
- Search through your email chaos with surgical precision
- Schedule emails for later (because 3 AM ideas shouldn't be sent at 3 AM)
- Check unread counts (prepare for existential dread)

### ⏰ **Reminders** - For humans with human memory

- Create reminders with due dates (finally remember to do things)
- Search through your reminder graveyard
- List everything you've been putting off
- Open specific reminders (face your procrastination)

### 📅 **Calendar** - Time management for the chronically late

- Create events faster than you can double-book yourself
- Search for that meeting you're definitely forgetting about
- List upcoming events (spoiler: you're probably late to something)
- Open calendar events directly (skip the app hunting)

### 🗺️ **Maps** - For people who still get lost with GPS

- Search locations (find that coffee shop with the weird name)
- Save favorites (bookmark your life's important spots)
- Get directions (finally stop asking Siri while driving)
- Create guides (be that friend who plans everything)
- Drop pins like you're claiming territory

### ❤️ **Health** - Your Apple Health data, finally answerable

- Ask what your steps, heart rate or sleep actually did last month
- Roll data up by day, week or month (sum, average, min, max)
- List your workouts with distance, duration and energy burned
- Get a whole-window summary across every metric at once

> **Heads up:** this one reads JSON exports written by the **Health Auto
> Export** iOS app rather than the Health database directly, because macOS
> gives no scriptable access to Health. See
> [Setting up Health data](#-setting-up-health-data) below.

## 🎭 The Magic of Chaining Commands

Here's where it gets spicy. You can literally say:

_"Read my conference notes, find contacts for the people I met, and send them a thank you message"_

And it just... **works**. Like actual magic, but with more code.

## 🚀 Installation (The Easy Way)

### Option 1: Smithery (For the Sophisticated)

```bash
npx -y install-mcp apple-mcp --client claude
```

For Cursor users (we see you):

```bash
npx -y install-mcp apple-mcp --client cursor
```

### Option 2: Manual Setup (For the Brave)

<details>
<summary>Click if you're feeling adventurous</summary>

First, get bun (if you don't have it already):

```bash
brew install oven-sh/bun/bun
```

Then add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-mcp": {
      "command": "bunx",
      "args": ["--no-cache", "apple-mcp@latest"]
    }
  }
}
```

</details>

## 🎬 See It In Action

Here's a step-by-step video walkthrough: https://x.com/DhravyaShah/status/1892694077679763671

(Yes, it's actually as cool as it sounds)

## 🎯 Example Commands That'll Blow Your Mind

```
"Send a message to mom saying I'll be late for dinner"
```

```
"Find all my AI research notes and email them to sarah@company.com"
```

```
"Create a reminder to call the dentist tomorrow at 2pm"
```

```
"Show me my calendar for next week and create an event for coffee with Alex on Friday"
```

```
"Find the nearest pizza place and save it to my favorites"
```

```
"What was my average resting heart rate each week last month?"
```

## ❤️ Setting Up Health Data

Unlike the other tools, Health doesn't talk to an app on your Mac — Apple
provides no scriptable access to the Health database. Instead it reads the JSON
files that the **Health Auto Export** iOS app writes to a folder you can see
from your Mac.

**1. Export from your iPhone**

In Health Auto Export, create an automation with:

- **Format:** JSON (CSV exports are not read)
- **Destination:** a folder in iCloud Drive, Dropbox, or anywhere else that
  syncs to this Mac
- **Metrics:** whichever ones you want to ask about

**2. Point the MCP server at that folder**

The tool checks, in order:

1. the `directory` argument, if you pass one on a call
2. the `APPLE_MCP_HEALTH_DIR` environment variable
3. a Health Auto Export iCloud container under `~/Library/Mobile Documents`
4. common export locations in iCloud Drive, Dropbox, Documents and Downloads

Setting the environment variable is the reliable option, since the destination
folder is whatever you picked in the app:

```json
{
  "mcpServers": {
    "apple-mcp": {
      "command": "bunx",
      "args": ["--no-cache", "apple-mcp@latest"],
      "env": {
        "APPLE_MCP_HEALTH_DIR": "/Users/you/Library/Mobile Documents/com~apple~CloudDocs/HealthAutoExport"
      }
    }
  }
}
```

**3. Check it worked**

Point the bundled diagnostic at your export folder:

```bash
bun run health:check ~/path/to/your/HealthAutoExport
```

It prints the files it read, the metrics it found, and a sample daily query —
or, if it cannot read them, names each file and why. That last part is what to
send along if your export does not parse.

You can also just ask Claude _"what health exports can you see?"_, which runs
the same `sources` operation.

### Notes on how the data is read

- Export files are merged, and overlapping re-exports are de-duplicated by
  timestamp, with the most recently written file winning. Health Auto Export
  routinely re-exports the same window, so this stops days being double counted.
- Aggregations return count, sum, average, min and max together, because the
  right statistic depends on the metric — steps are summed, resting heart rate
  is averaged — and the export doesn't say which applies.
- Composite metrics (`blood_pressure`, `sleep_analysis`) expose their individual
  numbers as fields; pass `field: "systolic"` or `field: "deep"` to aggregate
  one of them. `listMetrics` shows which fields each metric provides, and
  `summary` falls back to a metric's first field, naming it in square brackets.
- Nothing is written back — the tool only ever reads your export folder.

## 🛠️ Local Development (For the Tinkerers)

```bash
git clone https://github.com/dhravya/apple-mcp.git
cd apple-mcp
bun install
bun run index.ts
```

Now go forth and automate your digital life! 🚀

---

_Made with ❤️ by supermemory (and honestly, claude code)_
