A custom Drupal module that pulls upcoming events from a Springshare
**LibCal** calendar and displays them as a Gantt\-style timeline: one row
per library location (plus an online\-events row), one column per
weekday, with each day's events stacked as full\-width bars in
start\-time order. Built for LSU Libraries.

![Drupal](https://img.shields.io/badge/Drupal-10.2%20%7C%2011-0678BE?logo=drupal&logoColor=white)
![PHP](https://img.shields.io/badge/PHP-8.1%2B-777BB4?logo=php&logoColor=white)
![License](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)

A custom Drupal module that pulls upcoming events from a Springshare
**LibCal** calendar and displays them as a Gantt\-style timeline: one row
per location, one column per weekday, with bars positioned by each
event's actual start/end time. Built for LSU Libraries.

On phones and other narrow screens it automatically swaps to a
vertical, day\-by\-day agenda list instead of a cramped grid — see
[Mobile behavior](#mobile-behavior).

| Desktop / tablet (grid) | Phone (agenda) |
| --- | --- |
| ![Desktop grid view showing three rooms and a week of sample events](images/example-desktop.png) | ![Mobile agenda view listing the same sample events day by day](images/example-mobile.png) |

*(Screenshots use placeholder sample data.)*

## Contents {#contents}

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Multiple calendars](#multiple-calendars)
- [How it works](#how-it-works)
- [Mobile behavior](#mobile-behavior)
- [Loading more days](#loading-more-days)
- [Building hours](#building-hours)
- [Customizing the look](#customizing-the-look)
- [Security notes](#security-notes)
- [Known limitations / roadmap](#known-limitations-roadmap)
- [Contributing](#contributing)
- [License](#license)

## Features {#features}

- Pulls events from one or more LibCal calendars via the Events API,
  authenticated server\-side with an OAuth2 client\-credentials flow — no
  credentials or tokens are ever exposed to the browser.
- Supports multiple independently\-configured calendars as switchable
  tabs above the chart (e.g. "Events" and "Library Displays") — picking
  a tab issues a fresh request for just that calendar's events; the row
  roster and building hours stay the same across tabs since those are
  location\-based, not calendar\-based. See [Multiple
  calendars](#multiple-calendars).
- Shows the next *N* weekdays (10 by default, Monday–Friday), computed in
  your site's configured timezone, with a "Show more weekdays" button to
  page forward without reloading the page.
- Groups events into a fixed set of rows by LibCal **campus ID** (not
  room\-level location text) — an "Online Event" row always first,
  followed by rows like "Main Library" and "Hill Memorial Library" in
  the order you configure them — with events belonging to an
  unconfigured campus excluded from the chart entirely rather than
  dumped into a catch\-all row. Room\-level location text still shows
  inside each event's bar. See [Configuration](#configuration).
- Detects online/virtual events using LibCal's own online\-meeting
  fields (Zoom/Teams/etc. integration), falling back to keyword
  matching against the location text for events set up without that
  integration.
- Events render as full\-width bars that stack vertically within a day
  cell (earliest start time on top) rather than being positioned by
  time\-of\-day, so short/overlapping events stay readable.
- Optionally shows each row's actual open/close times as small text
  captions bracketing that row's events every day ("Opens at 7:00 AM" /
  "Closes at 9:00 PM", switching to "Opened"/"Closed" once that moment
  has passed, or "Closed" all day) — always, not just on days that
  differ from the display window — sourced from LibCal's Hours module,
  with support for a different feed URL and/or location ID per row,
  since many LibCal sites bundle every building's hours into a single
  feed response. See [Building hours](#building-hours).
- Responsive by design: a day\-column grid (stacked in blocks of up to 5
  days wide, rather than growing endlessly sideways) on wider screens, a
  scrollable day\-by\-day agenda on phones — no horizontal scrolling or
  unreadably thin bars on mobile.
- Placeable block, so it drops into any region of any theme.
- Configurable calendars (with switchable tabs), display window,
  location rows, business hours, and cache lifetime from the Drupal
  admin UI — no code changes needed for routine tuning.
- Zero JavaScript dependencies (no charting library to keep patched).
- Fully themeable via CSS custom properties, plus a couple of plain CSS
  classes (`now_open`/`now_closed`/`past_date`) for styling
  time\-sensitive state — see [Customizing the look](#customizing-the-look).

## Requirements {#requirements}

- Drupal 10.2\+ or Drupal 11.
- PHP 8.1\+.
- A LibCal (Springshare) account with API access enabled, and an API
  application (client ID/secret) with read access to Events. See
  [Configuration](#configuration).

## Installation {#installation}

Pick whichever fits how your site is managed.

### Option A — Git submodule (recommended for most sites) {#option-a-git-submodule-recommended-for-most-sites}

From the root of your Drupal site's git repository:

```bash
git submodule add https://github.com/lsulibraries/libcal_gantt.git web/modules/custom/libcal_gantt
git commit -m "Add libcal_gantt module"
```

Anyone else cloning the site afterward needs to pull submodules too:

```bash
git clone --recurse-submodules <your-site-repo-url>
# or, after a normal clone:
git submodule update --init --recursive
```

To update to a newer version of the module later:

```bash
cd web/modules/custom/libcal_gantt
git pull origin main
cd -
git add web/modules/custom/libcal_gantt
git commit -m "Update libcal_gantt module"
```

### Option B — Composer (VCS repository) {#option-b-composer-vcs-repository}

If your site is Composer\-managed and you'd rather track this module as a
Composer dependency, add it as a VCS repository in your site's root
`composer.json`\:

```bash
composer config repositories.lsulibraries-libcal-gantt vcs https://github.com/lsulibraries/libcal_gantt
composer require lsulibraries/libcal_gantt:dev-main
```

This module's own `composer.json` declares `"type": "drupal-custom-module"`,
so it installs into `web/modules/custom/libcal_gantt` automatically as
long as your site still has the default `drupal/recommended-project`
installer\-paths mapping for that type. If you're not sure, check your
root `composer.json` for an `extra.installer-paths` entry like:

```json
"web/modules/custom/{$name}": ["type:drupal-custom-module"]
```

### Option C — Plain clone (quick, no version tracking) {#option-c-plain-clone-quick-no-version-tracking}

```bash
git clone https://github.com/lsulibraries/libcal_gantt.git web/modules/custom/libcal_gantt
rm -rf web/modules/custom/libcal_gantt/.git
```

Simplest option, but the module's own git history isn't tracked from
your site repo — fine for a quick local test, not recommended long\-term.

### Enable it {#enable-it}

```bash
drush en libcal_gantt -y
drush cr
```

## Configuration {#configuration}

Go to **Admin \> Configuration \> Web services \> LibCal Gantt Timeline**
(`/admin/config/services/libcal-gantt`) and fill in:

- **LibCal host** — e.g. `https://yourlibrary.libcal.com`.
- **Client ID / Client secret** — from LibCal Admin \> API \> API
  Authentication \> *Create New Application*. Grant it read access to
  Events. *(Confirm the exact `/events` parameters against your own
  instance's live API reference under that same tab before going live —
  see [Known limitations](#known-limitations-roadmap).)*
- **Calendars** — one `calendar ID[,ID...]|Tab label` line per calendar,
  from Admin \> Calendars, e.g. `8030|Events` and
  `16219|Library Displays`. Each line becomes its own switchable tab
  above the chart, in the order listed — the first line is shown by
  default. A single line means no tabs are shown at all (same as the
  old single "Calendar ID(s)" field). See [Multiple
  calendars](#multiple-calendars).
- Display window, business hours, and timezone as desired.
- **Location rows** — one `campus ID|Row label` line per row you want on
  the chart, e.g. `261|Main Library`. The campus ID is LibCal's
  `campus.id` on each event (visible in a raw API response, or in Admin
  \> Calendars) — not the room/location ID. Only events belonging to a
  listed campus, or detected as online, appear on the chart at all; save
  this field first — it's what controls which per\-row Hours fields
  appear next.
- **Online events row label** and **Online location keywords
  (fallback)** — label for the always\-first online\-events row, and an
  optional comma\-separated keyword fallback for online events that
  don't use LibCal's own online\-meeting integration.
- **Hours feed URL** *(optional)*, plus a **Hours feed URL** and
  **Location ID (lid)** field for each row configured above — to show
  open/close captions on the chart. See [Building
  hours](#building-hours) for how to generate these from your LibCal
  instance.

## Usage {#usage}

Place the **"LibCal Events Gantt Chart"** block (Admin \> Structure \>
Block layout) into a region of your theme. That's it — the block fetches
and renders the timeline client\-side.

## Multiple calendars {#multiple-calendars}

The **Calendars** field on the settings form (see
[Configuration](#configuration)) can list more than one calendar, one
per line: `<calendar ID>[,<calendar ID>...]|<tab label>`, e.g.

```
8030|Events
16219|Library Displays
```

With two or more lines configured, a row of tab\-styled buttons appears
above the chart (shared by both the desktop grid and the mobile agenda —
it's the same tab strip either way) — clicking one switches to that
calendar's events. Behind the scenes this is a normal request to the
same `/libcal-gantt/events` endpoint with a `?calendar=<id>` parameter
added (the id being that line's first calendar ID); the server resolves
it against the configured list, defaulting to the first line if the
parameter is missing, unrecognized, or the field only has one line. Only
the selected calendar's events are ever fetched — switching tabs is a
fresh request, not a client\-side filter over data that was already
downloaded for every tab up front.

Switching tabs resets the day range back to the first page — whatever
"Show more" progress the previous tab had is discarded, since a
different calendar is a different view rather than a continuation of
the same one (see [Loading more days](#loading-more-days)). Location
rows and building hours are unaffected by which tab is active — both are
tied to physical locations (campus ID / Hours feed lid), not to a
specific calendar, so the row roster and `now_open`/`now_closed` status
stay identical across tabs; only the events shown for each row change.

A single configured line (the field's own default) shows no tabs at all
— there's nothing to switch between — and behaves exactly like the old
single "Calendar ID(s)" field used to (multiple comma\-separated IDs on
one line still merge together into a single combined view, tabs or no
tabs).

## How it works {#how-it-works}

- **`LibCalClient`** (a service) is the only thing that ever talks to
  LibCal. It requests an OAuth2 client\-credentials token from
  `{host}/1.1/oauth/token`, caches it until shortly before it expires,
  then `getUpcomingEvents(array $calendarIds, ...)` calls
  `{host}/1.1/events?cal_id=...&date=...&days=...` for each ID in the
  given set and caches the merged result per set. Which calendar's IDs
  to fetch is the caller's decision, not something this service reads
  from a single site\-wide config value — see [Multiple
  calendars](#multiple-calendars). It also fetches Hours widget feed
  URLs (`getHours()`, independent of OAuth — see [Building
  hours](#building-hours)), and exposes two shared static helpers so the
  controller and settings form agree on parsing without duplicating it:
  `parseCampusRows()` (for "Location rows") and `parseCalendars()` (for
  "Calendars"). The client secret and access token never leave the
  server.
- **`GanttEventsController`** exposes `GET /libcal-gantt/events`, a
  public JSON endpoint. It resolves which configured calendar to serve
  from an optional `?calendar=<id>` parameter (defaulting to the first
  configured one — see [Multiple calendars](#multiple-calendars)), works
  out "the next *N* weekdays" in the site's configured timezone (or the
  *N* weekdays after that, if the front end also passes `?offset=10` —
  see [Loading more days](#loading-more-days)), asks `LibCalClient` for
  events across that window for just the selected calendar's IDs, and
  assigns each event to a row — a configured campus ID's label, the
  online\-events row (`isOnlineEvent()`, checking LibCal's own
  online\-meeting fields first and a keyword fallback second), or
  excluded entirely if neither matches. The JSON response always
  includes the full, ordered row roster (`rows`) and the full list of
  configured calendars (`calendars`, plus which one was actually served
  as `calendar`), even for rows/calendars not currently in view. If any
  row (or the site\-wide default) has a Hours feed URL configured, it
  also fetches and parses building hours per row for the same days
  (`prepareAllHours()` — see [Building hours](#building-hours)), keyed
  by row label, independent of which calendar tab is selected.
- **`GanttChartBlock`** is a block you place in a region of your theme.
  It just renders an empty `<div id="libcal-gantt-chart">` and attaches
  the `gantt-timeline` library — no server\-rendered event data, so the
  block itself stays cheap and cacheable.
- **`js/gantt-timeline.js`** fetches `/libcal-gantt/events` client\-side
  and builds two views from the same data: the day\-column grid, and a
  vertical day\-by\-day agenda. When more than one calendar is
  configured, it also renders a tab strip above both views
  (`calendars`/`calendar` from the response) and re\-fetches from
  scratch when a different tab is clicked — see [Multiple
  calendars](#multiple-calendars). Rows come from the server's fixed
  `rows` roster, not discovered from event data. Within each day cell,
  events render as full\-width bars stacked vertically in start\-time
  order, and (when hours data is present) opening/closing captions
  bracket them. Because the controller already did the timezone/hour
  math, the JS never parses dates itself.
- **`css/gantt-timeline.css`** styles both views using CSS custom
  properties (`--libcal-gantt-bar-bg`, `--libcal-gantt-header-bg`, etc.)
  so your theme can override the look without touching this file.

## Mobile behavior {#mobile-behavior}

A wide multi\-day grid doesn't work on a phone — shrinking it just makes
the bars too thin to read or tap. So the module renders two views from
the same data and lets CSS decide which one shows:

- **≥ 769px wide** — the day\-column grid, at most 5 day\-columns per
  block (see [Loading more days](#loading-more-days)). If the block
  width (or a narrow window) makes the columns wider than the screen,
  the chart scrolls horizontally with the location labels pinned in
  place (`position: sticky; left: 0`) so the row labels are never lost
  mid\-scroll.
- **≤ 768px wide** — a vertical, day\-by\-day agenda instead: each weekday
  is its own section with its events listed as time \+ title \+ location,
  each a full\-width, thumb\-sized tap target (44px minimum height, per
  common touch\-target guidance). No horizontal scrolling at all. The
  same `now_open`/`now_closed` and `past_date` classes described in
  [Customizing the look](#customizing-the-look) apply here too, on the
  per\-row hours line and the day section respectively.

The breakpoint is a plain CSS media query (`@media (max-width: 768px)`
in `css/gantt-timeline.css`), so it responds instantly to
rotation/resize with no JavaScript re\-render. Adjust the `768px` value
there if your theme's own breakpoints differ.

## Loading more days {#loading-more-days}

A "Show *N* more weekdays" button appears below the chart. Clicking it
requests `/libcal-gantt/events?offset=<days already shown>` — the
controller skips that many weekdays from today and returns the next page
— and the new days/events are merged into what's already on screen
(both the grid and the agenda), rather than replacing them.

On the desktop/tablet grid, each page renders as its own block that is
at most 5 day\-columns wide, with a repeated day\-header row at the top
of the block and the row\-label column carried down beside it. Clicking
"Show more" stacks a new block underneath the existing one(s) — the
table grows *taller*, not wider, no matter how many pages are loaded. If
a page comes back with fewer days than the block width (e.g. a short
final page), the remaining cells in that block are rendered as empty,
transparent placeholder cells so every block stays aligned to the same
5\-column grid rather than drifting via CSS Grid's normal auto\-flow
behavior. Change the block width by editing `GRID_DAYS_PER_ROW` near the
top of `js/gantt-timeline.js`.

There's no built\-in limit on how many times "Show more" can be clicked,
so a long session can stack many blocks; if you want to cap it (e.g.
after 4 clicks), that's a small change in `buildMoreButton()` /
`loadPage()` in `js/gantt-timeline.js`.

## Building hours {#building-hours}

The chart can show each row's open/close times as small italic text
captions bracketing that row's events on the grid — "Opens 7:00 AM"
above the day's events, "Closes 9:00 PM" below them, or a "Closed" band
filling the day — plus a text line per row in the mobile agenda. These
show the location's actual scheduled hours for every day that has hours
data, regardless of how they compare to the configured display window
("Day starts at" / "Day ends at" on the settings form) — a location
that's open the entire window still shows both its real opening and
closing time, it isn't hidden just because there's nothing unusual about
that day.

**Tense follows the clock.** For today's column, a caption is phrased in
the future tense until that moment actually passes, then switches to the
past tense — "Opens at 7:00 AM" becomes "Opened at 7:00 AM" once 7:00 AM
has gone by, and "Closes at 9:00 PM" becomes "Closed at 9:00 PM" once
9:00 PM has gone by. Any day before today always reads in the past tense
("Opened"/"Closed"); any day after today always reads in the future
tense ("Opens"/"Closes"). This comparison uses the viewing device's own
local clock — see the timezone note in [Known limitations](#known-limitations-roadmap).

This is optional and off by default (nothing renders until a feed URL is
set), and it deliberately does **not** reuse the OAuth setup above —
LibCal exposes location hours through a separate, *public* JSON feed
tied to the Hours module, not the authenticated Events REST API:

1. In your LibCal admin, go to **Hours \> Widgets \> Weekly Data**.
2. Pick the building/location from the dropdown there.
3. Set **\# Weeks to Show** high enough to comfortably cover the chart
   plus a few "Show more" clicks (e.g. `5`–`6`).
4. Choose **JSON** as the output format and click **Generate
   Code/Preview**.
5. Copy the generated URL.

**Important — confirmed against a real feed:** LibCal's Weekly Data
widget commonly bundles *every* configured building into ONE feed
response, not one URL per building — e.g.
`{"locations": [{"lid": 241, "name": "LSU Library", "weeks": [...]}, {"lid": 236, "name": "Hill Memorial Library", "weeks": [...]}, ...]}`.
Before assuming you need a separate URL per row, open the generated URL
in a browser and check for a top\-level `"locations"` array:

- **If you see one:** you likely only need to set the URL *once* —
  either as the site\-wide **Hours feed URL (default)**, or the same
  URL repeated in each row's own **Hours feed URL** field — and instead
  set each row's **Location ID (lid)** field to that building's `lid`
  from the `locations` array (matched by `name`). This is what tells
  otherwise\-identical rows apart; without it, every row sharing that
  feed URL would get whichever location's data the parser happens to
  reach first, not necessarily the right one.
- **If you don't** (the response is a single location's data with no
  `locations` wrapper): leave every row's **Location ID (lid)** blank,
  and give each row its own **Hours feed URL** only if that building
  truly has a separate URL.

Because Springshare hasn't published one fixed schema for this feed
across versions/institutions, `GanttEventsController` parses it
defensively:

- **`scopeHoursToLocation()`** narrows a multi\-location response down
  to one row's `lid` (see above), falling back to the whole payload when
  no lid is configured or none matches.
- **`collectHoursNodes()`** walks that (possibly narrowed) JSON looking
  for any object with a `date` field matching a displayed day.
- **`parseHoursNode()`** reads that day's status/hours — checking a
  nested `times` sub\-object first (`times.status`, `times.hours[]` with
  `from`/`to`, e.g. `{"date": ..., "times": {"status": "open", "hours": [{"from": "7am", "to": "12am"}]}, "rendered": "7am - 12am"}` — the
  shape a real LSU feed uses), then falls back to those same fields
  directly on the day node for other Springshare widget
  versions/shapes. It also reads `rendered`/`hours_html` as a fallback
  text label. **A closing time of exactly midnight** (`"12am"`) is
  treated internally as hour 24 rather than hour 0 — needed so that when
  a day has more than one time slot (e.g. split hours), the slot that
  actually closes latest is the one picked as the day's closing time;
  it renders the same either way ("12:00 AM").

If your feed's field names differ from both of these, the three methods
above are the only places that need adjusting — fetch the URL once in a
browser to see your actual response shape (and check for the
`locations` wrapper described above first).

If parsing can't find structured open/close times but does find a text
label, the label still shows as a caption (e.g. "24 hours" or a holiday
note) — the "Opens"/"Closes" lines are the only part that depends on
structured times, and each simply doesn't render rather than guessing.

A row's current open/closed state (today, right now) also drives the
`now_open`/`now_closed` classes described in
[Customizing the look](#customizing-the-look).

## Customizing the look {#customizing-the-look}

The block markup is just
`<div id="libcal-gantt-chart" class="libcal-gantt-chart">`. Add your own
CSS in the theme (after the module's library, or with a
`libraries-override`) targeting `.libcal-gantt-chart` and its custom
properties, e.g.:

```css
.libcal-gantt-chart {
  --libcal-gantt-bar-bg: #003057;
  --libcal-gantt-bar-color: #fff;
  --libcal-gantt-header-bg: #f4f4f4;
  --libcal-gantt-row-label-width: 180px;
}
```

### State classes {#state-classes}

A few plain classes (intentionally *not* namespaced with the module's
usual `libcal-gantt__` BEM prefix, so they read as generic state hooks
rather than structural ones) get added and removed as time passes,
recomputed on every render and on the local re\-render described in
[Known limitations](#known-limitations-roadmap)\:

- **`now_open`** / **`now_closed`** — added to `.libcal-gantt__row-header`
  on the desktop grid, and to `.libcal-gantt-agenda__hours` in the
  mobile agenda, based on that row's hours data for *today*. Not added
  at all if there's no hours data for that row/day. The default
  stylesheet renders this as a small green (`now_open`) or red
  (`now_closed`) dot after the label; override or replace it, e.g.:
  
  ```css
  .libcal-gantt__row-header.now_open::after {
    background: #2e8b47;
  }
  .libcal-gantt__row-header.now_closed::after {
    background: #a52121;
  }
  ```

- **`past_date`** — added to `.libcal-gantt__day-header` and
  `.libcal-gantt__day-cell` on the desktop grid, and to each day's
  `.libcal-gantt-agenda__day` section in the mobile agenda, once that
  day is earlier than today. The default stylesheet just dims it
  (`opacity: 0.55`); override it, e.g.:
  
  ```css
  .libcal-gantt__day-cell.past_date {
    opacity: 1;
    background: #f7f7f7;
  }
  ```

## Security notes {#security-notes}

- The client secret is stored in Drupal config (`libcal_gantt.settings`).
  That means it will be included in a config export unless you exclude
  it — **do not commit a config export containing a live client secret
  to this or any other git repository.** For production, consider
  swapping the `client_secret` field for the
  [Key module](https://www.drupal.org/project/key) — the settings form
  and `LibCalClient` are small enough that this is a quick change (read
  the secret from the Key service instead of
  `$config->get('client_secret')`).
- `/libcal-gantt/events` is intentionally public (`_access: TRUE`) since
  it only ever returns public event titles/times/locations that LibCal
  itself publishes — it never exposes the token or client secret.

## Known limitations / roadmap {#known-limitations-roadmap}

- The `/1.1/oauth/token` and `/1.1/events` endpoint paths and parameter
  names (`cal_id`, `date`, `days`, `limit`) are based on LibCal's
  long\-standing v1.1 REST API and cross\-checked against several
  independent open\-source LibCal integrations, but Springshare gates its
  full live API reference behind each institution's own LibCal admin
  (Admin \> API \> API Documentation). Confirm exact parameters there
  before relying on this in production — endpoint details can vary by
  plan/version.
- Rows are a fixed allowlist keyed by LibCal **campus ID**
  (`event.campus.id`), configured in "Location rows" — not discovered
  automatically. An event whose campus isn't listed there (and that
  isn't detected as online) is excluded from the chart entirely, so a
  newly\-added building/campus needs a matching row added before its
  events will show up.
- `config/install/*.yml` only seeds its defaults on a *fresh* module
  install, never retroactively on an already\-installed site. If you add
  or change a config key after the module is already enabled (this has
  bitten "Location rows", the online\-keyword fallback, and — most
  recently — the rename of the old single "Calendar ID(s)" field
  (`calendar_ids`) to the new multi\-line "Calendars" field
  (`calendars`) in the past), visit the settings form and click **Save**
  once to persist it into real config. For that specific rename: on an
  already\-installed site the "Calendars" field will show its built\-in
  default text (pre\-filled, not yet saved) until you open the settings
  form and click Save — until then the chart falls back to no calendars
  configured at all (an empty chart), not your old `calendar_ids` value.
- Multi\-day events are supported (a bar segment is computed for each day
  they touch), but very long\-running events (weeks) will still create
  one segment per weekday, which may be visually noisy — fine for
  typical library events, worth revisiting for multi\-week programs.
- No live network refresh: the block only re\-fetches events/hours from
  the server on a full page load, a "Show more" click, or a calendar tab
  switch — it does not poll. Separately, the browser locally re\-renders
  the already\-fetched data once a minute (`LIVE_REFRESH_INTERVAL_MS` in
  `gantt-timeline.js`), with no network request involved, purely so the
  Opens/Opened/Closes/Closed wording and the `now_open`/`now_closed`/
  `past_date` classes (see [Building hours](#building-hours) and
  [Customizing the look](#customizing-the-look)) stay accurate as
  midnight and open/close moments pass while a page stays open. It will
  *not* pick up new/changed/canceled events or updated hours without a
  reload — if you want that too, replace or supplement this interval
  with one that calls `loadPage`/re\-fetches. Raise
  `LIVE_REFRESH_INTERVAL_MS` or remove the `setInterval` call in
  `initChart()` if even a local re\-render every minute is more than you
  want on a given page.
- "Today", "past", and "currently open/closed" are all computed from the
  **viewing device's own local clock** (`new Date()` in the browser), not
  a server\-computed site timezone. That's fine for a desk/lobby display
  physically in the library, but if this block is ever embedded on a
  page viewed from another timezone, the Opens/Opened/Closes/Closed
  wording and the `now_open`/`now_closed`/`past_date` classes will
  reflect the *viewer's* clock, not the building's.
- The Hours feed parsing (see [Building hours](#building-hours)) is
  defensive by design because Springshare doesn't publish one fixed
  schema for it. It's been verified against a real LSU feed sample
  (including the multi\-location `locations`/`lid` bundling and the
  nested `times.status`/`times.hours[]` shape), but double\-check the
  captions look right once you've set real per\-row feed URLs/lids —
  other institutions' feeds may still differ.
- "Show more weekdays" has no built\-in cap on how many pages (or
  stacked 5\-day blocks — see [Loading more days](#loading-more-days))
  can be loaded — fine for normal browsing, but worth capping if this
  block will sit open unattended for a long time (e.g. a lobby display).
- The currently\-selected calendar tab isn't reflected in the page URL —
  it always starts on the first configured calendar after a full page
  reload, and there's no way to deep\-link directly to, say, the
  "Library Displays" tab. Add that if you need it (e.g. syncing
  `state.calendarId` in `gantt-timeline.js` with a URL hash or query
  parameter).

## Contributing {#contributing}

This module lives in the [LSU Libraries](https://github.com/lsulibraries)
GitHub org. Open an issue or pull request against this repo for bug
reports or changes. Please run `php -l` on any changed PHP files and a
quick manual check of both the grid and mobile agenda views before
submitting.

## License {#license}

[GPL\-2.0\-or\-later](LICENSE), matching Drupal core's license.