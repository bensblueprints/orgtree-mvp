# Product Hunt Launch — Orgtree

## Name
Orgtree

## Tagline (60 chars)
The org chart builder you buy once and own forever.

## Description (260 chars)
Orgtree is a local-first desktop org chart builder: auto-layout tree, department color-coding, collapsible branches, drill-down views, search, PNG export, and CSV import/export. $19 once instead of $99/month forever. Your reporting lines are not a subscription.

## Full description

Orgtree is a desktop org chart builder for teams (and consultants, and HR folks) tired of paying enterprise SaaS prices to draw boxes and lines.

**Why another org chart tool?** Because Pingboard, the category leader, is $99/month — for a tree diagram with photos. Orgtree is $19 once, MIT-licensed, and everything lives in a single human-readable JSON file on your machine.

**What's actually in it:**
- Add people with name, title, department, email, and a manager dropdown — deleting someone reassigns their reports up the chain instead of orphaning a team
- A recursive auto-layout engine built from scratch (no d3-hierarchy): subtree widths computed bottom-up, children placed left-to-right, clean connector lines
- Collapsible branches for large orgs — click a manager's badge to fold their team away
- Stable, automatic department color-coding, with a legend
- Three views: full tree, department-filtered, and single-branch drill-down
- Search a name and Orgtree expands the path, clears any filter in the way, highlights the node, and scrolls it into view
- One-click PNG export of exactly what's on screen
- CSV bulk import/export with real error reporting — an unresolved manager name shows up as an error, it doesn't just vanish your data
- A cycle detector that catches broken reporting chains (A reports to B reports to A) without ever hanging the app

No account. No telemetry. No network calls. Pay once. Own it forever.

## Maker first comment

Hey PH 👋

I built Orgtree because I needed to sketch out a reporting structure for a client and got quoted $99/month for Pingboard — for what is, functionally, a tree diagram. I don't need a monthly bill to draw boxes and lines a few times a year.

So I built the tool I wanted: fully local, one JSON file I control, and a layout engine I wrote myself instead of pulling in d3-hierarchy — it computes subtree widths bottom-up and lays children out left-to-right, same idea any org chart tool uses, just without the dependency or the subscription.

The part I actually enjoyed building was the cycle detector — org data from a CSV export is never clean, and someone always ends up reporting to someone who reports to them. Orgtree catches that without hanging, and falls back to treating the broken link as a root instead of losing the person.

$19 once. That's it. Source is MIT on GitHub if you want to see how the layout math works.

## Gallery shots (5)

1. **Hero — full org tree**: dark UI, a 20+ person tree with color-coded departments, connector lines, a few collapsed branches with +/− badges. Caption: "Your whole org, laid out automatically."
2. **Drill-down view**: a single VP's branch as the new root, breadcrumb-style "Full tree" button visible top bar. Caption: "Click into any branch — instant sub-org view."
3. **Department filter**: the same tree pruned down to just Engineering, legend sidebar showing color key. Caption: "Filter to one department in one click."
4. **Search highlight**: a name typed into the search box, one node glowing gold mid-tree, chart auto-scrolled to center it. Caption: "Find anyone in a 200-person org instantly."
5. **CSV import result modal**: summary showing "48 people imported" with 2 flagged row issues listed. Caption: "Bulk-load your existing roster — errors reported, never silently dropped."
