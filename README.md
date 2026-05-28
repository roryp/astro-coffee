# Astro Coffee

A tiny single-page site for the Astro Coffee demo shop, used as the
canonical dataset for the GitHub Copilot desktop app's 5-minute demo.
Open `index.html` in any browser, or run `bun run dev` to serve it
on http://localhost:5173 — no build, no install.

## Try the demo

You'll need the GitHub Copilot desktop app installed and signed in,
plus a repo you can open pull requests and issues against. Fork this
one or use any repo you control.

### Setup

The demo flow needs three open pull requests and two open issues on
your repo. Create them by hand:

- Push three small branches off `main` and open a pull request for
  each. Any small changes work — a stylesheet, a new section, some
  metadata. Keep them short so the diffs are easy to read on stage.
- File two issues describing something to fix. Assign them to
  yourself so they show up in your Inbox.

Then in the Copilot app:

1. Click **+** in the sidebar → **Add project from** →
   **GitHub repository…** and pick your repo.
2. Right-click the project row in the sidebar → **Settings** →
   toggle **Auto-start issue sessions** on, then click **Inbox**.
3. Close any open workspace tabs so the project starts clean.

### 1. Cold open

Bring the app to the front with **Inbox** visible in the sidebar but
nothing selected. This is your "start of the day" view — nothing
open, nothing in progress.

### 2. Inbox

Click **Inbox** at the top of the sidebar. The list is grouped into
sections:

- **Active** — items assigned to you or that you authored.
- **Review requests** — PRs waiting on your review.
- **Done** — closed work.

You should see all five items (two issues, three pull requests). All
five will be in flight by the end of this demo.

### 3. Three PRs in parallel

1. From the Inbox, click the first PR row. The app fetches the PR's
   branch into its own worktree under
   `~/.copilot/copilot-worktrees/` and opens the diff in the right
   panel.
2. Click **Inbox** again, then click the second PR. Repeat for the
   third.
3. Click between the three PR tabs in the sidebar — each shows its
   own diff instantly. Three independent checkouts, no
   `git checkout` shuffling, no stashing.

### 4. Two issues

1. Back in the **Inbox**, click the first issue row. Because
   **Auto-start issue sessions** is on, the chat session starts
   immediately and the agent reads the issue body.
2. While that's running, click **Inbox** and open the second issue.
   It starts working in parallel.
3. Click the first issue's tab again — there's already a plan
   written while the second tab keeps going.

### 5. Agent Merge

1. Click the first PR's tab in the sidebar.
2. At the top of the workspace view, click the **chevron** to the
   right of the primary action button (e.g. **Ready to merge**) and
   choose **Enable agent merge**.
3. Watch the chat: the agent replies to review threads, pushes fixes,
   and waits on CI on its own. It re-checks every ten minutes and
   only interrupts if it's actually stuck.

### 6. Branch workspace

1. In the sidebar, click **+** → **Start session in** → pick the
   same project. An empty session opens with the composer focused.
2. At the bottom of the composer, click the **New worktree** button
   (between the project and branch pickers) to open the **Where to
   run this session** popover.
3. Choose **Local repository** and pick a branch. This workspace
   reuses the main checkout instead of creating a new worktree —
   same agent surface, smaller footprint.

### 7. Close

Click back to the first PR's tab — Agent Merge should still be
ticking along. Five workstreams (three PRs and two issues) are all
making progress at the same time, and you haven't had to juggle a
single checkout or stashed change.

That's the demo. From here you can let any session keep running,
switch projects, or quit the app and reopen it — sessions and diffs
are restored on relaunch.

## Run locally

Open `index.html` in any browser, or run `bun run dev` to serve
it on http://localhost:5173. No build step, no dependencies.

## Contributing

- Open an issue describing the change.
- Branch off `main`, push, and open a PR that closes the issue.
- Keep changes small and focused so reviews stay fast.
