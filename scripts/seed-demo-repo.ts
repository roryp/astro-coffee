/**
 * seed-demo-repo.ts
 *
 * Rebuilds the `roryp/astro-coffee` demo repo (the one referenced by
 * `docs/demo-script.md`) from scratch and primes it with the exact dataset
 * used to capture the screenshots:
 *
 *   - 1 minimal `index.html` landing page on `main` + a tiny GitHub Actions
 *     workflow (`.github/workflows/ci.yml`) that registers a required `ci`
 *     check on every PR. The workflow is a ~2-minute sleep so the demo's
 *     "Merge when ready" → auto-merge transition can play out live on
 *     stage without stalling. The workflow also publishes a non-required
 *     `lint` check that grep-fails on a deliberate CSS typo seeded into
 *     `feat/add-stylesheet` — so that PR opens with a visible red check
 *     for the Agent Merge beat. Reseed right before the demo to get a
 *     fresh window.
 *   - 3 open PRs against `main`, each touching disjoint files so they
 *     can land in any order without conflict:
 *       feat/add-stylesheet      — adds styles.css (with one `colur:` typo
 *                                    so the `lint` check fails on this PR)
 *       feat/add-menu-doc        — adds MENU.md
 *       feat/add-robots-sitemap  — adds robots.txt + sitemap.xml
 *     Each PR also has a Copilot code-review request posted at creation
 *     time (best-effort — the script prints a hint if the API rejects it).
 *   - 2 open issues assigned to the signed-in gh user:
 *       "Add dark mode toggle"               (enhancement, ui)
 *       "Hours of operation are out of date" (bug, content)
 *   - 7 labels: enhancement, bug, ui, content, css, a11y, seo  (+ the 9
 *     auto-created defaults left untouched).
 *   - Repo setting `allow_auto_merge=true` and branch protection on `main`
 *     requiring the `ci` check. Together with the workflow above, this
 *     makes the app's merge button render as "Merge when ready" on each
 *     seeded PR — the affordance the demo script exercises.
 *
 * The script is idempotent: it closes all open issues/PRs, deletes every
 * non-main branch, force-pushes `main` back to the start commit, then
 * re-creates everything. Running it twice in a row without --nuke-repo
 * produces the same end state (PR/issue numbers increment). With
 * --nuke-repo, the repo is deleted and recreated, so PR/issue numbers
 * reset to 1.
 *
 * SAFETY
 *
 * This script is destructive. It is intended to run only against the
 * canonical demo repo. Before doing anything destructive it checks:
 *
 *   1. The target repo's `description` exactly matches the canonical
 *      demo description (set when the repo is first created). If it
 *      doesn't, the script refuses to proceed — because that almost
 *      certainly means the user typo'd `--repo` and is pointing at a
 *      real project.
 *   2. The target repo's owner matches the signed-in `gh` login. Cross-
 *      account destructive runs are not supported.
 *   3. `--nuke-repo` additionally requires the repo to already exist
 *      (a missing repo with --nuke-repo is almost certainly a typo).
 *   4. `--clone-dir` is not a drive root, the user's homedir, or any
 *      path shorter than ~5 characters; and if it exists, its origin
 *      remote must contain the target repo's OWNER/NAME before the
 *      script will wipe it.
 *
 * USAGE
 *
 *   bun scripts/seed-demo-repo.ts             # interactive confirm
 *   bun scripts/seed-demo-repo.ts --yes       # skip the confirm prompt
 *   bun scripts/seed-demo-repo.ts --dry-run   # print plan, do nothing
 *   bun scripts/seed-demo-repo.ts --nuke-repo # delete and recreate the
 *                                              # repo (wipes closed PRs/issues)
 *   bun scripts/seed-demo-repo.ts --repo OWNER/NAME --clone-dir D:\path
 *
 * FLAGS
 *
 *   --repo OWNER/NAME   Target repo (default: roryp/astro-coffee).
 *   --clone-dir PATH    Local clone path (default: ~/dev/copilot-demo-site).
 *   --yes               Skip the destructive-action confirmation prompt.
 *   --dry-run           Print the plan and exit without making any change.
 *   --keep-local        Reuse the existing local clone if present (default).
 *   --fresh-local       Delete the local clone and re-clone from scratch.
 *   --nuke-repo         Delete and recreate the GitHub repo (the only way
 *                       to wipe closed PRs — GitHub's API can't delete
 *                       PRs individually). Requires the `delete_repo`
 *                       OAuth scope on the active gh token; the script
 *                       prints the exact command to add it if missing.
 *                       Implies --fresh-local.
 *
 * PRECONDITIONS
 *
 *   - `gh` CLI installed and authenticated for the target owner.
 *     The script reads the signed-in login via `gh api user` and uses it
 *     as the assignee for the two issues.
 *   - `git` installed and on PATH.
 *
 * The demo script doc lives at `docs/demo-script.md`. The Setup section
 * there is the user-facing instruction; this file is the automation.
 */
/// <reference types="node" />
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Repo-shape constants. Editing these is how you customize the seeded dataset.
// ---------------------------------------------------------------------------

const DEFAULT_REPO = "roryp/astro-coffee";
const DEFAULT_CLONE_DIR = path.join(os.homedir(), "dev", "copilot-demo-site");
const REPO_DESCRIPTION =
	"Tiny single-page demo site used by the GitHub Copilot app's 5-minute demo script.";

interface LabelSpec {
	name: string;
	description: string;
	color: string; // hex without #
}

const LABELS: LabelSpec[] = [
	{ name: "ui", description: "User interface", color: "0E8A16" },
	{ name: "content", description: "Site copy / content", color: "FBCA04" },
	{ name: "css", description: "Styling / CSS", color: "5319E7" },
	{ name: "a11y", description: "Accessibility", color: "1D76DB" },
	{ name: "seo", description: "Search engine optimization", color: "BFD4F2" },
];

interface FileSpec {
	relPath: string;
	content: string;
}

interface BranchSpec {
	branch: string;
	commitMessage: string;
	prTitle: string;
	prBody: string;
	labels: string[];
	files: FileSpec[]; // files to overwrite vs. main (others are removed if listed in `removes`)
	removes?: string[]; // files present on main that should be deleted on this branch (rare)
}

