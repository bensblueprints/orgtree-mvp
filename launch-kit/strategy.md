# Launch Strategy — Orgtree

## Positioning
"Pay once. Own it forever. No subscription." Target small-to-mid-size companies, HR/ops folks, and consultants who need an org chart occasionally and resent an ongoing SaaS bill for it. Named competitor: **Pingboard ($99/mo)**; secondary: Org Chart Now, ChartHop, Lucidchart org-chart templates.

## Target communities

| Community | Angle (rules-aware) |
|---|---|
| r/humanresources | "What finally worked for me" post about building an org chart without a monthly HRIS add-on; mention the tool in comments per self-promo norms. |
| r/sysadmin / r/ITManagers | IT/ops teams maintain org charts for onboarding and access reviews; "local-first, no cloud" angle resonates with this audience specifically. |
| r/smallbusiness | Cost-conscious owners actively compare tools; lead with the Pingboard math ("$1,188/yr vs $19 once"). |
| r/selfhosted | "Local-first" and MIT source resonate even though it's a desktop app — no cloud, no account. Post as Show-off Saturday if required. |
| r/opensource + r/SideProject | Straight "I built this" posts are welcome; lead with the MIT repo, not the paid installer. |
| Hacker News | Show HN (draft below) — HN likes homegrown layout algorithms and dislikes SaaS pricing for simple tools. |

## Show HN draft

**Title:** Show HN: Orgtree – a local-first desktop org chart builder you buy once

**Body:**
I got quoted $99/month for Pingboard to draw an org chart for a client. So I built Orgtree — an Electron desktop app where the whole roster lives in one JSON file under your user folder. No account, no telemetry, no network calls.

The interesting part is the layout engine: I didn't want a d3-hierarchy dependency, so it's a small recursive algorithm that computes subtree widths bottom-up and places children left-to-right, same core idea any tree-layout library uses. There's also a cycle detector for messy imported org data (A reports to B who reports to A) that's guaranteed to terminate — capped walk length instead of naive recursion — and CSV import that reports unresolved manager references as errors instead of silently dropping people.

Source is MIT on GitHub. There's a $19 packaged installer for people who don't want to `npm i`, which is the business model: pay once, own it forever.

## SEO keywords (10)
1. org chart software no subscription
2. pingboard alternative
3. one time purchase org chart
4. org chart maker desktop
5. free org chart tool download
6. company hierarchy chart software
7. org chart builder windows
8. local org chart app
9. open source org chart tool
10. org chart with department colors

## AppSumo / PitchGround pitch

Orgtree is the anti-subscription org chart builder: a polished, dark-mode desktop app with a genuinely capable auto-layout engine (built without d3-hierarchy), department color-coding, collapsible branches, drill-down views, and CSV bulk import/export with real error reporting — with every byte of data stored locally in a file the user owns. The org-chart category prints recurring SaaS revenue ($99+/mo) on a feature set that's fundamentally a tree-drawing tool, which makes a lifetime deal irresistible to your audience: they instantly understand "Pingboard costs $1,188/year; this is $19 once." MIT-licensed source doubles as trust and community moat. Zero infrastructure cost per user means deep discount headroom for a launch campaign.

## Pricing math

- **Price: $19 one-time** (launch: $12)
- Pingboard: $99/mo → Orgtree **pays for itself in under 6 days**
- 1-year Pingboard: $1,188 (62x Orgtree) · 3-year: $3,564 (187x Orgtree)
- Anchor line for all copy: "Cheaper than 6 days of Pingboard. Yours for life."
