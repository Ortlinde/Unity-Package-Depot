// Scans the configured GitHub user for public repos carrying the scan topic,
// reads each repo's root package.json, and writes packages.json for the site.
// Run in CI with GITHUB_TOKEN set (GitHub Actions provides this automatically):
//
//   node scripts/build-catalog.mjs
//
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN || "";

// Package ids that must never appear in the catalog (e.g. the private template).
const EXCLUDE_IDS = new Set(["com.ortlinde.template"]);

function headers() {
    const h = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "unity-package-depot-build",
    };
    if (TOKEN) h.Authorization = "Bearer " + TOKEN;
    return h;
}

async function api(path) {
    const res = await fetch(API + path, { headers: headers() });
    if (!res.ok) {
        throw new Error("GitHub API " + res.status + " for " + path + ": " + (await res.text()));
    }
    return res.json();
}

function titleCase(s) {
    return String(s)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
}

async function loadConfig() {
    const raw = await readFile(join(ROOT, "config.json"), "utf8");
    return JSON.parse(raw);
}

async function searchRepos(handle, topic) {
    const q = encodeURIComponent(`user:${handle} topic:${topic}`);
    const items = [];
    for (let page = 1; ; page++) {
        const data = await api(`/search/repositories?q=${q}&per_page=100&page=${page}`);
        items.push(...(data.items || []));
        if (!data.items || data.items.length < 100) break;
    }
    return items;
}

async function readPackageJson(handle, repo, ref) {
    const data = await api(`/repos/${handle}/${repo}/contents/package.json?ref=${ref}`);
    const text = Buffer.from(data.content, "base64").toString("utf8");
    return JSON.parse(text);
}

function toEntry(handle, repoItem, pkg, scanTopic) {
    const repo = repoItem.name;
    const repoUrl = repoItem.html_url;
    const extraTopics = (repoItem.topics || []).filter((t) => t !== scanTopic);
    const version = pkg.version
        ? (/^v/i.test(pkg.version) ? pkg.version : "v" + pkg.version)
        : "";
    const entry = {
        id: pkg.name || repo,
        name: pkg.displayName || repo,
        desc: pkg.description || "",
        version,
        gitUrl: `https://github.com/${handle}/${repo}.git`,
        repo: repoUrl,
        docs: pkg.documentationUrl || repoUrl + "#readme",
        category: extraTopics.length ? titleCase(extraTopics[0]) : "Packages",
    };
    if (pkg.changelogUrl) entry.changelog = pkg.changelogUrl;
    return entry;
}

function stripTimestamp(s) {
    return s.replace(/"generatedAt":\s*"[^"]*"/, "");
}

async function main() {
    const config = await loadConfig();
    const handle = config.handle;
    const scanTopic = config.scanTopic || "unity-package";
    if (!handle) throw new Error("config.json is missing 'handle'.");

    const repos = await searchRepos(handle, scanTopic);
    const packages = [];
    for (const r of repos) {
        if (EXCLUDE_IDS.has(r.name)) continue;
        try {
            const pkg = await readPackageJson(handle, r.name, r.default_branch);
            if (EXCLUDE_IDS.has(pkg.name)) continue;
            packages.push(toEntry(handle, r, pkg, scanTopic));
        } catch (err) {
            console.warn(`Skipping ${r.name}: ${err.message}`);
        }
    }
    packages.sort((a, b) => a.id.localeCompare(b.id));

    const out = {
        meta: {
            generatedAt: new Date().toISOString(),
            count: packages.length,
            source: "github-actions",
        },
        packages,
    };
    const next = JSON.stringify(out, null, "\t") + "\n";
    const outPath = join(ROOT, "packages.json");
    const prev = await readFile(outPath, "utf8").catch(() => "");
    if (stripTimestamp(prev) === stripTimestamp(next)) {
        console.log("packages.json is already up to date.");
        return;
    }
    await writeFile(outPath, next, "utf8");
    console.log(`Wrote ${packages.length} package(s) to packages.json.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