interface IssueSpec {
	title: string;
	body: string;
	labels: string[];
}

// ---------------------------------------------------------------------------
// Start-state files (what `main` looks like after `seed` finishes).
// ---------------------------------------------------------------------------

const MAIN_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Astro Coffee</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header>
      <h1>Astro Coffee</h1>
      <p>Specialty beans, slow-roasted, hand-delivered.</p>
    </header>
    <main>
      <section>
        <h2>This week's roast</h2>
        <p>Ethiopian Yirgacheffe &mdash; bright, floral, citrus finish.</p>
      </section>
      <section>
        <h2>Visit us</h2>
        <p>42 Aurora Lane, open daily 7am&ndash;5pm.</p>
      </section>
    </main>
    <footer>
      <p>&copy; 2026 Astro Coffee.</p>
    </footer>
  </body>
</html>
`;

const MAIN_README = `# Astro Coffee

A tiny single-page site for the Astro Coffee demo shop, used as the
canonical dataset for the GitHub Copilot desktop app's 5-minute demo.
Open \`index.html\` in any browser, or run \`bun run dev\` to serve it
on http://localhost:5173 — no build, no install.

## Try the demo

You'll need the GitHub Copilot desktop app installed and signed in,
plus a repo you can open pull requests and issues against. Fork this
one or use any repo you control.

### Setup

The demo flow needs three open pull requests and two open issues on
your repo. This repo ships the automation that builds them — see
[Reset the demo repo](#reset-the-demo-repo) below for \`bun run seed\`.
Or create them by hand:

- Push three small branches off \`main\` and open a pull request for
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
   \`~/.copilot/copilot-worktrees/\` and opens the diff in the right
   panel.
2. Click **Inbox** again, then click the second PR. Repeat for the
   third.
3. Click between the three PR tabs in the sidebar — each shows its
   own diff instantly. Three independent checkouts, no
   \`git checkout\` shuffling, no stashing.

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

Open \`index.html\` in any browser, or run \`bun run dev\` to serve
it on http://localhost:5173. No build step, no dependencies.

## Reset the demo repo

\`bun run seed\` rebuilds the whole demo dataset — three pull
requests, two issues, labels, and branch protection — so every run
starts from the same clean state. It is **destructive** and only
touches a repo whose description matches this one and whose owner is
your signed-in \`gh\` login, so point it at your own fork:

\`\`\`
bun scripts/seed-demo-repo.ts --repo YOUR_USER/astro-coffee --yes
\`\`\`

Needs \`git\`, the \`gh\` CLI (\`gh auth login\`), and \`bun\` or Node
22+. Add \`--dry-run\` to preview or \`--nuke-repo\` to reset
PR/issue numbers (requires the \`delete_repo\` gh scope). All flags
are documented at the top of \`scripts/seed-demo-repo.ts\`.

## Contributing

- Open an issue describing the change.
- Branch off \`main\`, push, and open a PR that closes the issue.
- Keep changes small and focused so reviews stay fast.
`;

const MAIN_GITIGNORE = `.DS_Store
node_modules/
dist/
`;

// Minimal package.json so the desktop app's Run picker surfaces a `dev`
// script for the workspace. The script uses `bunx serve` to serve the
// static site on :5173 — no build, no install, just a one-click way to
// preview the page during the demo. Bun ships with the app's dev
// environment, so this works out of the box.
const MAIN_PACKAGE_JSON = `${JSON.stringify(
	{
		name: "astro-coffee",
		private: true,
		version: "0.0.0",
		description: "Tiny single-page site for the Copilot desktop app demo.",
		scripts: {
			dev: "bunx serve -l 5173 .",
			seed: "bun scripts/seed-demo-repo.ts",
		},
		devDependencies: {
			"@types/node": "^26.1.1",
		},
	},
	null,
	2,
)}\n`;

// Minimal GitHub Actions workflow that publishes a single check named `ci`.
// This check is wired into `main`'s branch protection below so each seeded PR
// gets a required deferred gate — which is what makes the app's merge button
// render as "Merge when ready" (the auto-merge affordance) instead of just
// "Ready to merge".
//
// `sleep 120` (2 minutes) is the demo sweet spot: long enough that after
// reseeding the presenter still has ~90 seconds of pending-CI window to
// switch to the app, frame the shot, and click "Merge when ready" — then
// ~30 more seconds to narrate the transition to the green "Auto-merge"
// state and watch the PR auto-merge live on stage. Reseed immediately
// before each demo / take to reset the clock on all three PRs.
//
// astro-coffee is a public repo, so Actions minutes are free.
const MAIN_CI_WORKFLOW = `name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  ci:
    name: ci
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - name: Verify the site (paced for demo)
        run: |
          test -f index.html
          echo "starting"
          sleep 120
          echo "ok"

  lint:
    # Non-required check. Greps styles.css for common CSS property typos
    # (e.g. \`colur:\` instead of \`color:\`). The stylesheet PR
    # (\`feat/add-stylesheet\`) is seeded with one such typo, so its PR
    # surfaces a red check the moment it opens. Other branches don't ship
    # styles.css, so this job no-ops (skipped on the seed-time pass).
    name: lint
    runs-on: ubuntu-latest
    timeout-minutes: 2
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - name: CSS property check
        run: |
          if [ ! -f styles.css ]; then
            echo "no styles.css on this branch - skipping lint"
            exit 0
          fi
          if grep -nE '\\bcolur\\s*:|\\bbacground\\s*:|\\bbordr\\s*:' styles.css; then
            echo "::error file=styles.css::CSS property typo detected (did you mean color/background/border?)"
            exit 1
          fi
          echo "ok"
`;

// Name of the required status check (matches the job name in the workflow
// above). Used by `applyMainBranchProtection` to wire the check into branch
// protection on `main`.
const REQUIRED_CHECK_NAME = "ci";

// The seed script commits its own source onto `main` so the demo repo ships
// with its own reset tooling and survives every reseed. resetMainToStartState
// wipes the working tree and force-pushes an orphan commit built ONLY from
// MAIN_FILES, so anything not listed here is lost — including this file.
// Reading the running file's own bytes keeps the committed copy identical to
// the copy being run.
const SELF_SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");

const MAIN_FILES: FileSpec[] = [
	{ relPath: "index.html", content: MAIN_INDEX_HTML },
	{ relPath: "README.md", content: MAIN_README },
	{ relPath: ".gitignore", content: MAIN_GITIGNORE },
	{ relPath: "package.json", content: MAIN_PACKAGE_JSON },
	{ relPath: ".github/workflows/ci.yml", content: MAIN_CI_WORKFLOW },
	{ relPath: "scripts/seed-demo-repo.ts", content: SELF_SOURCE },
];

// ---------------------------------------------------------------------------
// PR branches.
// ---------------------------------------------------------------------------

const STYLESHEET_STYLES_CSS = `:root {
  --bg: #faf6f1;
  --fg: #2a1f17;
  --accent: #b8642f;
  --muted: #6b5d52;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 2rem;
  font-family: "Inter", system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--fg);
  max-width: 720px;
  margin-inline: auto;
  line-height: 1.55;
}

header h1 {
  colur: var(--accent);
  margin-bottom: 0.25rem;
}

header p {
  color: var(--muted);
  margin-top: 0;
}

main section {
  margin-block: 1.5rem;
  padding: 1rem 1.25rem;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

footer {
  margin-top: 2rem;
  color: var(--muted);
  font-size: 0.875rem;
  text-align: center;
}
`;

const MENU_MD = `# Menu

A plain-text version of the current Astro Coffee menu — handy for
printing, sharing in a sandwich-board, or pasting into a chat.

## Espresso bar

| Drink | Price |
|---|---|
| Espresso | $3.50 |
| Flat white | $4.50 |
| Pour-over (single origin) | $5.50 |
| Cold brew | $5.00 |

## This week's roast

Ethiopian Yirgacheffe — bright, floral, citrus finish.

Prices include local tax. Beans of the week are subject to availability.
`;

const ROBOTS_TXT = `User-agent: *
Allow: /

Sitemap: https://astro-coffee.example.com/sitemap.xml
`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://astro-coffee.example.com/</loc>
    <lastmod>2026-05-18</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;

const BRANCHES: BranchSpec[] = [
	{
		branch: "feat/add-stylesheet",
		commitMessage: "Add basic stylesheet for the landing page",
		prTitle: "Add basic stylesheet for the landing page",
		prBody: `Adds a small \`styles.css\` so the page is readable on its own without inline styling. Includes:

- a coffee-themed colour palette
- centered max-width body
- card styling for sections
- footer formatting

\`index.html\` on \`main\` already loads it via a plain \`<link>\`, so this PR is a pure file addition.`,
		labels: ["enhancement", "css"],
		files: [{ relPath: "styles.css", content: STYLESHEET_STYLES_CSS }],
	},
	{
		branch: "feat/add-menu-doc",
		commitMessage: "Add MENU.md with current drinks and prices",
		prTitle: "Add MENU.md with current drinks and prices",
		prBody: `Adds a standalone \`MENU.md\` listing espresso, flat white, pour-over, and cold brew with prices, plus the week's roast.

Useful as a printable copy and a source-of-truth the website can be regenerated from. No HTML changes.`,
		labels: ["enhancement", "content"],
		files: [{ relPath: "MENU.md", content: MENU_MD }],
	},
	{
		branch: "feat/add-robots-sitemap",
		commitMessage: "Add robots.txt and sitemap.xml for search engines",
		prTitle: "Add robots.txt and sitemap.xml for search engines",
		prBody: `Adds a minimal \`robots.txt\` (allow-all + sitemap pointer) and a single-URL \`sitemap.xml\`.

No HTML changes — just two new static files at the repo root so crawlers can find the site.`,
		labels: ["enhancement", "seo"],
		files: [
			{ relPath: "robots.txt", content: ROBOTS_TXT },
			{ relPath: "sitemap.xml", content: SITEMAP_XML },
		],
	},
];

const ISSUES: IssueSpec[] = [
	{
		title: "Add dark mode toggle",
		body: "The site should respect prefers-color-scheme and offer a manual toggle in the header. Light background is hard on the eyes in the evening.\n\nA11y note: please give the toggle a visible **text label** (e.g. `Dark mode` / `Light mode`), not an icon-only button. If you add a sun/moon emoji, keep it alongside the text so the visible label and the accessible name match (WCAG 2.5.3, Label in Name). Our accessibility lint will block the PR otherwise.",
		labels: ["enhancement", "ui"],
	},
	{
		title: "Hours of operation are out of date",
		body: "Storefront just changed weekday hours to 6am - 6pm. Please update the Visit us section so customers do not show up at the wrong time.",
		labels: ["bug", "content"],
	},
];

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

interface Args {
	repo: string;
	cloneDir: string;
	yes: boolean;
	dryRun: boolean;
	freshLocal: boolean;
	nukeRepo: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		repo: DEFAULT_REPO,
		cloneDir: DEFAULT_CLONE_DIR,
		yes: false,
		dryRun: false,
		freshLocal: false,
		nukeRepo: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--repo":
				args.repo = argv[++i] ?? "";
				break;
			case "--clone-dir":
				args.cloneDir = argv[++i] ?? "";
				break;
			case "--yes":
			case "-y":
				args.yes = true;
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--keep-local":
				args.freshLocal = false;
				break;
			case "--fresh-local":
				args.freshLocal = true;
				break;
			case "--nuke-repo":
				args.nukeRepo = true;
				break;
			case "--help":
			case "-h":
				printUsageAndExit(0);
				break;
			default:
				console.error(`unknown argument: ${a}`);
				printUsageAndExit(1);
		}
	}
	if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(args.repo)) {
		console.error(
			`--repo must look like OWNER/NAME (alphanumeric, _, -, .), got: ${args.repo}`,
		);
		process.exit(1);
	}
	return args;
}

function printUsageAndExit(code: number): never {
	const help = `Usage: bun scripts/seed-demo-repo.ts [options]

Options:
  --repo OWNER/NAME   Target repo (default: ${DEFAULT_REPO})
  --clone-dir PATH    Local clone path (default: ${DEFAULT_CLONE_DIR})
  --yes, -y           Skip the destructive-action confirmation prompt
  --dry-run           Print the plan and exit without changing anything
  --keep-local        Reuse the existing local clone if present (default)
  --fresh-local       Delete the local clone and re-clone from scratch
  --nuke-repo         Delete and recreate the GitHub repo before seeding
                      (the only way to wipe closed PRs). Requires the
                      'delete_repo' OAuth scope. Implies --fresh-local.
  --help, -h          Show this message

Safety: this script refuses to run against any repo whose description
does not match the canonical demo description, or whose owner isn't the
signed-in gh user. It also refuses dangerous --clone-dir values (drive
root, homedir) and will not wipe a clone dir whose origin doesn't point
at --repo.

Auto-merge: each seeded PR includes a GitHub Actions workflow with a
required 'ci' check that runs for ~2 minutes (an explicit sleep) so the
demo can show the full "Merge when ready" → auto-merge flow live,
end-to-end. Reseed right before the demo to reset the clock. The repo
is configured with allow_auto_merge=true and main is protected to
require the check, so the app's merge button renders as "Merge when
ready" until the presenter clicks it; ~2 minutes later the PR
auto-merges on its own.
`;
	process.stdout.write(help);
	process.exit(code);
}

// ---------------------------------------------------------------------------
// Shell helpers. Everything goes through execFileSync so args are never
// interpreted by a shell — important because some PR bodies contain
// backticks, dashes, and spaces that would break a pipe-through-cmd path.
// ---------------------------------------------------------------------------

interface RunOptions {
	cwd?: string;
	allowFail?: boolean;
	silent?: boolean;
	env?: NodeJS.ProcessEnv;
	input?: string;
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
	if (!opts.silent) {
		const cwd = opts.cwd ? ` (in ${opts.cwd})` : "";
		console.log(`$ ${cmd} ${args.join(" ")}${cwd}`);
	}
	const result = spawnSync(cmd, args, {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		input: opts.input,
		encoding: "utf8",
	});
	const status = result.status ?? -1;
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (status !== 0 && !opts.allowFail) {
		console.error(stderr || stdout);
		throw new Error(`${cmd} ${args.join(" ")} exited ${status}`);
	}
	return { status, stdout, stderr };
}

function runGit(args: string[], cwd: string, opts: RunOptions = {}): RunResult {
	return run("git", args, { ...opts, cwd });
}

function runGh(args: string[], opts: RunOptions = {}): RunResult {
	return run("gh", args, opts);
}

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

function which(tool: string): string | null {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, [tool], { encoding: "utf8" });
	if (result.status !== 0) return null;
	return result.stdout.split(/\r?\n/)[0].trim() || null;
}

function preflight(): { ghLogin: string } {
	if (!which("git")) {
		console.error("git not found on PATH. Install git first.");
		process.exit(1);
	}
	if (!which("gh")) {
		console.error(
			"gh (GitHub CLI) not found on PATH. Install from https://cli.github.com/.",
		);
		process.exit(1);
	}
	const auth = run("gh", ["auth", "status"], {
		silent: true,
		allowFail: true,
	});
	if (auth.status !== 0) {
		console.error(
			"gh CLI is not authenticated. Run `gh auth login` first, then re-run this script.",
		);
		console.error(auth.stderr);
		process.exit(1);
	}
	const userJson = run("gh", ["api", "user", "--jq", ".login"], {
		silent: true,
	});
	const ghLogin = userJson.stdout.trim();
	if (!ghLogin) {
		console.error("Could not determine signed-in gh login.");
		process.exit(1);
	}
	return { ghLogin };
}

/**
 * --nuke-repo requires the `delete_repo` OAuth scope. The keyring-stored
 * token typically only has `repo, read:org, gist, workflow` by default;
 * `delete_repo` must be added explicitly with `gh auth refresh`. Detect
 * this before doing anything destructive so the script fails fast with
 * a clear, actionable message.
 */
function checkDeleteRepoScope(): void {
	const auth = run("gh", ["auth", "status"], {
		silent: true,
		allowFail: true,
	});
	const blob = `${auth.stdout}\n${auth.stderr}`.toLowerCase();
	if (!blob.includes("delete_repo")) {
		console.error(
			"--nuke-repo requires the 'delete_repo' OAuth scope on the active gh token.",
		);
		console.error("Add it with:");
		console.error("  gh auth refresh -h github.com -s delete_repo");
		console.error("Then re-run this script.");
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Confirmation prompt.
// ---------------------------------------------------------------------------

async function confirm(args: Args, ghLogin: string): Promise<boolean> {
	if (args.yes || args.dryRun) return true;
	console.log("");
	console.log("This will perform the following DESTRUCTIVE actions:");
	if (args.nukeRepo) {
		console.log(
			`  • DELETE and RECREATE ${args.repo} (wipes closed PRs and issues)`,
		);
		console.log(`  • re-clone into ${args.cloneDir}`);
	} else {
		console.log(`  • close every open issue and PR in ${args.repo}`);
		console.log(`  • delete every non-main branch on ${args.repo}`);
		console.log(`  • force-push a fresh single-commit history to main`);
	}
	console.log(`  • re-create ${LABELS.length} labels`);
	console.log(`  • open ${BRANCHES.length} PRs and ${ISSUES.length} issues`);
	console.log(
		`  • enable allow_auto_merge and protect main (require '${REQUIRED_CHECK_NAME}' check)`,
	);
	console.log(`  • signed in as: ${ghLogin}`);
	console.log(`  • local clone:  ${args.cloneDir}`);
	console.log("");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ans = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
	rl.close();
	return ans === "y" || ans === "yes";
}

// ---------------------------------------------------------------------------
// Remote repo lifecycle.
// ---------------------------------------------------------------------------

function repoExists(repo: string): boolean {
	const result = run("gh", ["repo", "view", repo, "--json", "name"], {
		silent: true,
		allowFail: true,
	});
	return result.status === 0;
}

function ensureRepo(repo: string): void {
	if (repoExists(repo)) {
		console.log(`Repo ${repo} already exists. Will reset its state.`);
		return;
	}
	console.log(`Creating ${repo}...`);
	runGh([
		"repo",
		"create",
		repo,
		"--public",
		"--description",
		REPO_DESCRIPTION,
	]);
}

/**
 * Flip the repo-level `allow_auto_merge` setting on. This is the first of
 * the two gates GitHub requires for the `enablePullRequestAutoMerge`
 * GraphQL mutation to succeed (the other being a deferred merge gate on
 * the base branch — see `applyMainBranchProtection` below).
 *
 * Idempotent: PATCHing the same value is a no-op.
 */
function enableAutoMergeAtRepo(repo: string): void {
	console.log(`Enabling auto-merge on ${repo}...`);
	runGh(
		[
			"api",
			"-X",
			"PATCH",
			`repos/${repo}`,
			"-F",
			"allow_auto_merge=true",
		],
		{ silent: true },
	);
}

/**
 * Drop the branch protection rule on `main` if one exists.
 *
 * Why: on a non-nuke reseed, the previous run already applied protection
 * with `enforce_admins: true` + required `ci` check. Even with
 * `allow_force_pushes: true`, GitHub rejects the seed script's force-push
 * because the new orphan commit has no `ci` status. The cleanest fix is
 * to drop the rule first, force-push, and re-apply it at the end.
 *
 * Idempotent: returns 404 (silently ignored) when no rule is set, e.g. on
 * a fresh `--nuke-repo` run.
 */
function removeMainBranchProtectionIfPresent(repo: string): void {
	const result = runGh(
		["api", "-X", "DELETE", `repos/${repo}/branches/main/protection`],
		{ silent: true, allowFail: true },
	);
	if (result.status === 0) {
		console.log(`Removed existing branch protection on ${repo}#main.`);
	}
}

/**
 * Apply branch protection on `main` requiring the `ci` status check.
 * Combined with `enableAutoMergeAtRepo`, this is what makes the app's
 * merge button render as "Merge when ready" on each seeded PR instead of
 * just "Ready to merge" — there's now a deferred gate (the CI check) that
 * keeps direct merge unavailable until the check passes.
 *
 * Settings:
 *   - `required_status_checks.contexts: ["ci"]` — the gate.
 *   - `enforce_admins: true`             — without this, admins (the
 *     signed-in user) would bypass the gate and the button would still
 *     read "Ready to merge". Auto-merge only shows when direct merge is
 *     blocked.
 *   - `allow_force_pushes: true`          — so the seed script itself can
 *     force-push main on subsequent reseeds without --nuke-repo.
 *   - `allow_deletions: false`            — guards main from accidental
 *     branch deletion via `git push origin --delete main`.
 *
 * Idempotent: PUT replaces the existing rule with the same one.
 *
 * NOTE: called LAST in main(), after all seed-time pushes are done, so
 * the script's own force-push of `main` in resetMainToStartState happens
 * before protection takes effect. (On a fresh --nuke-repo run, there's
 * no protection yet anyway because the whole repo is brand new.)
 */
function applyMainBranchProtection(repo: string): void {
	console.log(
		`Applying branch protection on ${repo}#main (requires '${REQUIRED_CHECK_NAME}' check)...`,
	);
	const body = JSON.stringify({
		required_status_checks: {
			strict: false,
			contexts: [REQUIRED_CHECK_NAME],
		},
		enforce_admins: true,
		required_pull_request_reviews: null,
		restrictions: null,
		allow_force_pushes: true,
		allow_deletions: false,
	});
	runGh(
		[
			"api",
			"-X",
			"PUT",
			`repos/${repo}/branches/main/protection`,
			"--input",
			"-",
		],
		{ silent: true, input: body },
	);
}

/**
 * If the desktop app has already cloned the demo repo into its
 * `~/.copilot/repos/<repo-name>` cache, that clone is now stale: it points
 * at the previous `main`, which after `--nuke-repo` has been rewritten or
 * never had `package.json`. The app's run-script auto-detection reads
 * `package.json` from this clone (not the worktree), so without a refresh
 * the Run button stays empty.
 *
 * This function does a best-effort fetch + hard-reset of `main` in that
 * clone. It silently no-ops when:
 *   - the clone directory doesn't exist (project not added to app yet),
 *   - it isn't a git repo (someone put a stray folder there),
 *   - its origin doesn't point at this repo (unrelated repo with same name).
 *
 * The user still needs to reload the project in the app (or restart) to
 * pick up the new `package.json`; we just make sure the file is on disk.
 */
function refreshAppLocalClone(repo: string): void {
	const repoName = repo.split("/").pop() ?? "";
	if (!repoName) return;
	const cloneDir = path.join(os.homedir(), ".copilot", "repos", repoName);
	if (!existsSync(path.join(cloneDir, ".git"))) return;

	const remote = runGit(["remote", "get-url", "origin"], cloneDir, {
		silent: true,
		allowFail: true,
	});
	if (remote.status !== 0 || !remote.stdout.trim().includes(repo)) return;

	console.log(`Refreshing app's local clone at ${cloneDir}...`);
	const fetched = runGit(["fetch", "origin", "--prune"], cloneDir, {
		silent: true,
		allowFail: true,
	});
	if (fetched.status !== 0) {
		console.log(`  (fetch failed — skipping refresh)`);
		return;
	}
	runGit(["checkout", "main"], cloneDir, { silent: true, allowFail: true });
	runGit(["reset", "--hard", "origin/main"], cloneDir, {
		silent: true,
		allowFail: true,
	});
}

/**
 * Delete the repo if it exists. Used by --nuke-repo, where the goal is to
 * remove every closed PR/issue (GitHub's API can't delete PRs individually,
 * so the only path is to delete the whole repo and rebuild it).
 */
function deleteRepoIfExists(repo: string): void {
	if (!repoExists(repo)) {
		console.log(`Repo ${repo} does not exist — nothing to delete.`);
		return;
	}
	console.log(`Deleting repo ${repo}...`);
	runGh(["repo", "delete", repo, "--yes"]);
}

/**
 * Fingerprint guardrail. The seed script is destructive (force-pushes main,
 * closes/deletes PRs, optionally deletes the whole repo). To make it safe to
 * run with --yes against the canonical demo repo, refuse to proceed unless
 * the target repo *looks like* the demo repo: its description matches the
 * canonical string set on creation, and its owner matches the signed-in user.
 *
 * With --nuke-repo (allowMissing=false), the repo must already exist — a
 * missing repo is almost certainly a typo on --repo.
 *
 * Without --nuke-repo (allowMissing=true), a missing repo is OK because
 * ensureRepo() will create it; the fingerprint check then runs against the
 * fresh, empty repo, which trivially passes once it exists.
 */
function checkRepoFingerprint(
	repo: string,
	ghLogin: string,
	allowMissing: boolean,
): void {
	if (!repoExists(repo)) {
		if (allowMissing) {
			return;
		}
		console.error(`--nuke-repo target ${repo} does not exist.`);
		console.error(
			"Drop --nuke-repo if you meant to seed a fresh repo, or fix the",
		);
		console.error("--repo value if you mistyped it.");
		process.exit(1);
	}
	const meta = runGh(
		[
			"repo",
			"view",
			repo,
			"--json",
			"description,stargazerCount,forkCount,owner,isFork",
		],
		{ silent: true },
	);
	interface RepoMeta {
		description: string | null;
		stargazerCount: number;
		forkCount: number;
		owner: { login: string };
		isFork: boolean;
	}
	const m = JSON.parse(meta.stdout) as RepoMeta;
	const ownerOk = m.owner.login.toLowerCase() === ghLogin.toLowerCase();
	const descOk = (m.description ?? "") === REPO_DESCRIPTION;
	if (!ownerOk || !descOk) {
		console.error(
			`Refusing destructive seed against ${repo}: it does not look like the demo repo.`,
		);
		if (!ownerOk) {
			console.error(
				`  owner is ${m.owner.login}, but signed-in gh user is ${ghLogin}.`,
			);
		}
		if (!descOk) {
			console.error("  description mismatch:");
			console.error(`    expected: "${REPO_DESCRIPTION}"`);
			console.error(`    actual:   "${m.description ?? "(none)"}"`);
			console.error(
				`  if this really is the demo repo, restore its description with:`,
			);
			console.error(`    gh repo edit ${repo} -d "${REPO_DESCRIPTION}"`);
		}
		process.exit(1);
	}
	if (m.isFork) {
		console.log(
			`Note: ${repo} is a fork — seeding will not affect the upstream.`,
		);
	}
	if (m.stargazerCount > 0 || m.forkCount > 0) {
		console.log(
			`Note: ${repo} has ${m.stargazerCount} star(s) and ${m.forkCount} fork(s).`,
		);
	}
}

/**
 * Refuse to use a dangerous --clone-dir. The script wipes this directory
 * with `rmSync(recursive: true)` whenever --fresh-local or --nuke-repo is
 * set, so a typo like `--clone-dir C:\` or `--clone-dir ~` would be
 * catastrophic.
 *
 * - Refuses drive roots, the user's homedir itself, and very short paths.
 * - If the directory exists and will be wiped, requires it to be a git
 *   repo whose `origin` URL contains the target repo's OWNER/NAME, so
 *   the script never deletes an unrelated git checkout.
 */
function assertLocalCloneSafe(
	cloneDir: string,
	repo: string,
	willWipe: boolean,
): void {
	if (!cloneDir || cloneDir.trim().length === 0) {
		console.error("--clone-dir must be a non-empty path.");
		process.exit(1);
	}
	const resolved = path.resolve(cloneDir);
	const homeResolved = path.resolve(os.homedir());
	const driveRoot = path.parse(resolved).root;
	if (
		resolved.length < 5 ||
		resolved === homeResolved ||
		resolved === driveRoot
	) {
		console.error(
			`Refusing to use ${resolved} as --clone-dir: too dangerous (drive root, homedir, or trivially short path).`,
		);
		process.exit(1);
	}
	if (!willWipe) return;
	if (!existsSync(cloneDir)) return;
	const dotGit = path.join(cloneDir, ".git");
	if (!existsSync(dotGit)) {
		console.error(
			`Refusing to wipe ${resolved}: it exists but isn't a git repo. Move it aside first.`,
		);
		process.exit(1);
	}
	const remote = run(
		"git",
		["-C", cloneDir, "remote", "get-url", "origin"],
		{ silent: true, allowFail: true },
	);
	const url = remote.stdout.trim();
	if (remote.status !== 0 || !url.includes(repo)) {
		console.error(
			`Refusing to wipe ${resolved}: origin is "${url || "(none)"}", expected to contain "${repo}".`,
		);
		process.exit(1);
	}
}

function closeAllOpenIssuesAndPrs(repo: string): void {
	const prList = runGh(
		["pr", "list", "--repo", repo, "--state", "open", "--json", "number"],
		{ silent: true },
	);
	const prNumbers: number[] = JSON.parse(prList.stdout || "[]").map(
		(p: { number: number }) => p.number,
	);
	for (const n of prNumbers) {
		runGh(["pr", "close", String(n), "--repo", repo, "--delete-branch=false"]);
	}
	const issueList = runGh(
		["issue", "list", "--repo", repo, "--state", "open", "--json", "number"],
		{ silent: true },
	);
	const issueNumbers: number[] = JSON.parse(issueList.stdout || "[]").map(
		(p: { number: number }) => p.number,
	);
	for (const n of issueNumbers) {
		runGh(["issue", "close", String(n), "--repo", repo]);
	}
}

// ---------------------------------------------------------------------------
// Local clone management.
// ---------------------------------------------------------------------------

function ensureClone(
	repo: string,
	cloneDir: string,
	freshLocal: boolean,
): void {
	const wantUrl = `https://github.com/${repo}.git`;
	if (existsSync(cloneDir)) {
		if (freshLocal) {
			console.log(`Removing existing clone at ${cloneDir} (--fresh-local)...`);
			rmSync(cloneDir, { recursive: true, force: true });
		} else {
			const git = path.join(cloneDir, ".git");
			if (existsSync(git)) {
				const remote = runGit(["remote", "get-url", "origin"], cloneDir, {
					silent: true,
					allowFail: true,
				});
				if (remote.status === 0 && remote.stdout.trim().includes(repo)) {
					console.log(`Reusing existing clone at ${cloneDir}.`);
					return;
				}
			}
			console.log(
				`Existing path ${cloneDir} is not a clone of ${repo}; removing.`,
			);
			rmSync(cloneDir, { recursive: true, force: true });
		}
	}
	mkdirSync(path.dirname(cloneDir), { recursive: true });
	console.log(`Cloning ${repo} into ${cloneDir}...`);
	run("git", ["clone", wantUrl, cloneDir]);
}

function resetMainToStartState(cloneDir: string): void {
	// Fetch everything so we know the real list of remote branches.
	runGit(["fetch", "origin", "--prune"], cloneDir);

	// Build a fresh single-commit history on a detached temp branch, then
	// force-push it as main. This wipes any earlier commits cleanly.
	const tmpBranch = "seed/tmp-main";
	// Remove tmp branch if it lingers from a previous interrupted run.
	runGit(["branch", "-D", tmpBranch], cloneDir, {
		silent: true,
		allowFail: true,
	});

	// Use a fresh orphan branch so the previous main history is dropped.
	runGit(["checkout", "--orphan", tmpBranch], cloneDir);
	// Clear the index/working tree but DON'T delete the .git directory.
	runGit(["rm", "-rf", "--cached", "."], cloneDir, {
		silent: true,
		allowFail: true,
	});
	wipeWorkingTree(cloneDir);
	writeFilesAt(cloneDir, MAIN_FILES);
	runGit(["add", "."], cloneDir);
	runGit(["commit", "-m", "Initial site: Astro Coffee landing page"], cloneDir);
	// Replace local main with the new orphan history, then force-push.
	runGit(["branch", "-M", tmpBranch, "main"], cloneDir);
	runGit(["push", "origin", "main", "--force"], cloneDir);
}

function deleteAllRemoteBranchesExceptMain(cloneDir: string): void {
	const lsRemote = runGit(["ls-remote", "--heads", "origin"], cloneDir, {
		silent: true,
	});
	for (const line of lsRemote.stdout.split(/\r?\n/).filter(Boolean)) {
		const refMatch = line.match(/refs\/heads\/(.+)$/);
		if (!refMatch) continue;
		const branch = refMatch[1];
		if (branch === "main") continue;
		console.log(`Deleting remote branch ${branch}...`);
		runGit(["push", "origin", "--delete", branch], cloneDir, {
			allowFail: true,
		});
	}
	// Step off whatever branch is currently checked out so the `branch -D`
	// loop below can delete it. Prefer main if it exists locally; otherwise
	// detach HEAD so no branch is current.
	const switchedToMain = runGit(["checkout", "main"], cloneDir, {
		silent: true,
		allowFail: true,
	});
	if (switchedToMain.status !== 0) {
		runGit(["checkout", "--detach", "HEAD"], cloneDir, {
			silent: true,
			allowFail: true,
		});
	}
	// Also delete any local feat/* tracking branches so re-creation is clean.
	const localBranches = runGit(
		["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
		cloneDir,
		{ silent: true },
	);
	for (const b of localBranches.stdout.split(/\r?\n/).filter(Boolean)) {
		if (b === "main") continue;
		runGit(["branch", "-D", b], cloneDir, { silent: true, allowFail: true });
	}
}

// ---------------------------------------------------------------------------
// Labels.
// ---------------------------------------------------------------------------

function ensureLabels(repo: string): void {
	for (const label of LABELS) {
		runGh([
			"label",
			"create",
			label.name,
			"--repo",
			repo,
			"--color",
			label.color,
			"--description",
			label.description,
			"--force",
		]);
	}
}

// ---------------------------------------------------------------------------
// Branch + PR creation.
// ---------------------------------------------------------------------------

/**
 * Best-effort request for a GitHub Copilot code review on a freshly-created
 * PR. The reviewer slug `copilot-pull-request-reviewer` is the bot account
 * GitHub Copilot uses to leave review comments. If the repo isn't enrolled
 * in Copilot code review, the API call returns 422 — we swallow that and
 * print a hint so the presenter can assign it manually in the UI before
 * recording.
 */
function requestCopilotReview(repo: string, prUrl: string): void {
	const match = prUrl.match(/\/pull\/(\d+)/);
	if (!match) return;
	const prNumber = match[1];
	const body = JSON.stringify({
		reviewers: ["copilot-pull-request-reviewer"],
	});
	const result = runGh(
		[
			"api",
			"-X",
			"POST",
			`repos/${repo}/pulls/${prNumber}/requested_reviewers`,
			"--input",
			"-",
		],
		{ silent: true, allowFail: true, input: body },
	);
	if (result.status === 0) {
		console.log(`  Requested Copilot code review on PR #${prNumber}.`);
	} else {
		console.log(
			`  (Copilot review request skipped for PR #${prNumber} — assign 'Copilot' in the PR UI before recording.)`,
		);
	}
}

function createBranchesAndPrs(repo: string, cloneDir: string): string[] {
	const urls: string[] = [];
	for (const spec of BRANCHES) {
		console.log(`\nCreating branch ${spec.branch}...`);
		runGit(["checkout", "main"], cloneDir);
		runGit(["pull", "--ff-only", "origin", "main"], cloneDir);
		runGit(["checkout", "-b", spec.branch], cloneDir);
		for (const f of spec.files) {
			writeFileAt(cloneDir, f);
		}
		if (spec.removes) {
			for (const rel of spec.removes) {
				runGit(["rm", "-f", rel], cloneDir, {
					silent: true,
					allowFail: true,
				});
			}
		}
		runGit(["add", "."], cloneDir);
		runGit(["commit", "-m", spec.commitMessage], cloneDir);
		runGit(["push", "-u", "origin", spec.branch], cloneDir);
		const labelArgs = spec.labels.flatMap((l) => ["--label", l]);
		const pr = runGh([
			"pr",
			"create",
			"--repo",
			repo,
			"--title",
			spec.prTitle,
			"--body",
			spec.prBody,
			"--head",
			spec.branch,
			"--base",
			"main",
			...labelArgs,
		]);
		const url = pr.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
		urls.push(url);
		requestCopilotReview(repo, url);
	}
	runGit(["checkout", "main"], cloneDir);
	return urls;
}

// ---------------------------------------------------------------------------
// Issue creation.
// ---------------------------------------------------------------------------

function createIssues(repo: string, assignee: string): string[] {
	const urls: string[] = [];
	for (const issue of ISSUES) {
		const labelArgs = issue.labels.flatMap((l) => ["--label", l]);
		const result = runGh([
			"issue",
			"create",
			"--repo",
			repo,
			"--title",
			issue.title,
			"--body",
			issue.body,
			"--assignee",
			assignee,
			...labelArgs,
		]);
		const url = result.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
		urls.push(url);
	}
	return urls;
}

// ---------------------------------------------------------------------------
// FS helpers.
// ---------------------------------------------------------------------------

function writeFileAt(root: string, spec: FileSpec): void {
	const full = path.join(root, spec.relPath);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, spec.content, "utf8");
}

function writeFilesAt(root: string, specs: FileSpec[]): void {
	for (const s of specs) writeFileAt(root, s);
}

/**
 * Wipe the working tree EXCEPT the `.git/` directory. Used right after
 * `git checkout --orphan` so the new initial commit isn't polluted by
 * leftover files from the previous branch.
 */
function wipeWorkingTree(root: string): void {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === ".git") continue;
		rmSync(path.join(root, entry), { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const { ghLogin } = preflight();
	if (args.nukeRepo) {
		checkDeleteRepoScope();
	}
	// Hard guardrails: refuse to run destructively against anything that
	// doesn't fingerprint as the demo repo, or against a dangerous clone dir.
	// These run before confirm() so the user sees them even with --yes.
	checkRepoFingerprint(args.repo, ghLogin, /* allowMissing */ !args.nukeRepo);
	const willWipeClone = args.freshLocal || args.nukeRepo;
	assertLocalCloneSafe(args.cloneDir, args.repo, willWipeClone);

	if (args.dryRun) {
		console.log("DRY RUN — no changes will be made.");
	}

	const ok = await confirm(args, ghLogin);
	if (!ok) {
		console.log("Aborted.");
		process.exit(1);
	}

	if (args.dryRun) {
		console.log("\nPlan:");
		if (args.nukeRepo) {
			console.log(`  delete repo ${args.repo} (if it exists)`);
			console.log(`  recreate ${args.repo} as a fresh empty repo`);
			console.log(`  re-clone into ${args.cloneDir}`);
		} else {
			console.log(`  ensure repo ${args.repo} exists`);
			console.log(`  close every open issue/PR`);
			console.log(`  clone or reuse ${args.cloneDir}`);
			console.log(`  reset main, delete all non-main branches`);
		}
		console.log(`  enable allow_auto_merge on ${args.repo}`);
		console.log(`  create labels: ${LABELS.map((l) => l.name).join(", ")}`);
		for (const b of BRANCHES) {
			console.log(`  create PR: ${b.prTitle}  (head=${b.branch})`);
		}
		console.log(
			`  request Copilot code review on each PR (best-effort; warn-only)`,
		);
		for (const i of ISSUES) {
			console.log(`  create issue: ${i.title}  (assignee=${ghLogin})`);
		}
		console.log(
			`  apply branch protection on main (require '${REQUIRED_CHECK_NAME}' check)`,
		);
		return;
	}

	if (args.nukeRepo) {
		deleteRepoIfExists(args.repo);
		ensureRepo(args.repo);
	} else {
		ensureRepo(args.repo);
		closeAllOpenIssuesAndPrs(args.repo);
	}
	// Flip the repo-level auto-merge gate on early. Idempotent and safe to
	// run before main exists; the second gate (branch protection) is applied
	// at the end of seeding once main and the PR branches have been pushed.
	enableAutoMergeAtRepo(args.repo);
	// --nuke-repo always re-clones: the previous clone's origin now points
	// at a freshly created repo with no commits, so reusing it produces
	// confusing fetch failures.
	const freshLocal = args.freshLocal || args.nukeRepo;
	ensureClone(args.repo, args.cloneDir, freshLocal);
	// Configure committer identity if missing (matters on a fresh clone).
	ensureGitIdentity(args.cloneDir, ghLogin);
	deleteAllRemoteBranchesExceptMain(args.cloneDir);
	// Drop any existing branch protection BEFORE the force-push. Otherwise
	// a prior run's `enforce_admins + required ci check` rule rejects the
	// fresh orphan commit (which has no `ci` status yet). Re-applied at the
	// end of seeding.
	removeMainBranchProtectionIfPresent(args.repo);
	resetMainToStartState(args.cloneDir);
	ensureLabels(args.repo);
	const prUrls = createBranchesAndPrs(args.repo, args.cloneDir);
	const issueUrls = createIssues(args.repo, ghLogin);
	// Apply branch protection last, after all seed-time pushes are done.
	// This makes main require the `ci` check before merge, which is what
	// turns the app's merge button into "Merge when ready".
	applyMainBranchProtection(args.repo);

	refreshAppLocalClone(args.repo);

	console.log("\n✓ Demo repo seeded.");
	console.log("\nPRs:");
	for (const u of prUrls) console.log(`  ${u}`);
	console.log("\nIssues:");
	for (const u of issueUrls) console.log(`  ${u}`);
	console.log("");
	console.log(`Auto-merge: enabled. Each PR runs a ~2-minute 'ci' check;`);
	console.log(
		`click "Merge when ready" within ~90s — the PR auto-merges live.`,
	);
	console.log("");
	console.log(`Next steps:`);
	console.log(
		`  1. In the app: + → Add project from → GitHub repository… → ${args.repo}`,
	);
	console.log(
		`  2. Right-click the project → Settings → toggle Auto-start issue sessions ON`,
	);
	console.log(
		`  3. Assign 'Copilot' as a reviewer on each PR (Reviewers dropdown in the PR sidebar — the API can't do this on personal repos):`,
	);
	for (const u of prUrls) console.log(`       ${u}`);
	console.log(`  4. Follow docs/demo-script.md from "Setup before recording".`);
}

function ensureGitIdentity(cloneDir: string, ghLogin: string): void {
	const nameResult = runGit(["config", "user.name"], cloneDir, {
		silent: true,
		allowFail: true,
	});
	if (!nameResult.stdout.trim()) {
		runGit(["config", "user.name", ghLogin], cloneDir);
	}
	const emailResult = runGit(["config", "user.email"], cloneDir, {
		silent: true,
		allowFail: true,
	});
	if (!emailResult.stdout.trim()) {
		runGit(
			["config", "user.email", `${ghLogin}@users.noreply.github.com`],
			cloneDir,
		);
	}
}

main().catch((err) => {
	console.error("\n✗ seed-demo-repo failed:");
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
